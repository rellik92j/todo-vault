import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseFrontmatter, serializeFrontmatter } from "./markdown.js";
import {
  CreateItemInput,
  DONE_STATUSES,
  FRONTMATTER_ORDER,
  ItemFilter,
  ItemFrontmatterSchema,
  PROJECT_FRONTMATTER_ORDER,
  ProjectSchema,
  TRANSITIONS,
  UpdateItemInput,
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
  scope: "overdue" | "today" | "week" | "month";
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

  listProjects(): Project[] {
    this.assertLoaded();
    return [...this.projects.values()].sort((a, b) => a.key.localeCompare(b.key));
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

    const matched = [...this.items.values()].filter((item) => {
      if (filter.project && item.project !== filter.project) return false;
      if (filter.type && item.type !== filter.type) return false;
      if (statuses && !statuses.has(item.status)) return false;
      if (filter.priority && item.priority !== filter.priority) return false;
      if (filter.cadence && item.cadence !== filter.cadence) return false;
      if (filter.category && item.category !== filter.category) return false;
      if (filter.assignee && item.assignee !== filter.assignee) return false;
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

  agenda(scope: "today" | "week" | "month", reference = todayIso()): AgendaSection[] {
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
      month: {
        from: startOfMonth(reference),
        to: endOfMonth(reference),
        cadences: ["daily", "weekly", "monthly"],
      },
    };

    const { from, to, cadences } = ranges[scope];
    const inWindow = open
      .filter(
        (i) =>
          (i.dueDate && i.dueDate >= from && i.dueDate <= to) ||
          cadences.includes(i.cadence),
      )
      .sort(sortByWorkOrder);

    const sections: AgendaSection[] = [];
    if (overdue.length) sections.push({ scope: "overdue", to: reference, items: overdue });
    sections.push({ scope, from, to, items: inWindow });
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
    const project: Project = { ...frontmatter, description: input.description ?? "" };
    await this.writeProject(project);
    this.projects.set(project.key, project);
    await this.commit(`Add project ${project.key}`);
    return project;
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

    const frontmatter = ItemFrontmatterSchema.parse({
      id: randomUUID(),
      key,
      project: input.project,
      type: input.type,
      summary: input.summary,
      status: input.status ?? "todo",
      priority: input.priority ?? "medium",
      parent: input.parent,
      category: input.category,
      labels: input.labels ?? [],
      components: input.components ?? [],
      assignee: input.assignee,
      reporter: input.reporter,
      startDate: input.startDate,
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
    await fs.mkdir(this.trashDir, { recursive: true });
    // Colons are illegal in Windows filenames, so the ISO stamp gets flattened.
    const stamp = nowIso().replace(/[:.]/g, "-");
    const danglingBacklinks = this.backlinks(item.key).map((i) => i.key);

    const trashName = `${item.key}-${stamp}.md`;
    await fs.rename(this.itemPath(item.key), path.join(this.trashDir, trashName));

    let attachmentsTrashedTo: string | undefined;
    const attachDir = this.attachmentDir(item.key);
    if (await pathExists(attachDir)) {
      const dirName = `${item.key}-${stamp}-attachments`;
      await fs.rename(attachDir, path.join(this.trashDir, dirName));
      attachmentsTrashedTo = `.trash/${dirName}`;
    }

    this.items.delete(item.key);

    return {
      key: item.key,
      trashedTo: `.trash/${trashName}`,
      attachmentsTrashedTo,
      danglingBacklinks,
    };
  }

  async listTrash(): Promise<TrashEntry[]> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.trashDir);
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
        const raw = await fs.readFile(path.join(this.trashDir, file), "utf8");
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

    const source = path.join(this.trashDir, file);
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
    const attachSource = path.join(this.trashDir, `${frontmatter.key}-${stamp}-attachments`);
    if (await pathExists(attachSource)) {
      await fs.rename(attachSource, this.attachmentDir(frontmatter.key));
    }

    const item: Item = { ...frontmatter, description: body };
    this.items.set(item.key, item);
    await this.commit(`Restore ${item.key} from trash`);
    return item;
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
  private async allocateKey(projectKey: string): Promise<string> {
    let counters: Counters = {};
    try {
      counters = JSON.parse(await fs.readFile(this.countersPath, "utf8")) as Counters;
    } catch {
      counters = {};
    }

    let highestOnDisk = 0;
    for (const key of this.items.keys()) {
      if (!key.startsWith(`${projectKey}-`)) continue;
      const n = Number.parseInt(key.slice(projectKey.length + 1), 10);
      if (Number.isFinite(n) && n > highestOnDisk) highestOnDisk = n;
    }

    const next = Math.max(counters[projectKey] ?? 0, highestOnDisk) + 1;
    counters[projectKey] = next;
    await writeFileAtomic(this.countersPath, `${JSON.stringify(counters, null, 2)}\n`);
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

function stripDescription(obj: Record<string, unknown>): Record<string, unknown> {
  const { description, ...rest } = obj;
  return rest;
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
