# Plan: the Electron desktop shell

Stack is decided: **Electron**. This is the plan for phases 3, 4, and 6.

**Phases 0, 0.5, and 0.6 are complete.** Node 24.18 is installed, the tree is
split into `src/` and `test/`, both git repos exist, the example vault is seeded,
and the suite is at 36 green tests. Ranking for items and projects, trash-based
deletion, the full set of project operations, and the three-way agenda split are
in the core, the CLI, and the MCP server. Phase 1 onwards is the remaining work.

## Phase 0 — make the existing code run ✅

Node 24.18.0 installed via winget. The nine modules moved into `src/`,
`vault.test.ts` into `test/`, which is what `tsconfig.json`'s `rootDir` and the
npm scripts had always named. `npm install`, typecheck clean, 14 tests green on
the first run — the core was sound, it had just never been executed.

Two git repos, because `Vault.commit()` shells out with `cwd: this.root` and so
commits into the *vault*, not the code tree. The code repo gitignores `/vault/`
to avoid a nested repo. Both carry a `.gitattributes` pinning `eol=lf`: without
it git checks files out as CRLF on Windows, the app rewrites them as LF, and
every file reads as wholly modified — which would defeat the stable frontmatter
ordering the whole design rests on.

The example vault is seeded by `scripts/seed-vault.ts` (12 items, 2 projects,
every link type, both attachment modes) and `doctor` reports it clean.

## Phase 0.5 — the two schema decisions ✅

**Manual ordering — `rank`, as sparse integers.** Gaps of 1000; a drag rewrites
one file; `moveItem` respaces the project when a gap closes. I had floated
LexoRank-style fractional strings in the first draft of this plan and changed my
mind: those exist for trackers with millions of rows, whereas a respace here is
a few hundred instant writes, and integers stay hand-editable in the markdown.

Work order and rank order are kept as **separate sorts** rather than one blended
comparator — `listItems({ sort: "work" | "rank" })`. A backlog wants "what is
most urgent"; a board column wants "the order I dragged them into". Blending them
gives neither.

**Deletion — `.trash/`, not a hard delete and not an `archived` flag.** This
reversed the recommendation in the first draft, after checking what git actually
guarantees. `git add -A` does stage deletions, so a hard delete *would* be
recoverable — but only if `git: true` is passed, the vault is really a repo, and
git is on PATH, and `commit()` swallows every failure silently. Recovery that
depends on three unverified conditions is not recovery.

A trash directory beats both alternatives: unlike a hard delete it does not need
git configured correctly, and unlike an `archived` flag nothing has to filter on
it — `load()` only reads `items/` and `projects/`, so trashed items leave the
index for free. It composes with git rather than competing, since the move is
committed too.

Delete refuses to orphan children without `cascade`, and reports the links it
leaves dangling instead of silently editing other items.

**`gitStatus()`** closes the silent-failure hole so the UI can show whether
history is really accruing. `commit()` stays non-fatal but now records why it
failed. Worth noting what shook out of testing this: checking
`--is-inside-work-tree` is *not* enough, because a vault sitting gitignored
inside another repo answers yes while committing nothing. It now reports the repo
root and whether that repo ignores the vault.

Also fixed, both found by running the code rather than reading it:

- Attachment paths were stored with Windows backslashes. Now POSIX-style, with
  `resolveAttachment()` accepting either separator so older vaults still load.
- `addComment` wrote unvalidated, so an empty comment produced a file that threw
  on the next `load()`. All seven write paths now go through one `persist()` that
  validates first.
- `moveItem` with only one neighbour named put the card in the wrong place, and
  could assign a rank that collided with an existing one. `{ before: X }` now
  means *immediately* before X, deriving the other bound from the real order.

## Phase 1 — the shell, read-only

**Dependencies — pin these.** Installing the latest of everything fails outright:
`electron-vite@5` accepts Vite `^5 || ^6 || ^7`, while the current
`@vitejs/plugin-react@6` requires Vite `^8`, so npm exits with `ERESOLVE`. This
combination is verified to resolve and run on this machine:

| | |
|---|---|
| `electron` | `^43` |
| `electron-vite` | `^5` |
| `vite` | `^7` — **not 8**, until electron-vite catches up |
| `@vitejs/plugin-react` | `^5` — 6.x demands Vite 8 |
| `react` / `react-dom` | `^19` |
| `typescript` | `^5` |
| `chokidar` | `^4` |
| `@dnd-kit/core` + `@dnd-kit/sortable` | latest |

Nothing in that set compiles native code, so no Visual Studio Build Tools,
Python, or node-gyp are needed. The only `.node` files in the tree are prebuilt
binaries shipped inside Electron's zip extractor.

**Electron downloads on first run, not on install.** Electron 43 declares no
install scripts; `require('electron')` lazily triggers `install.js`. So
`npm install` finishes in seconds and the first `npm run dev` pauses to fetch
~350 MB. The zip is cached in `%LOCALAPPDATA%\electron\Cache`, so a second
project extracts from cache rather than re-downloading.

**Structure.** Convert to npm workspaces: `packages/core` (everything that exists
now) and `apps/desktop`. The CLI and MCP server stay independently shippable,
and the app depends on `core`'s built `dist/` with its type declarations — which
`tsconfig.json` already emits.

**The one constraint that shapes everything.** `Vault` imports `node:fs` and
`node:child_process`. It runs in the **main** process only. The renderer never
touches it, never gets `nodeIntegration`, and reaches the vault exclusively over
IPC through a `contextBridge` preload. `contextIsolation: true`, `sandbox: true`
— the preload only needs `ipcRenderer`, so sandboxing costs nothing.

**Main process.** Owns one `Vault` instance. Owns a chokidar watcher on
`items/` and `projects/`, debounced ~150ms, calling `vault.load()` and pushing a
fresh snapshot to the renderer. Owns the vault-directory choice, persisted in
`app.getPath('userData')`, with a first-run picker.

**IPC.** One typed channel per method — `vault:list`, `vault:get`,
`vault:create`, `vault:update`, `vault:transition`, `vault:comment`,
`vault:link`, `vault:attach`, `vault:projects`, `vault:agenda`, `vault:jiraPlan`
— all `invoke`/`handle`, plus `vault:changed` as the one main→renderer push.

Two details worth getting right the first time:

- **Serialize errors deliberately.** Structured clone strips the `VaultError`
  class and its `name` across IPC. Return `{ ok: false, message }`. Those
  messages are already written for a human — *"Cannot move an item from todo to
  in_review. From todo you can go to: in_progress, blocked, done."* — so pipe
  them straight to a toast and the UI inherits the core's error quality for free.
- **Return the whole snapshot after every mutation.** A few hundred items is
  nothing, `load()` already rebuilds the entire index, and reconciling
  per-item deltas is a bug farm for no gain.

**Renderer.** React + TypeScript on electron-vite. Three views: backlog table,
board, item detail. Filters by project, status, cadence, category. Plain React
state and a `useVault()` hook over the snapshot — no TanStack Query, there's no
network and no cache to invalidate. No router for three views.

**Agenda view.** Three sections, not one list: overdue, due, recurring. The core
already returns them tagged with `kind`, so this is layout.

**Surface the load errors.** `load()` returns an `errors[]` that currently
nothing reads. When an external Claude writes broken YAML, those items silently
vanish from every view. A persistent banner — "2 files failed to parse" with the
paths — is a thirty-minute job that saves an afternoon of confusion.

**Gate:** launch the app, see the example vault, edit an item's `.md` in Notepad,
watch the board update without touching the app.

## Phase 2 — editing

- Item detail form covering every field; create dialog built on `CreateItemInput`.
- **Transition-aware controls.** `TRANSITIONS` is exported — import it in the
  renderer and disable illegal drop targets and status options rather than
  letting the write throw. `todo → in_review` is rejected by design (SCHEMA.md
  explains why), and on a drag-and-drop board an unguarded rejection surfaces as
  a card snapping back with an error toast, which reads as a bug.
- Board drag-and-drop with `@dnd-kit/core`. Cross-column → `transition`,
  intra-column → `moveItem(key, { after, before })` with the two neighbours the
  drop landed between. Read columns with `sort: "rank"`. The project sidebar
  is draggable the same way, via `moveProject`.
- Delete via the trash, with an undo affordance backed by `restoreItem`, and a
  trash view. Deleting a parent must surface the cascade prompt rather than
  swallowing the refusal.
- Links, attachments, comments. For dropping files onto an item, note that
  `File.path` was removed from Electron — use `webUtils.getPathForFile`.

**Gate:** run a day of real work in it before adding anything else.

## Phase 3 — polish

Global search over summary and description (Ctrl-K), keyboard shortcuts, and the
agenda view — `Vault.agenda()` already returns overdue/today/week/month sections,
so this is a screen over an existing method, not new logic. Recurring items from
`cadence` come last.

## Phase 4 — in-app Claude

Optional layer, degrades to a plain form when absent. The Anthropic call lives in
the **main** process — an API key must never reach the renderer bundle. Store it
with Electron's `safeStorage`. Use tool-use for structured output, validate the
result against `CreateItemInput`, and always render the draft for confirmation
before writing. That validation step is why this is cheap: the schema already
rejects everything malformed.

## Phase 5 — Jira push from the UI

`buildPushPlan` output in a review pane, then the POST as an explicit user
action. Also implement `vault jira discover`: both the README and a warning
string inside `jira.ts` instruct you to run it, and `cli.ts` has no such
subcommand — the only two `jira` subcommands are `csv` and the default plan.

## Phase 0.6 — parity across the three surfaces ✅

**MCP is level with the CLI again**, at 23 tools from 13. The ten additions are
`move_item`, `delete_item`, `restore_item`, `list_trash`, `update_project`,
`rename_project`, `reorder_project`, `move_item_to_project`, `delete_project`,
`restore_project`.
The destructive ones carry `destructiveHint` and refuse rather than guess:
deleting something with children returns the list of what is in the way. Verified
by driving the server over stdio — handshake, `tools/list`, then a delete, a
trash listing, a restore, and a refusal.

**Project operations.** `updateProject`, `renameProject`, `deleteProject`,
`restoreProject`, `listTrashedProjects`, `moveProject`, and
`moveItemsToProject`.

Projects rank too, so the list order is yours. `listProjects()` honours manual
order where one is set and falls back to alphabetical, which means a vault where
nothing has been dragged reads exactly as it did before, and a new project lands
at the end instead of the middle of an arranged list. Three verbs stay distinct
and are named to stop a model conflating them: `moveItem` reorders within a
project, `moveProject` reorders the list, `moveItemsToProject` moves work
between projects.

Rename and cross-project move share one `rekeyItems` primitive, because both have
to fix the same five kinds of reference — the item's key and project, its
filename, its attachment folder and the paths inside it, and every `parent` and
item link pointing at it from anywhere in the vault. Both preserve every `id`, so
identity survives a key change; neither touches `sync.jiraKey`, which is Jira's.

Trash moved to `.trash/items/` and `.trash/projects/`. A project trashed
alongside items would have produced `.trash/ACME-2026-07-25T…md`, which parses as
item key "ACME-2026".

**Agenda split into `overdue` / `due` / `recurring`.** Sections now carry a `kind`
separate from the window. Recurring work has no deadline, so listing it with
dated work implied a due date it does not have.

Worth noting what running it caught: every item now lands in exactly one section.
Something due last Tuesday is both inside this week's window *and* overdue, and
until it was on screen with real data I had deduped `recurring` against the others
but left `due` and `overdue` double-listing the same three items.

## Loose ends worth knowing about

**`vault jira discover` still does not exist.** Both the README and a warning
string inside `jira.ts` tell you to run it. Phase 5.

**Recurring items still show a due date outside the window.** In the seeded
vault, OPS-2 appears under "recurring this week" carrying `due:2026-07-29`. That
is honest — it recurs this week and is due next — but the UI should render the
distinction rather than printing a date that looks like it contradicts the
heading.

## The risk that stays

Last-write-wins between the app, the MCP server, and an external Claude. Both
writers reload before mutating, writes are atomic, and git makes every version
recoverable — that's the accepted trade in SCHEMA.md and it's the right one for a
single user. The file watcher improves it in practice by making a clobber
*visible* within a second rather than discovered a week later.

One Windows-specific hardening note: `writeFileAtomic` ends in `fs.rename`, which
does overwrite on Windows, but can fail with a transient `EPERM` when an
antivirus scanner or search indexer holds the target open. Adding a watcher makes
that marginally more likely. A three-attempt retry with backoff is the standard
answer.
