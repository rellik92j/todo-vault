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

## Phase 1 — the shell, read-only ✅

Built and verified running. Workspaces are `packages/core` (unchanged, 36 tests
still green) and `apps/desktop`. Four views — backlog table, board, agenda, and
an item detail panel — plus a project sidebar in manual rank order, filters, and
a first-run vault picker.

The gate passed: an item edited entirely outside the app appeared without any
interaction, and breaking a file's YAML produced the load-error banner naming the
file, with the item count dropping to match.

Two things caught only by running it, both worth remembering:

- **`electron-vite` cannot start Electron 43 out of the box.** It looks for the
  binary on disk, while Electron 43 downloads lazily on first `require()`, so it
  fails with a bare `Error: Electron uninstall`. Fixed with an `ensure-electron`
  script wired to `predev`/`prebuild` — `node -e "require('electron')"`, which
  costs ~0.2s once the binary is there.
- **`ready-to-show` is not a reliable trigger to show the window.** With
  `show: false`, a renderer that fails to boot leaves no window and nothing on
  stdout. The window is now shown once the load settles either way, and renderer
  console output is forwarded to the terminal. Note Electron 35 changed
  `console-message` from positional arguments to a details object; the old
  signature silently logs nothing, which is how a production-only problem stays
  invisible.

## Phase 1 — as designed

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

## Phase 2 — editing ✅

Built and verified by driving the real app: create through the form, edit every
field in place, drag on the board, delete with undo, and a trash view.

Verification note worth keeping: the app cannot be driven by synthetic OS clicks,
because Windows refuses `SetForegroundWindow` to a process launched this way and
the clicks land on whatever is actually on top. Screenshots still work
(`PrintWindow` ignores focus), which makes it look like input is working when it
is not. The reliable approach is a script that requires the built main process
and drives the renderer with `executeJavaScript` plus `webContents.sendInputEvent`
— real Chromium input, which dnd-kit's pointer sensors accept and synthetic DOM
events do not.

Three problems this turned up:

- **The renderer cannot import runtime values from the package root.** Phase 1
  only imported types, which are erased. Phase 2 needs `TRANSITIONS` and the
  enums as real values, and importing them from `todo-vault` drags in `vault.js`
  and with it `node:fs`, `node:crypto` and `node:child_process`, which fails the
  browser build. Fixed by moving the pure constants into `constants.ts`, which
  imports nothing, exposed as `todo-vault/constants`. Still one source of truth —
  the schema re-exports it.
- **A board column mixes projects, but rank is per project.** Dragging within a
  column asked the vault to rank across projects, which it rightly refused; and
  sorting a column by raw rank compared numbers from different rank spaces, so
  one drag appeared to reshuffle every project. Columns are now grouped by
  project in sidebar order, then by rank inside each, and a reorder attaches to
  the nearest same-project neighbour in the direction of travel.
- **Failed mutations were silent.** `mutate` returned the message but every
  caller passed the result to `void`, so a rejected reorder looked like a card
  that just refused to move. It now surfaces the error as well as returning it;
  the delete flow uses a dedicated helper because there a refusal is a question,
  not an error.

## Phase 2 — as designed

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

## Phase 3 — polish ✅

Built and verified by driving the real app. The agenda screen had already landed
in Phase 1, so what was actually left was Ctrl-K, a real shortcut set, and the
recurring/due-date loose end below.

**Ctrl-K searches the whole vault**, ignoring every filter — that is the only
reason to have it as well as the toolbar box, which narrows the current view, so
the two now say which they are in their placeholders. Matching is plain
substring, not fuzzy: over a few hundred items it is instant, and a fuzzy ranker
that surprises you is worse than one that occasionally needs another word. Words
are ANDed so a second word always narrows. Results rank by where the first term
landed — key, then summary, then category/labels, then description — with done
items sunk and a description snippet shown only when the match is somewhere the
row does not already display.

**Fifteen shortcuts, generated from one registry.** `shortcuts.ts` is read by
both the handler and the `?` overlay, because a hand-written cheatsheet drifting
from the handler is the standard way this feature rots.

**The cursor is not the selection.** The detail panel is `position: fixed` over
the right 520px, so if `j` also opened it, every keystroke would slide a panel
across the list being navigated. `selected` is the highlight and `detailKey` is
what the panel shows; `Enter` promotes one to the other, and an *already open*
panel follows the cursor the way a mail client's reading pane does. This cost no
changes to the three views at all — they already rendered `aria-selected`.

Each view's display order moved into `ordering.ts` so keyboard navigation walks
the order the eye actually sees; the agenda's is built over IPC, so it reports
its visible keys upward instead.

Three things worth remembering, all caught by running it rather than reading it:

- **A flex column will stack a fragment's text nodes one per line.** The palette
  put the summary and its snippet in a `flex-direction: column`, and the
  highlighter returns a fragment — so "Revenue widget double-counts refunds"
  rendered as three rows, split around the `<mark>`, with the mark stretched to
  full width. Inline content inside a flex column needs its own element.
- **The recurring section can only ever show a *later* due date.** `agenda()`
  partitions first: anything already past goes to `overdue`, anything inside the
  window to `due`. So the "also overdue" and plain "due" branches are unreachable
  today. They are kept deliberately, as the guard that stops a change to that
  partitioning from silently restoring the bare unexplained date.
- **`.section-range` is declared after `.due-overdue`**, so a row carrying both
  lost the overdue colour to source order at equal specificity.

## Phase 4 — in-app Claude ⚠️ built, unproven against the real API

Built and driven end to end **except the API call itself**, which needs a key.
See "Handoff: first run with a real key" below for exactly what is and is not
proven, and what to check first.

`apps/desktop/src/main/claude.ts` holds the call, `secrets.ts` the key. The key
is typed into the settings panel, sent to main once, and encrypted with
`safeStorage`; there is deliberately **no getter on the IPC surface**, so the
renderer cannot read it back even to mask it — verified by driving Replace and
watching the input come up empty. `setApiKey` refuses when `safeStorage` is
unavailable rather than falling back to plaintext.

**Structured outputs, not tool-use.** This plan said tool-use; `output_config.
format` is the mechanism for exactly this now and needs no tool loop. The
requirement that mattered — validate against `CreateItemInput` — is unchanged.

**Two schemas, on purpose.** Structured outputs cannot express `max(255)`, the
date regex, or the key format, so a schema derived from `CreateItemInput` would
silently drop the constraints worth keeping. The wire schema covers shape and
enums only; the core's schema stays the sole authority. Both directions of that
contract are checked: three representative drafts validate, and four malformed
ones are still rejected — including `notes` leaking through, which `.strict()`
catches, which is why `stripEmpty` drops it.

`parent` is deliberately absent from the wire schema. Guessing a parent key
invents a relationship the user did not ask for, and the form already has a
picker that only offers legal parents.

The draft is never written. It fills the create form and the user presses
Create — the confirmation step is the feature, not a formality.

Two things worth remembering:

- **The create form had no `labels` or `cadence` field**, but a draft can set
  both. Applying a draft that silently dropped them would have been a real bug,
  so the form gained them. It is now closer to the "built on `CreateItemInput`"
  the Phase 2 note claimed.
- **`effort: "low"` with thinking left on**, rather than thinking disabled.
  Drafting one task is not hard, but disabling thinking on this model is the
  more expensive lever — it can put a tool call or a `<thinking>` tag into the
  visible text, which here would land in the summary field.

## `disregard` — the second way an item can end ✅

A sixth status, for work that is closed because it is not going to happen. The
rules live in SCHEMA.md; what is worth recording here is what the choice cost.

Almost nothing, as it turned out, because `DONE_STATUSES` was already the
abstraction: the `open` filter, the agenda, and both sort comparators read it
rather than comparing against `"done"`, so making it a two-element array closed
every "is this still live" question at once. The renderer was the opposite —
three separate hand-written `=== "done"` checks, which is why it now has one
`isClosed()` reading the core's array.

Two decisions in it:

- **The transitions are looser than `done`'s.** `disregard` is reachable from
  everywhere, `blocked` and `done` included. The rule the existing refusals
  protect is that nothing may claim work that did not happen; choosing not to do
  something makes no such claim, and blocked work is the likeliest candidate for
  it. Sending it back through `todo` first would be ceremony.
- **A board column of its own, not folded into Done.** A column renders only the
  status it names, so a status with no column does not merge into another one —
  it vanishes, silently. Six columns overflow a narrow window and `.content`
  scrolls, which is the cheaper failure of the two.

The Jira side is a mapping, not a feature: `jira-map.example.yaml` gains a
`disregard` transition, commented, because "Won't Do" is the common name for it
and not a guaranteed one.

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

**Recurring items showing a due date outside the window** — fixed in Phase 3.
OPS-2 now reads `↻ weekly · due 2026-07-29 · after this window` under "recurring
this week", so the date no longer looks like it contradicts the heading.

## Handoff: first run with a real key

Everything around the API call is verified; the call itself is not. Nothing has
ever been sent to Anthropic from this app.

**Proven, by driving the built app with no key and then a dummy one:**
status reporting; `safeStorage` encrypt → store → clear round trip (Windows
DPAPI reports available); the settings panel's Save / Replace / Remove; Replace
never revealing the stored key; the create dialog degrading to a plain form with
a "Drafting is off" line; `draftItem` refusing with *"No Anthropic API key is
stored"*, which exercises the whole IPC path into main. The dummy key was
removed afterwards — `hasKey` is false and nothing is left in the keychain.

**Not proven — everything past `client.messages.create`:** that the request is
accepted, that `output_config.format` returns what the schema describes, that
the prompt produces a sensible draft, and how long a call takes.

**First run, in this order:**

1. Sidebar → **Claude** → paste the key → Save. Expect "A key is stored".
2. Press `n`, type something with a relative date and no project, e.g.
   *"chase legal for the signed DPA, high priority, by Friday"*, then Draft.
3. Check the three things most likely to be wrong, in this order:
   - **The date.** Today's date is injected into the system prompt and the model
     is told to resolve against it. A date in the past means that instruction is
     not landing, and it is the failure most likely to go unnoticed.
   - **The project.** With none named it should pick by inference and say so in
     the note; it must be a key that exists.
   - **The note.** Empty every time probably means the field is being ignored
     rather than that nothing needed assuming.
4. Then try a deliberately vague prompt — *"sort out the thing with the invoices"*.
   The interesting behaviour is whether it leaves fields empty and says so, or
   invents detail. The prompt asks for the former; if it invents, tighten the
   system prompt in `claude.ts` rather than adding validation.

**If it fails, the message says where.** The failure branches are deliberately
distinct: a rejected key, a refusal, a truncated reply, a non-JSON reply, and a
draft the vault would refuse each read differently, and the last of those quotes
the core's own field-level complaint.

**Two live risks worth naming.** The model ID is pinned to `claude-sonnet-5` in
one constant, `CLAUDE_MODEL` — if the account cannot reach it, that is a
`PermissionDeniedError` with a clear message and a one-line fix. And nothing
bounds cost: there is no request timeout and no cap on how many drafts a session
can trigger. Fine for one person pressing a button; worth revisiting before this
is ever automatic.

**On the model choice.** Sonnet rather than Opus, because drafting one task from
one sentence is small structured extraction, not reasoning. Haiku 4.5 would be
cheaper again and is a fair fit, but it predates `output_config.effort` and
would 400 on every call until that parameter came out — so switching down is two
edits, not one. The tier to watch is judgement under vagueness: if a vague
prompt starts coming back with invented specifics rather than blank fields and
an honest note, that is the signal to raise `effort` first and change tier
second.

## The risk that stays

Last-write-wins between the app, the MCP server, and an external Claude. Both
writers reload before mutating, writes are atomic, and git makes every version
recoverable — that's the accepted trade in SCHEMA.md and it's the right one for a
single user. The file watcher improves it in practice by making a clobber
*visible* within a second rather than discovered a week later.

The Windows `EPERM` hole is closed. `writeFileAtomic` now retries the *rename*
three times, ~10ms then ~40ms apart — the write is deliberately not retried,
having no such failure mode. `EPERM` is ambiguous: a scanner holding the file
reports exactly what a genuine permissions failure reports, so the retry is kept
short and always rethrows on its last attempt rather than trying to tell them
apart. `isTransientRenameError` is exported and tested; a real lock is not
simulated, because doing so on Windows is flaky, and that is the honest coverage
boundary.
