# Plan: the Electron desktop shell

Phases 1, 2, and 5 are done and read well — schema, vault core, CLI, MCP server,
14 tests. Stack is decided: **Electron**. This is the plan for phases 3, 4, and 6.

Before any UI code, though, there are five things wrong with the working copy.

## Phase 0 — make the existing code run

None of it has ever executed on this machine. Fix that first; the core is the
foundation for everything below, and a UI built over unproven code just moves
the debugging later.

**0.1 — Node.js is not installed.** Not on `PATH`, not in `Program Files\nodejs`,
no nvm/fnm/Volta. `winget` is available:

```bash
winget install OpenJS.NodeJS.LTS
```

Then open a new shell and confirm `node --version` reports v20 or later, which
`package.json` requires.

**0.2 — the files are in the wrong place.** Everything is flat in
`Desktop/files/`, but the config expects a `src/` + `test/` split:

| Says | Expects |
|---|---|
| `tsconfig.json` | `rootDir: "src"`, `include: ["src/**/*.ts"]` |
| `package.json` | `tsx src/cli.ts`, `tsx test/vault.test.ts`, `dist/index.js` |
| `vault.test.ts` | `import { Vault } from "../src/vault.js"` |

As it stands `tsc` compiles zero files and every npm script fails. Move the nine
modules (`schema` `markdown` `util` `vault` `jira` `cli` `mcp-server` `index`)
into `src/`, `vault.test.ts` into `test/`, and leave `README.md`, `SCHEMA.md`,
`package.json`, `tsconfig.json`, and `jira-map.example.yaml` at the root.

**0.3 — install and prove it.**

```bash
npm install && npm run typecheck && npx tsx --test test/vault.test.ts
```

Fourteen green tests is the gate for starting Phase 1. Nothing else.

**0.4 — `git init` the vault, not just the repo.** `Vault.commit()` shells out to
git with `cwd: this.root` — the *vault* directory, not the code. Without a repo
there, `--git` does nothing, and because `commit()` swallows every error you'd
believe you had undo history when you had none. Two separate repos: one for the
code, one for the vault.

**0.5 — build the example vault.** The README advertises a worked example at
`./vault` with two projects, an epic, recurring items, and every link type. It
doesn't exist. Generate it with the CLI — it doubles as the fixture the UI is
developed against, so day one of Phase 1 has something real on screen.

## Phase 0.5 — two schema decisions, before the UI

Both are schema changes. Deciding them after the board is built means reworking
the board.

**Manual ordering.** `sortByWorkOrder` is entirely derived — done, then due date,
then priority, then key. There is no rank field. Dragging a card *between*
columns is a status change and works today; dragging *within* a column to
reorder has nowhere to persist, so cards will spring back to computed position
the moment they land. Recommendation: add an optional `rank` string to
`ItemFrontmatterSchema` and `FRONTMATTER_ORDER`, sorted lexicographically ahead
of the existing tiebreakers, assigned as a sparse fractional key (LexoRank-style:
midpoint between neighbours). A reorder then rewrites one file instead of
renumbering the column. If manual ordering isn't worth a schema field, say so
now and make column order explicitly read-only in the UI.

**Deletion.** There is no `deleteItem`, no `deleteProject`, no `updateProject` —
the test file reaches past the API and calls `fs.rm` directly, which is the tell
that it was never needed until now. A UI needs it. Recommendation: add
`Vault.deleteItem(key)` that unlinks the file and commits. Key reuse is already
prevented by the counters file, and git holds the history, so a hard delete is
safe and an `archived` flag is a field you'd have to filter on in every view.

## Phase 1 — the shell, read-only

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
  intra-column → `rank`.
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

## Two bugs to fix on the way past

**Attachment paths use backslashes on Windows.** `addAttachment` stores
`path.relative(this.root, destPath)`, which on win32 yields
`attachments\ACME-2\spec.pdf` and writes that into the YAML. It round-trips fine
on this machine, breaks if the vault is ever opened on macOS or Linux, and looks
wrong to the external readers the whole design is built around. Normalize to
forward slashes on write and `path.normalize` on read.

**`addComment` skips validation.** Unlike `addLink` and `addAttachment`, it
constructs the `Item` directly instead of round-tripping through
`ItemFrontmatterSchema.parse`. `CommentSchema` requires a non-empty body, so an
empty textarea submitted from the UI writes a file that fails to parse on the
next `load()` — the item disappears from the app and shows up in the `errors[]`
nothing displays yet. One-line fix, and it matters much more once a UI is calling
it than it did from the CLI.

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
