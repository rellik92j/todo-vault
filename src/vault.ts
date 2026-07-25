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
  nowIso,
  pathExists,
  randomUUID,
  startOfMonth,
  startOfWeek,
  todayIso,
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

export class Vault {
  readonly root: string;
  private readonly options: VaultOptions;
  private items = new Map<string, Item>();
  private projects = new Map<string, Project>();
  private loaded = false;

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

    matched.sort(sortByWorkOrder);
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

    const item: Item = { ...frontmatter, description: input.description ?? "" };
    await this.writeItem(item);
    this.items.set(key, item);
    await this.commit(`Add ${key}: ${item.summary}`);
    return item;
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

    await this.writeItem(next);
    this.items.set(key, next);
    await this.commit(`Update ${key}`);
    return next;
  }

  async transition(key: string, status: Status): Promise<Item> {
    return this.updateItem(key, { status });
  }

  async addComment(key: string, body: string, author = "me"): Promise<Item> {
    const existing = this.getItem(key);
    const next: Item = {
      ...existing,
      comments: [...existing.comments, { author, at: nowIso(), body }],
      updated: nowIso(),
    };
    await this.writeItem(next);
    this.items.set(key, next);
    await this.commit(`Comment on ${key}`);
    return next;
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

    const frontmatter = ItemFrontmatterSchema.parse(
      stripDescription({
        ...existing,
        links: [...existing.links, { ...link, addedAt: nowIso() }],
        updated: nowIso(),
      }),
    );
    const next: Item = { ...frontmatter, description: existing.description };
    await this.writeItem(next);
    this.items.set(key, next);
    await this.commit(`Link ${key} -> ${link.target}`);
    return next;
  }

  async removeLink(key: string, target: string): Promise<Item> {
    const existing = this.getItem(key);
    const links = existing.links.filter((l) => l.target !== target);
    if (links.length === existing.links.length) {
      throw new VaultError(`${key} has no link to ${target}`);
    }
    const next: Item = { ...existing, links, updated: nowIso() };
    await this.writeItem(next);
    this.items.set(key, next);
    await this.commit(`Unlink ${key} -> ${target}`);
    return next;
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
    const relative = path.relative(this.root, destPath);

    const frontmatter = ItemFrontmatterSchema.parse(
      stripDescription({
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
      }),
    );
    const next: Item = { ...frontmatter, description: existing.description };
    await this.writeItem(next);
    this.items.set(key, next);
    await this.commit(`Attach ${path.basename(absSource)} to ${key}`);
    return next;
  }

  /** Records the outcome of a Jira push so drift detection has a baseline. */
  async markPushed(key: string, jiraKey: string, jiraId?: string): Promise<Item> {
    const existing = this.getItem(key);
    const next: Item = {
      ...existing,
      sync: {
        jiraKey,
        jiraId,
        lastPushedAt: nowIso(),
        contentHash: contentHash(pushableFields(existing)),
        state: "pushed",
      },
      updated: nowIso(),
    };
    await this.writeItem(next);
    this.items.set(key, next);
    await this.commit(`Mark ${key} pushed as ${jiraKey}`);
    return next;
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

  /** Best-effort git commit. Never throws — version history is a bonus, not a dependency. */
  private async commit(message: string): Promise<void> {
    if (!this.options.git) return;
    try {
      await execFileAsync("git", ["add", "-A"], { cwd: this.root });
      await execFileAsync("git", ["commit", "-m", message, "--no-verify"], { cwd: this.root });
    } catch {
      // No git repo, nothing staged, or git absent. Carry on.
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
