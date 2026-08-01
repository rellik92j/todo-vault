import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseFrontmatter, serializeFrontmatter } from "./markdown.js";
import {
  CADENCES,
  CreateItemInput,
  DONE_STATUSES,
  FRONTMATTER_ORDER,
  ITEM_KEY_RE,
  ItemFilter,
  ItemFrontmatterSchema,
  PROJECT_FRONTMATTER_ORDER,
  PROJECT_KEY_RE,
  ProjectSchema,
  TRANSITIONS,
  UpdateItemInput,
  UpdateProjectInput,
  type Cadence,
  type Item,
  type Project,
  type Status,
} from "./schema.js";
import {
  addDays,
  contentHash,
  endOfMonth,
  formatZodError,
  fromPosixPath,
  isSettledForWindow,
  nowIso,
  pathExists,
  randomUUID,
  RANK_GAP,
  rankBetween,
  startOfMonth,
  startOfWeek,
  todayIso,
  toPosixPath,
  writeFileAtomic,
} from "./util.js";

const execFileAsync = promisify(execFile);

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export interface VaultOptions {
  /** Auto-commit every write to git, giving you free undo and an audit trail. */
  git?: boolean;
}

interface Counters {
  [projectKey: string]: number;
}

export interface AgendaSection {
  /**
   * What the section is, kept separate from the window it covers. "due" is
   * dated work landing inside the window; "recurring" is cadence work that has
   * no date and simply comes round again. Interleaving the two reads as though
   * the recurring items were also due, which they are not.
   */
  kind: "overdue" | "due" | "recurring";
  scope: "today" | "week" | "nextWeek" | "month";
  from?: string;
  to?: string;
  items: Item[];
}

export interface DeleteResult {
  key: string;
  /** Where the markdown went, relative to the vault root. */
  trashedTo: string;
  /** Where the attachment folder went, if the item had one. */
  attachmentsTrashedTo?: string;
  /** Items that linked to this one and now have a dangling link. */
  danglingBacklinks: string[];
}

export interface DeleteProjectResult {
  key: string;
  trashedTo: string;
  /** Items trashed alongside it, each restorable on its own. */
  items: DeleteResult[];
}

export interface MoveProjectResult {
  /** Every key that changed, old to new. */
  rekeyed: Array<{ from: string; to: string }>;
  /** Set when the moved item's parent stayed behind and the link was dropped. */
  parentDropped?: string;
}

export interface TrashEntry {
  /** Filename inside .trash — pass this to restoreItem. */
  file: string;
  key: string;
  trashedAt: string;
  summary?: string;
  hasAttachments: boolean;
}

export interface GitStatus {
  /** Whether auto-commit was requested when the vault was opened. */
  enabled: boolean;
  gitAvailable: boolean;
  isRepo: boolean;
  /**
   * Root of the repo the vault sits in, which is not necessarily the vault
   * itself — a vault kept inside a larger notes repo commits into that one.
   */
  repoRoot?: string;
  /** True when that repo ignores the vault, so writes are committed nowhere. */
  ignored: boolean;
  lastCommit?: { hash: string; subject: string; at: string };
  /** Why the most recent auto-commit did not happen, if it didn't. */
  lastError?: string;
  /** True only if a write right now would actually be committed. */
  healthy: boolean;
}

export class Vault {
  readonly root: string;
  private readonly options: VaultOptions;
  private items = new Map<string, Item>();
  private projects = new Map<string, Project>();
  private loaded = false;
  private lastCommitError?: string;

  constructor(root: string, options: VaultOptions = {}) {
    this.root = path.resolve(root);
    this.options = options;
  }

  // ---------------------------------------------------------------- paths

  get itemsDir(): string {
    return path.join(this.root, "items");
  }

  get projectsDir(): string {
    return path.join(this.root, "projects");
  }

  get attachmentsDir(): string {
    return path.join(this.root, "attachments");
  }

  private get countersPath(): string {
    return path.join(this.root, ".counters.json");
  }

  itemPath(key: string): string {
    return path.join(this.itemsDir, `${key}.md`);
  }

  projectPath(key: string): string {
    return path.join(this.projectsDir, `${key}.md`);
  }

  attachmentDir(key: string): string {
    return path.join(this.attachmentsDir, key);
  }

  get trashDir(): string {
    return path.join(this.root, ".trash");
  }

  /**
   * Items and projects are trashed into separate folders. A project trashed
   * alongside items would produce `.trash/ACME-2026-07-25T...md`, which reads as
   * item key "ACME-2026" to anything parsing those filenames.
   */
  get itemTrashDir(): string {
    return path.join(this.trashDir, "items");
  }

  get projectTrashDir(): string {
    return path.join(this.trashDir, "projects");
  }

  /**
   * Absolute path for a stored attachment. Accepts either separator, so
   * attachments written by an older build — or on another OS — still resolve.
   */
  resolveAttachment(storedPath: string): string {
    return path.resolve(this.root, fromPosixPath(toPosixPath(storedPath)));
  }

  // --------------------------------------------------------------- loading

  static async init(root: string, options: VaultOptions = {}): Promise<Vault> {
    const vault = new Vault(root, options);
    await fs.mkdir(vault.itemsDir, { recursive: true });
    await fs.mkdir(vault.projectsDir, { recursive: true });
    await fs.mkdir(vault.attachmentsDir, { recursive: true });
    if (!(await pathExists(vault.countersPath))) {
      await writeFileAtomic(vault.countersPath, "{}\n");
    }
    await vault.load();
    return vault;
  }

  static async open(root: string, options: VaultOptions = {}): Promise<Vault> {
    const vault = new Vault(root, options);
    if (!(await pathExists(vault.itemsDir))) {
      throw new VaultError(
        `No vault found at ${vault.root}. Run \`vault init\` there first, or point at a different directory.`,
      );
    }
    await vault.load();
    return vault;
  }

  /** Rebuilds the in-memory index from disk. Cheap enough to call on any file change. */
  async load(): Promise<{ items: number; projects: number; errors: string[] }> {
    const errors: string[] = [];
    this.items.clear();
    this.projects.clear();

    for (const [dir, isProject] of [
      [this.projectsDir, true],
      [this.itemsDir, false],
    ] as const) {
      let entries: string[] = [];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const filePath = path.join(dir, entry);
        try {
          const raw = await fs.readFile(filePath, "utf8");
          const { data, body } = parseFrontmatter(raw);
          if (isProject) {
            const parsed = ProjectSchema.parse(data);
            this.projects.set(parsed.key, { ...parsed, description: body });
          } else {
            const parsed = ItemFrontmatterSchema.parse(data);
            this.items.set(parsed.key, { ...parsed, description: body });
          }
        } catch (err) {
          errors.push(`${path.relative(this.root, filePath)}: ${formatZodError(err)}`);
        }
      }
    }

    this.loaded = true;
    return { items: this.items.size, projects: this.projects.size, errors };
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new VaultError("Vault not loaded. Call load() first.");
    }
  }

  // ------------------------------------------------------------- retrieval

  getItem(key: string): Item {
    this.assertLoaded();
    const item = this.items.get(key);
    if (!item) {
      const suggestion = this.nearestKey(key);
      throw new VaultError(
        `No item with key ${key}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
      );
    }
    return item;
  }

  hasItem(key: string): boolean {
    return this.items.has(key);
  }

  getProject(key: string): Project {
    this.assertLoaded();
    const project = this.projects.get(key);
    if (!project) {
      const known = [...this.projects.keys()].join(", ") || "none yet";
      throw new VaultError(`No project with key ${key}. Known projects: ${known}`);
    }
    return project;
  }

  /**
   * Projects in manual order where one has been set, alphabetical by key
   * otherwise. No sort option, because the fallback already covers both: a vault
   * where nothing has been dragged reads exactly as it did before ranks existed.
   */
  listProjects(): Project[] {
    this.assertLoaded();
    return [...this.projects.values()].sort(compareProjectsByRank);
  }

  private nearestKey(key: string): string | undefined {
    const prefix = key.split("-")[0];
    return [...this.items.keys()].find((k) => k.startsWith(prefix));
  }

  listItems(filterInput: Partial<ItemFilter> = {}): { total: number; items: Item[] } {
    this.assertLoaded();
    const filter = ItemFilter.parse(filterInput);
    const statuses = filter.status
      ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
      : undefined;
    const text = filter.text?.toLowerCase();
    /*
     * Folded once here rather than per item. Reporter matches case-insensitively
     * where assignee matches exactly, and the asymmetry is deliberate: reporter
     * names are typed free-hand into a suggestion menu that already folds
     * spellings of one person together (knownReporters), so a filter that did not
     * fold would contradict the menu offering it. Nothing offers assignee that way
     * yet, and loosening it would change what existing callers already match.
     */
    const reporter = filter.reporter?.trim().toLowerCase();

    const matched = [...this.items.values()].filter((item) => {
      if (filter.project && item.project !== filter.project) return false;
      if (filter.type && item.type !== filter.type) return false;
      if (statuses && !statuses.has(item.status)) return false;
      if (filter.priority && item.priority !== filter.priority) return false;
      if (filter.cadence && item.cadence !== filter.cadence) return false;
      if (filter.category && item.category !== filter.category) return false;
      if (filter.assignee && item.assignee !== filter.assignee) return false;
      if (reporter && item.reporter?.trim().toLowerCase() !== reporter) return false;
      if (filter.parent && item.parent !== filter.parent) return false;
      if (filter.label && !item.labels.includes(filter.label)) return false;
      if (filter.open && DONE_STATUSES.includes(item.status)) return false;
      if (filter.dueBefore && (!item.dueDate || item.dueDate > filter.dueBefore)) return false;
      if (filter.dueAfter && (!item.dueDate || item.dueDate < filter.dueAfter)) return false;
      if (text) {
        const haystack = [
          item.summary,
          item.description,
          item.category ?? "",
          item.labels.join(" "),
          item.reporter ?? "",
        ]
          .join("\n")
          .toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });

    matched.sort(filter.sort === "rank" ? compareByRank : sortByWorkOrder);
    return {
      total: matched.length,
      items: matched.slice(filter.offset, filter.offset + filter.limit),
    };
  }

  /** Direct children of an item — stories under an epic, subtasks under a task. */
  children(key: string): Item[] {
    this.assertLoaded();
    return [...this.items.values()].filter((i) => i.parent === key).sort(sortByWorkOrder);
  }

  /** Items that link to this one, so the UI can show backlinks. */
  backlinks(key: string): Item[] {
    this.assertLoaded();
    return [...this.items.values()].filter(
      (i) => i.key !== key && i.links.some((l) => l.type === "item" && l.target === key),
    );
  }

  agenda(
    scope: "today" | "week" | "nextWeek" | "month",
    reference = todayIso(),
  ): AgendaSection[] {
    this.assertLoaded();
    const open = [...this.items.values()].filter((i) => !DONE_STATUSES.includes(i.status));

    const overdue = open
      .filter((i) => i.dueDate && i.dueDate < reference)
      .sort(sortByWorkOrder);

    const ranges: Record<typeof scope, { from: string; to: string; cadences: Cadence[] }> = {
      today: { from: reference, to: reference, cadences: ["daily"] },
      week: {
        from: startOfWeek(reference),
        to: addDays(startOfWeek(reference), 6),
        cadences: ["daily", "weekly"],
      },
      nextWeek: {
        from: addDays(startOfWeek(reference), 7),
        to: addDays(startOfWeek(reference), 13),
        cadences: ["daily", "weekly"],
      },
      month: {
        from: startOfMonth(reference),
        to: endOfMonth(reference),
        cadences: ["daily", "weekly", "monthly"],
      },
    };

    const { from, to, cadences } = ranges[scope];

    // Each item lands in exactly one section, or the day's work gets
    // double-counted. Something due last Tuesday is inside this week's window
    // *and* overdue; overdue is the more useful framing, and it is listed first,
    // so it wins.
    const isOverdue = new Set(overdue.map((i) => i.key));
    const due = open
      .filter((i) => i.dueDate && i.dueDate >= from && i.dueDate <= to && !isOverdue.has(i.key))
      .sort(sortByWorkOrder);

    // A recurring item that also carries a due date belongs under "due" — that
    // is the one with a deadline attached.
    //
    // Ticked items drop out, but only once the tick covers the rest of the
    // window: see isSettledForWindow. Today's daily task still belongs in the
    // week's agenda, because it comes round again tomorrow.
    const alreadyListed = new Set([...overdue, ...due].map((i) => i.key));
    const recurring = open
      .filter(
        (i) =>
          cadences.includes(i.cadence) &&
          !alreadyListed.has(i.key) &&
          !isSettledForWindow(i, reference, to),
      )
      .sort(sortByWorkOrder);

    const sections: AgendaSection[] = [];
    if (overdue.length) {
      sections.push({ kind: "overdue", scope, to: reference, items: overdue });
    }
    sections.push({ kind: "due", scope, from, to, items: due });
    if (recurring.length) {
      sections.push({ kind: "recurring", scope, from, to, items: recurring });
    }
    return sections;
  }

  // --------------------------------------------------------------- writing

  /**
   * Validate, write, index, commit. Every item mutation goes through here.
   *
   * The validation is the point: writing an item that does not satisfy the
   * schema produces a file that throws on the next `load()`, so the item
   * silently disappears from every view and turns up in `load().errors`
   * instead. Cheaper to reject it here, where there is a caller to tell.
   */
  private async writeAndIndex(next: Item): Promise<Item> {
    const frontmatter = ItemFrontmatterSchema.parse(stripDescription(next));
    const item: Item = { ...frontmatter, description: next.description };
    await this.writeItem(item);
    this.items.set(item.key, item);
    return item;
  }

  private async persist(next: Item, message: string): Promise<Item> {
    const item = await this.writeAndIndex(next);
    await this.commit(message);
    return item;
  }

  private async writeAndIndexProject(next: Project): Promise<Project> {
    const frontmatter = ProjectSchema.parse(stripDescription({ ...next }));
    const project: Project = { ...frontmatter, description: next.description };
    await this.writeProject(project);
    this.projects.set(project.key, project);
    return project;
  }

  private async persistProject(next: Project, message: string): Promise<Project> {
    const project = await this.writeAndIndexProject(next);
    await this.commit(message);
    return project;
  }

  async createProject(input: {
    key: string;
    name: string;
    description?: string;
    category?: string;
    lead?: string;
    startDate?: string;
    dueDate?: string;
    jiraProjectKey?: string;
  }): Promise<Project> {
    this.assertLoaded();
    if (this.projects.has(input.key)) {
      throw new VaultError(`Project ${input.key} already exists`);
    }
    const now = nowIso();
    const frontmatter = ProjectSchema.parse({
      key: input.key,
      name: input.name,
      category: input.category,
      lead: input.lead,
      status: "active",
      startDate: input.startDate,
      dueDate: input.dueDate,
      jiraProjectKey: input.jiraProjectKey,
      created: now,
      updated: now,
    });
    return this.persistProject(
      { ...frontmatter, description: input.description ?? "" },
      `Add project ${frontmatter.key}`,
    );
  }

  async createItem(rawInput: unknown): Promise<Item> {
    this.assertLoaded();
    const input = CreateItemInput.parse(rawInput);

    if (!this.projects.has(input.project)) {
      const known = [...this.projects.keys()].join(", ") || "none yet";
      throw new VaultError(
        `Project ${input.project} does not exist. Create it first. Known projects: ${known}`,
      );
    }
    if (input.parent) this.assertParentValid(input.type, input.parent);

    const key = await this.allocateKey(input.project);
    const now = nowIso();

    // An item can be born in_progress — CreateItemInput takes any status and
    // there is no transition here to hang the rule on — so it gets the same
    // stamp updateItem would have given it.
    const status = input.status ?? "todo";

    const frontmatter = ItemFrontmatterSchema.parse({
      id: randomUUID(),
      key,
      project: input.project,
      type: input.type,
      summary: input.summary,
      status,
      priority: input.priority ?? "medium",
      parent: input.parent,
      category: input.category,
      labels: input.labels ?? [],
      components: input.components ?? [],
      assignee: input.assignee,
      reporter: input.reporter,
      startDate:
        status === "in_progress"
          ? startDateOnPickup(input.startDate, input.dueDate)
          : input.startDate,
      dueDate: input.dueDate,
      estimate: input.estimate,
      cadence: input.cadence ?? "none",
      links: (input.links ?? []).map((l) => ({ ...l, addedAt: l.addedAt ?? now })),
      attachments: [],
      comments: [],
      sync: { state: "never" },
      created: now,
      updated: now,
    });

    return this.persist(
      { ...frontmatter, description: input.description ?? "" },
      `Add ${key}: ${frontmatter.summary}`,
    );
  }

  async updateItem(key: string, rawPatch: unknown): Promise<Item> {
    const existing = this.getItem(key);
    const patch = UpdateItemInput.parse(rawPatch);

    if (patch.status && patch.status !== existing.status) {
      this.assertTransitionAllowed(existing.status, patch.status);
    }
    const nextType = patch.type ?? existing.type;
    const nextParent = patch.parent === undefined ? existing.parent : patch.parent ?? undefined;
    if (nextParent) this.assertParentValid(nextType, nextParent, key);

    const merged: Record<string, unknown> = { ...existing };
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (field === "description") continue;
      merged[field] = value === null ? undefined : value;
    }
    // Picking work up dates it. This sits here rather than in transition()
    // because vault_update_item and `vault set --status` both patch status
    // directly, and a rule one level up would silently skip them.
    if (patch.status === "in_progress" && existing.status !== "in_progress") {
      merged.startDate = startDateOnPickup(
        merged.startDate as string | undefined,
        merged.dueDate as string | undefined,
      );
    }
    merged.updated = nowIso();

    const description = patch.description ?? existing.description;
    const frontmatter = ItemFrontmatterSchema.parse(stripDescription(merged));
    const next: Item = { ...frontmatter, description };

    // If this item was already pushed, a content change means Jira is now stale.
    if (next.sync.state === "pushed" && next.sync.contentHash) {
      if (contentHash(pushableFields(next)) !== next.sync.contentHash) {
        next.sync = { ...next.sync, state: "drifted" };
      }
    }

    return this.persist(next, `Update ${key}`);
  }

  async transition(key: string, status: Status): Promise<Item> {
    return this.updateItem(key, { status });
  }

  /**
   * Record that a recurring item was done for the period containing `on`.
   *
   * Deliberately not a status change. `done` means "this item is finished and
   * should stop appearing", which is right when you abandon a habit and wrong
   * when you perform one — so a tick leaves `status` untouched and appends to
   * the item's own history instead. The agenda then hides the item until its
   * cadence comes round again (see `isSettledForWindow`).
   *
   * Idempotent: ticking twice on the same date is a no-op rather than an error,
   * because a double-click on the UI's ✓ should not be a failure state.
   *
   * The commit message names the completion rather than reusing `updateItem`'s
   * generic `Update ${key}`, so the history stays greppable even though the
   * frontmatter is already the authoritative record.
   */
  async tickItem(key: string, on: string = todayIso()): Promise<Item> {
    const existing = this.getItem(key);
    if (existing.cadence === "none") {
      throw new VaultError(
        `${key} has no cadence, so a tick has no period to apply to. Give it one ` +
          `(${CADENCES.filter((c) => c !== "none").join("|")}), or transition it to done instead.`,
      );
    }
    if (existing.completions.includes(on)) return existing;

    // Sorted so the file stays stable regardless of the order ticks arrive in —
    // backfilling a missed day should not reshuffle the whole list in the diff.
    const completions = [...existing.completions, on].sort();
    return this.persist(
      { ...existing, completions, updated: nowIso() },
      `Complete ${key} (${existing.cadence} ${on})`,
    );
  }

  /**
   * Remove one recorded completion. A ✓ with no undo is a trap, and a mis-tick
   * otherwise has to be fixed by hand-editing the file.
   *
   * Unlike `tickItem` this does not require a cadence: clearing an item's
   * cadence should not strand the completions it already accumulated.
   */
  async untickItem(key: string, on: string = todayIso()): Promise<Item> {
    const existing = this.getItem(key);
    if (!existing.completions.includes(on)) return existing;

    return this.persist(
      {
        ...existing,
        completions: existing.completions.filter((done) => done !== on),
        updated: nowIso(),
      },
      `Undo completion of ${key} (${on})`,
    );
  }

  async addComment(key: string, body: string, author = "me"): Promise<Item> {
    const existing = this.getItem(key);
    if (!body.trim()) {
      throw new VaultError("A comment needs a body");
    }
    return this.persist(
      {
        ...existing,
        comments: [...existing.comments, { author, at: nowIso(), body: body.trim() }],
        updated: nowIso(),
      },
      `Comment on ${key}`,
    );
  }

  async addLink(
    key: string,
    link: { type: string; target: string; label?: string },
  ): Promise<Item> {
    const existing = this.getItem(key);
    if (link.type === "item" && !this.items.has(link.target)) {
      throw new VaultError(`Cannot link to ${link.target} — no such item in this vault`);
    }
    const duplicate = existing.links.some(
      (l) => l.type === link.type && l.target === link.target,
    );
    if (duplicate) return existing;

    return this.persist(
      {
        ...existing,
        links: [...existing.links, { ...link, addedAt: nowIso() }] as Item["links"],
        updated: nowIso(),
      },
      `Link ${key} -> ${link.target}`,
    );
  }

  async removeLink(key: string, target: string): Promise<Item> {
    const existing = this.getItem(key);
    const links = existing.links.filter((l) => l.target !== target);
    if (links.length === existing.links.length) {
      throw new VaultError(`${key} has no link to ${target}`);
    }
    return this.persist({ ...existing, links, updated: nowIso() }, `Unlink ${key} -> ${target}`);
  }

  /**
   * Attach a file. `copy: true` brings it into the vault (good for small
   * documents you want versioned); `copy: false` records a pointer to where it
   * already lives (good for a 200MB video or a file on a network share).
   */
  async addAttachment(
    key: string,
    sourcePath: string,
    opts: { copy?: boolean; title?: string } = {},
  ): Promise<Item> {
    const existing = this.getItem(key);
    const copy = opts.copy ?? true;
    const absSource = path.resolve(sourcePath);

    let stat;
    try {
      stat = await fs.stat(absSource);
    } catch {
      throw new VaultError(`Cannot read ${absSource} — check the path exists`);
    }
    if (!stat.isFile()) {
      throw new VaultError(`${absSource} is not a file`);
    }

    if (!copy) {
      return this.addLink(key, {
        type: "file",
        target: absSource,
        label: opts.title ?? path.basename(absSource),
      });
    }

    const destDir = this.attachmentDir(key);
    await fs.mkdir(destDir, { recursive: true });
    const destPath = path.join(destDir, path.basename(absSource));
    await fs.copyFile(absSource, destPath);
    // Stored POSIX-style so the vault survives being opened on another OS.
    const relative = toPosixPath(path.relative(this.root, destPath));

    return this.persist(
      {
        ...existing,
        attachments: [
          ...existing.attachments.filter((a) => a.path !== relative),
          {
            path: relative,
            title: opts.title ?? path.basename(absSource),
            bytes: stat.size,
            addedAt: nowIso(),
          },
        ],
        updated: nowIso(),
      },
      `Attach ${path.basename(absSource)} to ${key}`,
    );
  }

  /** Records the outcome of a Jira push so drift detection has a baseline. */
  async markPushed(key: string, jiraKey: string, jiraId?: string): Promise<Item> {
    const existing = this.getItem(key);
    return this.persist(
      {
        ...existing,
        sync: {
          jiraKey,
          jiraId,
          lastPushedAt: nowIso(),
          contentHash: contentHash(pushableFields(existing)),
          state: "pushed",
        },
        updated: nowIso(),
      },
      `Mark ${key} pushed as ${jiraKey}`,
    );
  }

  // ------------------------------------------------------- manual ordering

  /**
   * Place an item manually: after one neighbour, before another, or between two
   * when a card is dropped in the middle of a column. Pass neither to send it to
   * the end of its project.
   *
   * `after` and `before` are list positions — the item after another has the
   * higher rank.
   */
  async moveItem(
    key: string,
    position: { after?: string; before?: string } = {},
  ): Promise<Item> {
    const item = this.getItem(key);
    if (position.after === key || position.before === key) {
      throw new VaultError(`Cannot position ${key} relative to itself`);
    }

    for (const k of [position.after, position.before]) {
      const neighbour = k ? this.getItem(k) : undefined;
      if (neighbour && neighbour.project !== item.project) {
        throw new VaultError(
          `${neighbour.key} is in ${neighbour.project}, not ${item.project} — ranks are per project`,
        );
      }
    }

    // Any unranked item in the project means it has never been ordered by hand.
    // Rank the lot first, so every position has real numbers on both sides.
    if ([...this.items.values()].some((i) => i.project === item.project && i.rank === undefined)) {
      await this.renumber(item.project);
    }

    /**
     * Resolve the pair of ranks the new one has to land between.
     *
     * The caller may name only one side. "before X" means *immediately* before
     * X, so the other bound is X's current predecessor — not an open end. An
     * open end would return X's rank halved, which collides with whatever
     * already sits there.
     */
    const bounds = (): { lower?: number; upper?: number } => {
      const column = [...this.items.values()]
        .filter((i) => i.project === item.project && i.key !== key)
        .sort(compareByRank);

      let above = position.after ? column.find((i) => i.key === position.after) : undefined;
      let below = position.before ? column.find((i) => i.key === position.before) : undefined;

      if (below && !above) {
        const at = column.indexOf(below);
        above = at > 0 ? column[at - 1] : undefined;
      } else if (above && !below) {
        const at = column.indexOf(above);
        below = at >= 0 && at + 1 < column.length ? column[at + 1] : undefined;
      } else if (!above && !below) {
        above = column[column.length - 1]; // no position given: send it to the end
      }

      return { lower: above?.rank, upper: below?.rank };
    };

    let { lower, upper } = bounds();
    let rank = rankBetween(lower, upper);

    if (rank === undefined) {
      // The gap closed. Respace and try once more, which always succeeds
      // because every gap is RANK_GAP wide again.
      await this.renumber(item.project);
      ({ lower, upper } = bounds());
      rank = rankBetween(lower, upper);
      if (rank === undefined) {
        throw new VaultError(
          `Could not find a rank between ${lower ?? "start"} and ${upper ?? "end"} even after renumbering`,
        );
      }
    }

    return this.persist({ ...this.getItem(key), rank, updated: nowIso() }, `Reorder ${key}`);
  }

  /**
   * Respace every rank in a project to multiples of RANK_GAP, preserving the
   * current order. One commit for the lot rather than one per item.
   */
  private async renumber(projectKey: string): Promise<void> {
    const ordered = [...this.items.values()]
      .filter((i) => i.project === projectKey)
      .sort(compareByRank);

    let rank = RANK_GAP;
    let changed = 0;
    for (const item of ordered) {
      if (item.rank !== rank) {
        await this.writeAndIndex({ ...item, rank, updated: nowIso() });
        changed += 1;
      }
      rank += RANK_GAP;
    }
    if (changed) await this.commit(`Respace ranks in ${projectKey}`);
  }

  // ----------------------------------------------------------------- trash

  /**
   * Move an item to `.trash/` instead of unlinking it.
   *
   * Recovery deliberately does not depend on git: the file is still on disk and
   * `restoreItem` puts it back, so undo works even when auto-commit is off or
   * the vault was never `git init`ed. Refuses to orphan children unless
   * `cascade` is set — a dangling parent is invisible in every view and only
   * surfaces when `doctor` runs.
   */
  async deleteItem(key: string, opts: { cascade?: boolean } = {}): Promise<DeleteResult[]> {
    const item = this.getItem(key);
    const below = this.descendants(key);

    if (below.length && !opts.cascade) {
      throw new VaultError(
        `${key} has ${below.length} item(s) beneath it: ${below.map((i) => i.key).join(", ")}. ` +
          `Re-parent them, delete them first, or pass cascade to trash the lot together.`,
      );
    }

    // Deepest first, so a partial failure never leaves a parent pointing at
    // something already gone.
    const doomed = [...below.reverse(), item];
    const results: DeleteResult[] = [];
    for (const target of doomed) {
      results.push(await this.trashOne(target));
    }

    await this.commit(
      doomed.length > 1 ? `Trash ${key} and ${doomed.length - 1} descendant(s)` : `Trash ${key}`,
    );
    return results;
  }

  /** Everything beneath an item, breadth-first. */
  descendants(key: string): Item[] {
    this.assertLoaded();
    const out: Item[] = [];
    const queue = [key];
    while (queue.length) {
      const current = queue.shift() as string;
      for (const child of this.children(current)) {
        out.push(child);
        queue.push(child.key);
      }
    }
    return out;
  }

  private async trashOne(item: Item): Promise<DeleteResult> {
    await fs.mkdir(this.itemTrashDir, { recursive: true });
    // Colons are illegal in Windows filenames, so the ISO stamp gets flattened.
    const stamp = nowIso().replace(/[:.]/g, "-");
    const danglingBacklinks = this.backlinks(item.key).map((i) => i.key);

    const trashName = `${item.key}-${stamp}.md`;
    await fs.rename(this.itemPath(item.key), path.join(this.itemTrashDir, trashName));

    let attachmentsTrashedTo: string | undefined;
    const attachDir = this.attachmentDir(item.key);
    if (await pathExists(attachDir)) {
      const dirName = `${item.key}-${stamp}-attachments`;
      await fs.rename(attachDir, path.join(this.itemTrashDir, dirName));
      attachmentsTrashedTo = `.trash/items/${dirName}`;
    }

    this.items.delete(item.key);

    return {
      key: item.key,
      trashedTo: `.trash/items/${trashName}`,
      attachmentsTrashedTo,
      danglingBacklinks,
    };
  }

  async listTrash(): Promise<TrashEntry[]> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.itemTrashDir);
    } catch {
      return [];
    }

    const out: TrashEntry[] = [];
    for (const file of entries) {
      if (!file.endsWith(".md")) continue;
      const match = /^([A-Z][A-Z0-9]{1,9}-\d+)-(.+)\.md$/.exec(file);
      if (!match) continue;

      let summary: string | undefined;
      try {
        const raw = await fs.readFile(path.join(this.itemTrashDir, file), "utf8");
        const { data } = parseFrontmatter(raw);
        const value = (data as { summary?: unknown }).summary;
        if (typeof value === "string") summary = value;
      } catch {
        // A trashed file that no longer parses is still listed, just unlabelled.
      }

      out.push({
        file,
        key: match[1],
        trashedAt: match[2],
        summary,
        hasAttachments: entries.includes(`${match[1]}-${match[2]}-attachments`),
      });
    }

    return out.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
  }

  /** Put a trashed item back where it came from. */
  async restoreItem(file: string): Promise<Item> {
    // `file` may arrive from the UI over IPC, so it never gets to name a path.
    if (file.includes("/") || file.includes("\\") || file.includes("..")) {
      throw new VaultError(`Expected a filename from listTrash(), got a path: ${file}`);
    }

    const source = path.join(this.itemTrashDir, file);
    let raw: string;
    try {
      raw = await fs.readFile(source, "utf8");
    } catch {
      throw new VaultError(`Nothing called ${file} in the trash`);
    }

    const { data, body } = parseFrontmatter(raw);
    let frontmatter;
    try {
      frontmatter = ItemFrontmatterSchema.parse(data);
    } catch (err) {
      throw new VaultError(`${file} no longer matches the schema: ${formatZodError(err)}`);
    }

    if (this.items.has(frontmatter.key)) {
      throw new VaultError(
        `${frontmatter.key} exists again — restoring would overwrite it. Rename the live one first.`,
      );
    }
    if (frontmatter.parent && !this.items.has(frontmatter.parent)) {
      throw new VaultError(
        `${frontmatter.key} hangs off ${frontmatter.parent}, which is not in the vault. Restore that first.`,
      );
    }

    await fs.rename(source, this.itemPath(frontmatter.key));

    const stamp = file.slice(frontmatter.key.length + 1, -3);
    const attachSource = path.join(this.itemTrashDir, `${frontmatter.key}-${stamp}-attachments`);
    if (await pathExists(attachSource)) {
      await fs.rename(attachSource, this.attachmentDir(frontmatter.key));
    }

    const item: Item = { ...frontmatter, description: body };
    this.items.set(item.key, item);
    await this.commit(`Restore ${item.key} from trash`);
    return item;
  }

  // -------------------------------------------------------------- projects

  async updateProject(key: string, rawPatch: unknown): Promise<Project> {
    const existing = this.getProject(key);
    const patch = UpdateProjectInput.parse(rawPatch);

    // `archived` is what hiding writes, and hiding refuses while the project
    // still holds live work. Left reachable here, that rule would hold on one
    // path and be bypassable from `vault project set` and vault_update_project,
    // which is the same as not having it. The value stays in the enum rather
    // than being dropped from it so this sentence is what a caller sees,
    // instead of zod's "Invalid enum value".
    if (patch.status === "archived") {
      throw new VaultError(
        `Setting status to 'archived' is how a project is hidden, and hiding refuses while ` +
          `the project still holds items that are not done or disregarded. Use hideProject ` +
          `(vault project hide ${key}, or vault_hide_project) so that check runs.`,
      );
    }

    const merged: Record<string, unknown> = { ...existing };
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (field === "description") continue;
      merged[field] = value === null ? undefined : value;
    }
    merged.updated = nowIso();

    return this.persistProject(
      { ...(merged as unknown as Project), description: patch.description ?? existing.description },
      `Update project ${key}`,
    );
  }

  /**
   * Take a project out of the desktop app's sidebar without trashing it.
   *
   * Encoded as `status: "archived"` — the one ProjectSchema value nothing else
   * in the codebase reads — so there is no new field, no migration, and the
   * state round-trips through the project tools the CLI and MCP server already
   * have. The desktop app is the only thing that acts on it; `listProjects`
   * stays unfiltered, because filtering there would make hidden projects vanish
   * from an external Claude's view of the vault as well, and hiding is a
   * decision about one window, not about the data.
   *
   * Refuses while the project still holds live work, and names it. Same
   * reasoning as deleteProject's refusal: hiding a project pulls its items out
   * of every view in the app, and open work that disappears silently is how a
   * commitment gets forgotten. Closed items — done or disregarded, both of them —
   * are precisely what you want out of sight, so they are no obstacle.
   */
  async hideProject(key: string): Promise<Project> {
    const project = this.getProject(key);
    if (project.status === "archived") return project;

    const open = [...this.items.values()]
      .filter((i) => i.project === key && !DONE_STATUSES.includes(i.status))
      // Numeric, or ACME-10 sorts above ACME-4 and the list reads as nonsense.
      .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));

    if (open.length) {
      // Capped, because the message is read in a terminal and in an MCP result,
      // and a project with two hundred open items would drown both.
      const named = open.slice(0, 10).map((i) => i.key).join(", ");
      const rest = open.length > 10 ? `, and ${open.length - 10} more` : "";
      throw new VaultError(
        `Project ${key} still has ${open.length} item(s) that are not done or disregarded: ` +
          `${named}${rest}. Close them, disregard them, or move them to another project first.`,
      );
    }

    return this.persistProject(
      { ...project, status: "archived", updated: nowIso() },
      `Hide project ${key}`,
    );
  }

  /**
   * Put a hidden project back in the sidebar. No preconditions — nothing about
   * being hidden can make unhiding the unsafe direction.
   *
   * It comes back `active` even if it was `on_hold` or `complete` before it was
   * hidden, because `status` is the only place that value lived and hiding
   * overwrote it. That is what "effectively reactivating" costs, and nothing in
   * the app sets either of those two today.
   */
  async unhideProject(key: string): Promise<Project> {
    const project = this.getProject(key);
    if (project.status !== "archived") return project;
    return this.persistProject(
      { ...project, status: "active", updated: nowIso() },
      `Unhide project ${key}`,
    );
  }

  /**
   * Reorder the project list by hand — the sidebar order, not the items inside.
   *
   * Same shape as moveItem: positions are list positions, and naming one side is
   * enough, because "before X" means immediately before X. Distinct from
   * moveItemsToProject, which moves work between projects.
   */
  async moveProject(
    key: string,
    position: { after?: string; before?: string } = {},
  ): Promise<Project> {
    const project = this.getProject(key);
    if (position.after === key || position.before === key) {
      throw new VaultError(`Cannot position ${key} relative to itself`);
    }
    for (const neighbour of [position.after, position.before]) {
      if (neighbour) this.getProject(neighbour);
    }

    if ([...this.projects.values()].some((p) => p.rank === undefined)) {
      await this.renumberProjects();
    }

    const bounds = (): { lower?: number; upper?: number } => {
      const list = [...this.projects.values()]
        .filter((p) => p.key !== key)
        .sort(compareProjectsByRank);

      let above = position.after ? list.find((p) => p.key === position.after) : undefined;
      let below = position.before ? list.find((p) => p.key === position.before) : undefined;

      if (below && !above) {
        const at = list.indexOf(below);
        above = at > 0 ? list[at - 1] : undefined;
      } else if (above && !below) {
        const at = list.indexOf(above);
        below = at >= 0 && at + 1 < list.length ? list[at + 1] : undefined;
      } else if (!above && !below) {
        above = list[list.length - 1]; // no position given: send it to the end
      }

      return { lower: above?.rank, upper: below?.rank };
    };

    let { lower, upper } = bounds();
    let rank = rankBetween(lower, upper);

    if (rank === undefined) {
      await this.renumberProjects();
      ({ lower, upper } = bounds());
      rank = rankBetween(lower, upper);
      if (rank === undefined) {
        throw new VaultError(
          `Could not find a rank between ${lower ?? "start"} and ${upper ?? "end"} even after renumbering`,
        );
      }
    }

    return this.persistProject(
      { ...this.getProject(key), rank, updated: nowIso() },
      `Reorder project ${key}`,
    );
  }

  /** Respace every project rank to multiples of RANK_GAP, preserving order. */
  private async renumberProjects(): Promise<void> {
    const ordered = [...this.projects.values()].sort(compareProjectsByRank);
    let rank = RANK_GAP;
    let changed = 0;
    for (const project of ordered) {
      if (project.rank !== rank) {
        await this.writeAndIndexProject({ ...project, rank, updated: nowIso() });
        changed += 1;
      }
      rank += RANK_GAP;
    }
    if (changed) await this.commit("Respace project ranks");
  }

  /**
   * Change a project's key, re-keying every item in it.
   *
   * This is the one operation that breaks the "keys are issued once" rule, so it
   * is deliberately explicit rather than a side effect of an update. Item numbers
   * are preserved — ACME-42 becomes NEW-42 — and every `id` stays put, so
   * identity survives even though the human-facing key does not. Anything
   * outside the vault that quoted the old key (an email, a Jira issue) will not
   * be updated; `sync.jiraKey` is left alone because that one is Jira's.
   */
  async renameProject(oldKey: string, newKey: string): Promise<Project> {
    const project = this.getProject(oldKey);
    if (oldKey === newKey) return project;
    if (!PROJECT_KEY_RE.test(newKey)) {
      throw new VaultError(`${newKey} is not a valid project key (2-10 uppercase letters/digits)`);
    }
    if (this.projects.has(newKey)) {
      throw new VaultError(`Project ${newKey} already exists`);
    }

    const mapping = new Map<string, string>();
    for (const item of this.items.values()) {
      if (item.project === oldKey) {
        mapping.set(item.key, `${newKey}-${item.key.split("-")[1]}`);
      }
    }
    await this.rekeyItems(mapping);

    const frontmatter = ProjectSchema.parse({
      ...stripDescription({ ...project }),
      key: newKey,
      updated: nowIso(),
    });
    const renamed: Project = { ...frontmatter, description: project.description };
    await this.writeProject(renamed);
    await fs.rm(this.projectPath(oldKey), { force: true });
    this.projects.delete(oldKey);
    this.projects.set(newKey, renamed);

    // Carry the high-water mark across, so numbers are never reissued under the
    // new key either.
    const counters = await this.readCounters();
    if (counters[oldKey] !== undefined) {
      counters[newKey] = Math.max(counters[newKey] ?? 0, counters[oldKey]);
      delete counters[oldKey];
      await this.writeCounters(counters);
    }

    await this.commit(`Rename project ${oldKey} to ${newKey}`);
    return renamed;
  }

  /**
   * Move an item, and everything beneath it, into another project.
   *
   * Jira calls this Move, and like Jira it issues fresh keys in the target: a
   * key belongs to a project, so ACME-5 cannot stay ACME-5 once it lives in OPS.
   * The subtree moves together, because an epic without its stories is rarely
   * what anyone means.
   */
  async moveItemsToProject(
    key: string,
    targetProject: string,
    opts: { parent?: string | null } = {},
  ): Promise<MoveProjectResult> {
    const item = this.getItem(key);
    if (!this.projects.has(targetProject)) {
      const known = [...this.projects.keys()].join(", ") || "none yet";
      throw new VaultError(`No project ${targetProject}. Known projects: ${known}`);
    }
    if (item.project === targetProject) {
      throw new VaultError(`${key} is already in ${targetProject}`);
    }

    const subtree = [item, ...this.descendants(key)];
    const inSubtree = new Set(subtree.map((i) => i.key));

    // The root's parent stays behind in the old project, which would leave a
    // cross-project parent link. Decide what happens to it before writing.
    const leavingParent = item.parent && !inSubtree.has(item.parent);
    let finalParent: string | undefined;

    if (opts.parent) {
      const candidate = this.getItem(opts.parent);
      if (candidate.project !== targetProject) {
        throw new VaultError(
          `Parent ${opts.parent} is in ${candidate.project}, not ${targetProject}`,
        );
      }
      if (inSubtree.has(opts.parent)) {
        throw new VaultError(`${opts.parent} is inside the subtree being moved`);
      }
      this.assertParentValid(item.type, opts.parent, key);
      finalParent = opts.parent;
    } else if (leavingParent) {
      if (item.type === "subtask") {
        throw new VaultError(
          `${key} is a subtask of ${item.parent}, which stays in ${item.project}. ` +
            `Name a parent in ${targetProject} to move it under.`,
        );
      }
      finalParent = undefined; // dropped, and reported back
    } else {
      finalParent = item.parent;
    }

    const mapping = new Map<string, string>();
    for (const member of subtree) {
      mapping.set(member.key, await this.allocateKey(targetProject));
    }

    await this.rekeyItems(
      mapping,
      new Map([[key, { parent: finalParent } as Partial<Item>]]),
    );

    const rekeyed = [...mapping].map(([from, to]) => ({ from, to }));
    await this.commit(
      `Move ${key} to ${targetProject} as ${mapping.get(key)}` +
        (subtree.length > 1 ? ` with ${subtree.length - 1} descendant(s)` : ""),
    );

    return {
      rekeyed,
      parentDropped: Boolean(leavingParent && !opts.parent) ? item.parent : undefined,
    };
  }

  /**
   * Trash a project. Its items are trashed alongside it but as separate entries,
   * so they can be restored one at a time.
   */
  async deleteProject(
    key: string,
    opts: { cascade?: boolean } = {},
  ): Promise<DeleteProjectResult> {
    const project = this.getProject(key);
    const owned = [...this.items.values()].filter((i) => i.project === key);

    if (owned.length && !opts.cascade) {
      throw new VaultError(
        `Project ${key} still holds ${owned.length} item(s). Move them to another project, ` +
          `or pass cascade to trash the project and everything in it.`,
      );
    }

    // Deepest first, so nothing is ever left pointing at something already gone.
    const byDepth = [...owned].sort((a, b) => this.depthOf(b) - this.depthOf(a));
    const items: DeleteResult[] = [];
    for (const member of byDepth) {
      items.push(await this.trashOne(member));
    }

    await fs.mkdir(this.projectTrashDir, { recursive: true });
    const stamp = nowIso().replace(/[:.]/g, "-");
    const trashName = `${key}-${stamp}.md`;
    await fs.rename(this.projectPath(key), path.join(this.projectTrashDir, trashName));
    this.projects.delete(key);

    await this.commit(
      `Trash project ${key}` + (items.length ? ` and ${items.length} item(s)` : ""),
    );

    return {
      key: project.key,
      trashedTo: `.trash/projects/${trashName}`,
      items,
    };
  }

  async listTrashedProjects(): Promise<TrashEntry[]> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.projectTrashDir);
    } catch {
      return [];
    }

    const out: TrashEntry[] = [];
    for (const file of entries) {
      if (!file.endsWith(".md")) continue;
      const match = /^([A-Z][A-Z0-9]{1,9})-(\d{4}-.+)\.md$/.exec(file);
      if (!match) continue;

      let summary: string | undefined;
      try {
        const raw = await fs.readFile(path.join(this.projectTrashDir, file), "utf8");
        const value = (parseFrontmatter(raw).data as { name?: unknown }).name;
        if (typeof value === "string") summary = value;
      } catch {
        // Listed unlabelled rather than hidden.
      }

      out.push({ file, key: match[1], trashedAt: match[2], summary, hasAttachments: false });
    }
    return out.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
  }

  /**
   * Restore a trashed project. Its items stay in the trash — restore them
   * individually, so a project can come back without everything that was in it.
   */
  async restoreProject(file: string): Promise<Project> {
    if (file.includes("/") || file.includes("\\") || file.includes("..")) {
      throw new VaultError(`Expected a filename from listTrashedProjects(), got a path: ${file}`);
    }

    const source = path.join(this.projectTrashDir, file);
    let raw: string;
    try {
      raw = await fs.readFile(source, "utf8");
    } catch {
      throw new VaultError(`Nothing called ${file} in the project trash`);
    }

    const { data, body } = parseFrontmatter(raw);
    let frontmatter;
    try {
      frontmatter = ProjectSchema.parse(data);
    } catch (err) {
      throw new VaultError(`${file} no longer matches the schema: ${formatZodError(err)}`);
    }
    if (this.projects.has(frontmatter.key)) {
      throw new VaultError(`Project ${frontmatter.key} exists again — restoring would overwrite it`);
    }

    await fs.rename(source, this.projectPath(frontmatter.key));
    const project: Project = { ...frontmatter, description: body };
    this.projects.set(project.key, project);
    await this.commit(`Restore project ${project.key} from trash`);
    return project;
  }

  /** How many ancestors an item has. Used to trash children before parents. */
  private depthOf(item: Item): number {
    let depth = 0;
    let cursor = item.parent;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      cursor = this.items.get(cursor)?.parent;
    }
    return depth;
  }

  /**
   * Rewrite item keys and every reference to them, in one pass.
   *
   * Shared by renameProject and moveItemsToProject, which both have to fix the
   * same five things: the item's own key and project, its filename, its
   * attachment folder plus the paths recorded inside it, and every `parent` and
   * item-link elsewhere in the vault that pointed at the old key.
   *
   * `overrides` are keyed by the OLD key and applied as the item is rewritten —
   * needed because some changes cannot be made before or after. Clearing a
   * subtask's parent in a separate write would fail validation on its own.
   */
  private async rekeyItems(
    mapping: Map<string, string>,
    overrides: Map<string, Partial<Item>> = new Map(),
  ): Promise<void> {
    if (!mapping.size && !overrides.size) return;

    for (const [from, to] of mapping) {
      if (!this.items.has(from)) throw new VaultError(`No item with key ${from}`);
      if (!ITEM_KEY_RE.test(to)) throw new VaultError(`${to} is not a valid item key`);
      if (this.items.has(to) && !mapping.has(to)) {
        throw new VaultError(`Cannot re-key ${from} to ${to} — ${to} already exists`);
      }
    }

    const rewritten: Item[] = [];
    const vacated: string[] = [];
    const attachMoves: Array<{ from: string; to: string }> = [];

    for (const item of this.items.values()) {
      const newKey = mapping.get(item.key) ?? item.key;
      const keyChanged = newKey !== item.key;

      const mappedParent = item.parent ? mapping.get(item.parent) ?? item.parent : undefined;
      const links = item.links.map((l) =>
        l.type === "item" && mapping.has(l.target)
          ? { ...l, target: mapping.get(l.target) as string }
          : l,
      );
      const attachments = keyChanged
        ? item.attachments.map((a) => ({
            ...a,
            path: a.path.startsWith(`attachments/${item.key}/`)
              ? `attachments/${newKey}/${a.path.slice(`attachments/${item.key}/`.length)}`
              : a.path,
          }))
        : item.attachments;

      const override = overrides.get(item.key);
      const linksChanged = links.some((l, i) => l.target !== item.links[i].target);
      if (!keyChanged && !linksChanged && mappedParent === item.parent && !override) continue;

      if (keyChanged) {
        vacated.push(this.itemPath(item.key));
        attachMoves.push({
          from: this.attachmentDir(item.key),
          to: this.attachmentDir(newKey),
        });
      }

      rewritten.push({
        ...item,
        key: newKey,
        project: newKey.split("-")[0],
        parent: mappedParent,
        links,
        attachments,
        ...override,
        updated: nowIso(),
      });
    }

    // Attachment folders first: the paths written into frontmatter should point
    // at something real by the time the file lands.
    for (const move of attachMoves) {
      if (await pathExists(move.from)) {
        await fs.mkdir(path.dirname(move.to), { recursive: true });
        await fs.rename(move.from, move.to);
      }
    }

    for (const item of rewritten) await this.writeAndIndex(item);

    // Drop the files left behind, but never one that is now someone's new home.
    const live = new Set(rewritten.map((i) => this.itemPath(i.key)));
    for (const filePath of vacated) {
      if (!live.has(filePath)) await fs.rm(filePath, { force: true });
    }
    for (const from of mapping.keys()) {
      if (!rewritten.some((i) => i.key === from)) this.items.delete(from);
    }
  }

  // ------------------------------------------------------------------- git

  /**
   * Whether writes are actually being committed.
   *
   * `commit()` is intentionally non-fatal, which means a vault that was never
   * `git init`ed accepts every write and silently keeps no history — the one
   * failure mode that loses work. This is what the UI shows so "I have undo" is
   * something you can check rather than assume.
   */
  async gitStatus(): Promise<GitStatus> {
    const enabled = this.options.git === true;
    let gitAvailable = false;
    let isRepo = false;
    let repoRoot: string | undefined;
    let ignored = false;
    let lastCommit: GitStatus["lastCommit"];

    try {
      await execFileAsync("git", ["--version"]);
      gitAvailable = true;
    } catch {
      return { enabled, gitAvailable: false, isRepo: false, ignored: false, healthy: false };
    }

    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd: this.root,
      });
      repoRoot = path.resolve(stdout.trim());
      isRepo = true;
    } catch {
      isRepo = false;
    }

    if (isRepo) {
      // Being inside a repo is not enough. A vault the repo ignores accepts
      // every write and keeps no history at all — which is how this method
      // reported "healthy" for a vault sitting gitignored inside another repo.
      try {
        await execFileAsync("git", ["check-ignore", "-q", this.root], { cwd: this.root });
        ignored = true; // exit 0 means the path is ignored
      } catch {
        ignored = false;
      }

      try {
        const { stdout } = await execFileAsync(
          "git",
          ["log", "-1", "--format=%h%x00%s%x00%cI"],
          { cwd: this.root },
        );
        const [hash, subject, at] = stdout.trim().split("\0");
        if (hash) lastCommit = { hash, subject: subject ?? "", at: at ?? "" };
      } catch {
        // A repo with no commits yet.
      }
    }

    return {
      enabled,
      gitAvailable,
      isRepo,
      repoRoot,
      ignored,
      lastCommit,
      lastError: this.lastCommitError,
      healthy: enabled && gitAvailable && isRepo && !ignored && !this.lastCommitError,
    };
  }

  // ------------------------------------------------------------ validation

  private assertParentValid(childType: string, parentKey: string, selfKey?: string): void {
    if (selfKey && parentKey === selfKey) {
      throw new VaultError("An item cannot be its own parent");
    }
    const parent = this.items.get(parentKey);
    if (!parent) {
      throw new VaultError(`Parent ${parentKey} does not exist in this vault`);
    }
    if (childType === "epic") {
      throw new VaultError("Epics sit at the top of the hierarchy and cannot have a parent");
    }
    if (childType === "subtask") {
      if (parent.type === "subtask" || parent.type === "epic") {
        throw new VaultError(
          `Subtasks hang off a story, task, or bug. ${parentKey} is ${parent.type === "epic" ? "an epic" : "a subtask"}.`,
        );
      }
      return;
    }
    // story / task / bug
    if (parent.type !== "epic") {
      throw new VaultError(
        `A ${childType} can only be parented to an epic. ${parentKey} is a ${parent.type}.`,
      );
    }
    // Guard against cycles introduced by re-parenting.
    let cursor: string | undefined = parentKey;
    const seen = new Set<string>();
    while (cursor) {
      if (selfKey && cursor === selfKey) {
        throw new VaultError(`Re-parenting ${selfKey} to ${parentKey} would create a cycle`);
      }
      if (seen.has(cursor)) break;
      seen.add(cursor);
      cursor = this.items.get(cursor)?.parent;
    }
  }

  private assertTransitionAllowed(from: Status, to: Status): void {
    const allowed = TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new VaultError(
        `Cannot move an item from ${from} to ${to}. From ${from} you can go to: ${allowed.join(", ")}.`,
      );
    }
  }

  // ---------------------------------------------------------------- persistence

  private async writeItem(item: Item): Promise<void> {
    const { description, ...frontmatter } = item;
    const text = serializeFrontmatter(
      frontmatter as unknown as Record<string, unknown>,
      description,
      FRONTMATTER_ORDER,
    );
    await writeFileAtomic(this.itemPath(item.key), text);
  }

  private async writeProject(project: Project): Promise<void> {
    const { description, ...frontmatter } = project;
    const text = serializeFrontmatter(
      frontmatter as unknown as Record<string, unknown>,
      description,
      PROJECT_FRONTMATTER_ORDER,
    );
    await writeFileAtomic(this.projectPath(project.key), text);
  }

  /**
   * Allocates the next key for a project. Takes the max of the stored counter
   * and the highest key on disk so a deleted item never has its key reused —
   * important once keys have been referenced in Jira or in an email.
   */
  private async readCounters(): Promise<Counters> {
    try {
      return JSON.parse(await fs.readFile(this.countersPath, "utf8")) as Counters;
    } catch {
      return {};
    }
  }

  private async writeCounters(counters: Counters): Promise<void> {
    await writeFileAtomic(this.countersPath, `${JSON.stringify(counters, null, 2)}\n`);
  }

  private async allocateKey(projectKey: string): Promise<string> {
    const counters = await this.readCounters();

    let highestOnDisk = 0;
    for (const key of this.items.keys()) {
      if (!key.startsWith(`${projectKey}-`)) continue;
      const n = Number.parseInt(key.slice(projectKey.length + 1), 10);
      if (Number.isFinite(n) && n > highestOnDisk) highestOnDisk = n;
    }

    const next = Math.max(counters[projectKey] ?? 0, highestOnDisk) + 1;
    counters[projectKey] = next;
    await this.writeCounters(counters);
    return `${projectKey}-${next}`;
  }

  /**
   * Best-effort git commit. Never throws — version history is a bonus, not a
   * dependency — but the reason for a failure is kept so `gitStatus()` can
   * report it. Silently doing nothing is the failure that loses work.
   */
  private async commit(message: string): Promise<void> {
    if (!this.options.git) return;
    try {
      await execFileAsync("git", ["add", "-A"], { cwd: this.root });
      await execFileAsync("git", ["commit", "-m", message, "--no-verify"], { cwd: this.root });
      this.lastCommitError = undefined;
    } catch (err) {
      const text = [
        err instanceof Error ? err.message : String(err),
        (err as { stdout?: string }).stdout ?? "",
        (err as { stderr?: string }).stderr ?? "",
      ].join("\n");

      // An empty commit is not a problem — it means an identical write landed
      // twice, which happens whenever a no-op update is saved.
      this.lastCommitError = /nothing to commit|nothing added to commit/i.test(text)
        ? undefined
        : text.trim().split("\n")[0];
    }
  }
}

// ------------------------------------------------------------------ helpers

const PRIORITY_RANK: Record<string, number> = {
  highest: 0,
  high: 1,
  medium: 2,
  low: 3,
  lowest: 4,
};

/** Overdue and high priority first, then by due date, then by key. */
function sortByWorkOrder(a: Item, b: Item): number {
  const aDone = DONE_STATUSES.includes(a.status) ? 1 : 0;
  const bDone = DONE_STATUSES.includes(b.status) ? 1 : 0;
  if (aDone !== bDone) return aDone - bDone;

  if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) {
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  if (a.dueDate && !b.dueDate) return -1;
  if (!a.dueDate && b.dueDate) return 1;

  const pri = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (pri !== 0) return pri;

  return a.key.localeCompare(b.key, undefined, { numeric: true });
}

/**
 * Manual order, for a board column.
 *
 * Ranked items come first in the order they were dragged into; unranked ones
 * fall to the bottom in urgency order, so a freshly created item lands at the
 * end of the column rather than somewhere arbitrary in the middle.
 */
export function compareByRank(a: Item, b: Item): number {
  const aDone = DONE_STATUSES.includes(a.status) ? 1 : 0;
  const bDone = DONE_STATUSES.includes(b.status) ? 1 : 0;
  if (aDone !== bDone) return aDone - bDone;

  if (a.rank !== undefined && b.rank !== undefined) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.key.localeCompare(b.key, undefined, { numeric: true });
  }
  if (a.rank !== undefined) return -1;
  if (b.rank !== undefined) return 1;

  return sortByWorkOrder(a, b);
}

/**
 * Manual project order, falling back to alphabetical.
 *
 * Ranked projects lead, in the order they were dragged; unranked ones follow by
 * key, so a newly created project appears at the end of the list rather than
 * jumping into the middle of a hand-arranged sidebar.
 */
export function compareProjectsByRank(a: Project, b: Project): number {
  if (a.rank !== undefined && b.rank !== undefined) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.key.localeCompare(b.key);
  }
  if (a.rank !== undefined) return -1;
  if (b.rank !== undefined) return 1;
  return a.key.localeCompare(b.key);
}

function stripDescription(obj: Record<string, unknown>): Record<string, unknown> {
  const { description, ...rest } = obj;
  return rest;
}

/**
 * The `startDate` an item being picked up should carry, given what it has.
 *
 * Nobody types the date they started something on the day they start it, so the
 * field stays empty on exactly the items that are being worked. Moving into
 * `in_progress` fills it in; an explicit date always wins, so this only ever
 * writes into an empty field.
 *
 * Returns the existing value unchanged when today would fall after `dueDate`,
 * and that is the whole reason this returns a value rather than assigning one.
 * `ItemFrontmatterSchema` rejects `startDate > dueDate`, so stamping an overdue
 * item would fail the write and blame two dates the user never typed together —
 * and dragging an overdue card into In Progress works today. A convenience must
 * never be why an action fails, so it yields instead. The honest cost is that
 * the items likeliest to be started late are the ones it does nothing for.
 */
function startDateOnPickup(
  startDate: string | undefined,
  dueDate: string | undefined,
  today: string = todayIso(),
): string | undefined {
  if (startDate) return startDate;
  if (dueDate && today > dueDate) return undefined;
  return today;
}

/** Only the fields that actually get pushed to Jira, for drift detection. */
export function pushableFields(item: Item): Record<string, unknown> {
  return {
    type: item.type,
    summary: item.summary,
    description: item.description,
    priority: item.priority,
    parent: item.parent ?? null,
    labels: [...item.labels].sort(),
    components: [...item.components].sort(),
    assignee: item.assignee ?? null,
    startDate: item.startDate ?? null,
    dueDate: item.dueDate ?? null,
    estimate: item.estimate ?? null,
  };
}
