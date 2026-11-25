# Plan: the Electron desktop shell

Stack is decided: **Electron**. This started as the plan for the desktop shell
and has become the log of what was built and why each call was made.

**Phases 0 through 4 are complete**, plus the run of smaller features recorded
below them. The suite is at 252 green tests as of 2026-09-29 — 127 in the core,
81 over the app (ordering, selection, navigation, links, history formatting,
theme and colour tokens) and 44 over the scripts in `scripts/`. The counts in
this paragraph have drifted before; CI now runs the suite on every push, so a stale number here is a documentation lapse
rather than an untested claim.
**Phase 5, the Jira push UI, is the only phase left**, and it carries
`vault jira discover` with it.

Two other documents hold work this one does not: `PLAN-LINKS.md` designs
OneDrive-aware links, of which the first half has shipped, and `IDEAS.md` holds
what has not been scheduled. Ideas are promoted out of it into sections here.

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

The example vault is seeded by `scripts/seed-vault.ts` (12 items, 2 projects at
this point, every link type, both attachment modes) and `doctor` reports it
clean. The seed has grown since, and now emits 3 projects and 15 items.

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
  *Since superseded in one mode:* the **Group by project** toggle draws that
  grouping as bands, and inside a band every card shares a project, so the walk
  finds the drop target itself on its first step. The same-project search is kept
  because ungrouped columns still interleave, and one code path that is exactly
  right in both modes beats two.
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
from the handler is the standard way this feature rots. (Twenty-two now:
collapse added `h`/`l`, zoom added a Display group, and the board's `g` joined
it. The registry earning its keep is the point — every one of those seven
appeared in the overlay for free.)

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

## Phase 4 — in-app Claude ✅ verified against the real API

Built and driven end to end, including the API call itself: a real key was
entered and a draft was successfully requested and returned. See "Handoff:
first run with a real key" below — the call path is now proven, but the
specific checks that section calls out (date resolution, project inference,
vague-prompt behaviour) were not individually verified and are worth a look
if drafting ever produces a surprising result.

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

## Openable `file` and `folder` links ✅ — the first half of `PLAN-LINKS.md`

Steps 1 and 2 of that document's build order, which it says are worth landing on
their own. `file` and `folder` links rendered as dead text and attachments only
*revealed* in Explorer; both now open, through a single `openTarget` channel in
main.

The scheme allowlist came first, because it closes a live hole rather than adding
a feature: `setWindowOpenHandler` passed anything to `shell.openExternal`, and a
description or a link target can be written by an external Claude or by Notepad.
The link form now refuses a scheme off that list while you are still looking at
it, rather than storing one that could never be followed. Attachments keep an
extension refusal list on top, since opening is a stronger act than revealing.

**Steps 3–5 are not built** — `classifyLinkTarget`, `syncedRoots`, and the
OneDrive routing on drop. That is the half that actually prevents a synced
document being copied into `attachments/` and quietly forking, and `PLAN-LINKS.md`
is explicit that 3 alone would look finished and prevent nothing.

## Descriptions render as markdown, and edit as formatting ✅

An item's description *is* the markdown body of its file, and the create dialog
says so, but the panel passed it to `EditableText`, whose read mode is a button
holding the raw string — so every newline, bullet and heading collapsed the
moment you clicked away. The formatting survived on disk and survived a push to
Jira; it disappeared only where you read it.

**The grammar was not an open question.** `markdownToAdf` already defined which
markdown this project honours, so rather than a second, subtly different parser
for the renderer, it moved into `description.ts` — import-free, read by the app,
the ADF converter and the editor's schema alike. The panel cannot show, and the
toolbar cannot produce, formatting the push would drop.

**The risk this is built around is the round trip, not the editor.** These files
are written by things that are not this app, and `--git` commits every write, so
an editor that normalised on the way out would restyle prose its author wrote
deliberately and fill the history with commits nobody typed.
`isLosslessDescription` asks whether this exact text survives a parse and a write
byte for byte; only then is the rich editor offered, and anything else opens in a
plain markdown box saying why. Lossless or plain text, never lossy.

One deliberate departure reaches Jira: a newline inside a paragraph is a break
rather than a soft wrap, in the app and in the ADF alike, because people type
descriptions in a box and mean the line breaks they put there.

Three things only driving it caught, all of them collisions with a host element
rather than with the grammar: TipTap binds Mod-Enter to `hardBreak`, so Ctrl+Enter
deleted the selected word before the save handler ran — the three keys this field
claims are taken during capture now; a `<label>` around the field forwarded a
click on the prose to the source toggle, because a contenteditable is not a form
control and there was nothing else for the label to point at; and a selection that
took the trailing space with the word wrote `**bold **text`, which our parser
reads and CommonMark rejects. The space belongs to the sentence, not to the mark.

## Zoom, owned by the app rather than by Electron's default menu ✅

Ctrl+`−` zoomed out and Ctrl+`=` did nothing, which reads as a broken app rather
than an undiscovered chord. Neither key was ours: the default menu is still there
behind `autoHideMenuBar`, and its `zoomIn` role binds `CommandOrControl+Plus` — a
character a US layout only produces with Shift held.

`zoom.ts` claims the keys in main via `before-input-event`, which is what lets
them work with a text field focused; `preventDefault` also suppresses the menu's
own accelerator, so Ctrl+`−` is not applied twice. Both the physical `code` and
the produced `key` are matched, so layouts that move plus and minus still work.
The level is clamped to 58%–207% — past the ceiling the 900px minimum window
width starts clipping the board — saved to `settings.json` debounced so
auto-repeat does not hammer the file that also holds `vaultRoot`, and reapplied
on load, since Chromium keys its own zoom to a host and neither `file://` nor
localhost carries one worth trusting.

## Recurring work completes with a tick, not a status change ✅

Recurring items did not recur. `cadence` was a static tag that nothing read to
generate a next occurrence, and `agenda()` filters to open items, so marking a
daily task done removed it permanently. The only pattern that worked was leaving
recurring items in `todo` forever — which meant no record of whether the thing
was ever actually done.

That record had nowhere durable to live. The file carried `status`, a single slot
holding the current state rather than the fact that a completion happened, and
`updated`, which every edit bumps. Git was the sole history, and it is
deliberately optional here; even with it on, `updateItem` committed the literal
string `Update ${key}`, so a completion was indistinguishable from fixing a typo.

So completions live in the item's own frontmatter and status is left alone. **A
tick is not a transition**: `done` still means retire this item, which is right
when you drop a habit and wrong when you perform one. `tickItem` is idempotent,
because a double-click on a checkmark should not be a failure state, and
`untickItem` exists because a checkmark with no undo is a trap.

**The agenda rule is the part worth stating.** An item drops out of a window when
it is ticked for its current period *and* that period runs to the end of the
window. The simpler rule — ticked means hide it — is wrong in a way that is easy
to miss: doing today's daily task would empty the weekly agenda of it too, even
though it comes round again tomorrow, well inside that window.

Period arithmetic moved to `recurrence.ts`, which imports nothing, for the reason
`constants.ts` and `description.ts` are shaped that way: the renderer decides
whether to draw a row as ticked, and taking that from `util.ts` would pull
`node:fs` into a browser bundle. Reimplementing it renderer-side was the
alternative, and a tick the agenda and the UI disagree about is worse than no
tick. `completions` is absent from `pushableFields`, so a tick never marks a
pushed item as drifted.

The checkmark is in the agenda and the detail panel, **not on board cards**:
those sit inside a dnd-kit draggable, where a nested button competes with the
drag handler for the pointer. The cadence pill shows ticked state everywhere
instead, so a card still says whether this week's report is handled.

## Collapsing a subtree in the backlog ✅ built and driven

Promoted out of IDEAS.md. Renderer-only: no schema change, no IPC, nothing on
disk. Collapse is view state, the same as the toolbar filters, and is forgotten
when the window closes — an item's file never learns it was folded shut.

`backlogOrder()` had already done the hard half, so the change inside it is four
lines: a `collapsed` argument, and a `return` before the recursion.

**The set lives in `App.tsx`, not in `BacklogTable`.** `App.tsx` calls
`backlogOrder` a second time to build `orderedKeys`, the list `j`/`k` walk, and
the comment above it already stated the rule — a cursor stepping through a
different order than the eye sees is worse than no cursor at all. A table hiding
rows privately would turn every collapsed subtree into a stretch of the keyboard
walk where the highlight is off screen. So the set is passed into both calls,
and it holds keys rather than row indices, because the array is re-derived from
a fresh snapshot on every write.

**Collapse hides the children of a *visible* parent, and only that.**
`backlogOrder` promotes a child to a root when its parent is not in the filtered
set, precisely so nothing disappears silently; a collapsed key that is itself
filtered out must therefore not reach through and hide its children anyway. The
check sits inside `walk()`, on an item that has just been emitted, which gives
this for free — the line never runs for a parent that was never emitted. That is
why it is not a filter over the finished array, and it is the one rule here
worth a test.

**The cursor comes up to the parent** when the subtree it was inside closes.
Leaving it means the next `j` resumes from a row nobody can see. Whether it is
still visible is asked of `backlogOrder` itself rather than re-derived from
`parent` links in the handler: one answer to the question, and it cannot
disagree with what the table drew.

Two smaller calls, both from the idea doc:

- **A twisty only where there is something to collapse**, which `childrenOf`
  already knows — so `backlogOrder` returns `hasChildren` per row instead of the
  table asking a second time. Childless rows get a blank of the same width; the
  alternative is sibling summaries starting at two different offsets.
- **`h`/`←` and `l`/`→`**, pairing vim and arrow keys the way `j`/`k` already
  do. A row with no children is left alone rather than added to the set: it
  would hide nothing today and quietly hide something the day it gains a child.

Nothing prunes keys whose items have gone. A stale key matches nothing, and
keeping it means a subtree filtered out and then back in returns the way the
user left it.

**This gave the desktop app its first tests.** `ordering.ts` is pure, so seven
cases run under `node:test` via `tsx` — the same setup the core package uses,
no new runner. They cover the nesting rule above, which is the part that would
be easy to break later and impossible to notice. `tsconfig.test.json` is a third
pass rather than an extension of `tsconfig.web.json`, because that config sets
`"types": []` on purpose: renderer code must not see node's globals, or an `fs`
import into a browser bundle typechecks cleanly. Root `npm test` now runs every
workspace instead of only the core.

**Driven in the real app**, against the demo vault under an isolated
`--user-data-dir`, which is worth doing this way: the app remembers its vault in
`userData/settings.json`, so a driver that does not override that path opens
whatever real vault was last used. Twenty-five checks, including the two the
unit tests cannot reach — that clicking a twisty does not also select the row or
open the panel, and that `j` from a collapsed parent skips the rows underneath.

The one thing driving it caught was the twisty itself, and it was invisible to
every other kind of verification. At `font-size: 9px` in `--text-faint` it was
an 11×9px target rendering as roughly four pixels of ink — on screen it read as
dust on the display, not a control. Two separate mistakes:

- **Size.** A backlog row is 36px with a 22px content box, so the button now
  takes 16×20px of that and *nothing moves* — the row height is identical
  before and after. There was never a reason for the target to be small.
- **The codepoint.** `▸`/`▾` are the U+25B8 *small* triangles: most of their em
  is whitespace, so they need ~16px to carry the weight `└` carries at 12.5px.
  The full-size `▶`/`▼` look right at 11px, but they have emoji presentation
  variants and can arrive as a colour emoji on a machine whose font stack
  disagrees — so the small ones stay, at a larger size.

The other open question answered itself: the cursor coming up to a collapsing
parent reads as correct, not as the list moving, because the row it lands on is
the one just clicked. It also holds two levels deep — collapsing a grandparent
with the cursor on a grandchild lands on the grandparent.

## A type filter, on the backlog and the board ✅ built and driven

Promoted out of IDEAS.md. Renderer-only, like collapse: view state beside the
other toolbar filters, forgotten when the window closes, nothing on disk.

The mechanical half is one line in `filtered` — `if (types.size &&
!types.has(item.type)) return false;` — and that one line covers the board, the
backlog *and* the keyboard cursor, because `orderedKeys` is derived from the
same array.

**The filter means "show only these types", in both views.** The idea doc left
this open, expecting the board to want that reading and the backlog to want
"these types plus whatever ancestors place them". Three things settled it the
other way:

- **Neither use case that motivated the feature hits the problem.** Epics have
  no parents to lose, so "epics only" is a flat list either way. Subtasks are
  leaves, so "everything except subtasks" prunes without disturbing the tree at
  all. The flattening only bites when filtering to a *middle* type, and "show me
  the tasks" is a worklist request, not a structural one.
- **The backlog already flattens under a filter, and has since Phase 1.** Turn
  on "Hide closed" with a done epic and its children are promoted to roots by
  the same rule. Type filtering does not introduce the behaviour; it makes an
  existing one easier to notice.
- **The alternative puts rows on screen that do not match the filter**, which no
  other filter here does. That is a real cost, paid in every view, to rescue a
  case neither user story asks for.

Both halves of that ruling are now tests in `ordering.test.ts` — one asserting
the flattening happens, one asserting that excluding a leaf type leaves the
hierarchy standing. They assert nothing new about the code; what they add is a
name, so the flattening reads as a decision rather than as a bug someone finds
later and fixes.

**Toggles, not a select**, because "everything except subtasks" is one of the
two things worth asking for and a select cannot say it. Five chips styled as a
sibling of `.tabs`, since the toolbar should have one idiom for "a row of small
toggles". They are `aria-pressed` buttons in a `role="group"`, not a tablist:
selection is not exclusive here, and `aria-selected` would tell a screen reader
that it was.

**Empty means every type.** Starting with all five on and letting the user
deselect would make "no filter" unrepresentable and put an empty view one click
away. Empty-means-all makes the unfiltered state both the default and the place
turning the last chip off returns to.

**It is deliberately absent from the dangling-filter recovery** in the effect
above `filtered`, and the comment says so, because its absence otherwise reads
as an oversight. That effect exists because the project and reporter menus are
derived from the items, so an option can vanish under a live filter. `ITEM_TYPES`
is a constant; these cannot dangle.

**Driving it caught the one thing nothing else could**, the same way the twisty
was caught above. Every check passed and the control was still wrong: with all
five chips off — the state every user meets first — the group was five unadorned
words sitting in a row of bordered selects, and it read as a caption rather than
as something you could press. The tabs get away with a bare trough only because
one of them is always raised out of it; a group where *none* may be on has no
such anchor. One `1px solid var(--border)`, the same border the selects carry,
and it reads as a control. That border is load-bearing, not decorative.

Driven against the seeded vault under an isolated `--user-data-dir`, for the
reason recorded above — eleven checks, including that a chip click moves neither
the keyboard cursor nor the detail panel, that the chips are absent on the
agenda, and that the group sits level with the selects beside it. Also
screenshotted in both colour schemes: this machine reports
`prefers-color-scheme: light`, so the dark on-state would otherwise have gone
unlooked-at on the strength of `--accent-dim` being defined in both blocks.

## The detail panel's related items carry the status colour ✅ built and driven

Promoted out of IDEAS.md. `StatusPill` was already the one place a status
becomes a colour, and every view used it except the one screen devoted to a
single item's relationships: Children drew the lozenge without the `.dot`, and
Links and "Linked from" carried no status at all.

Children and backlinks were free — `getRelated` already hands back full `Item`s.
The Links section is where the decision was, because `item.links` records a key,
not an item.

**Statuses for `item` links are resolved in main, against the whole vault.** The
renderer looked like the obvious place and is the wrong one: `ItemDetail`'s
`items` prop is `visibleItems`, which drops hidden projects, so a link pointing
into one would resolve to nothing and the absent pill would read as "no status"
rather than "not shown here". `vault-service` holds the vault unfiltered, and
this is the precedent `backlinks` already set — `vault.backlinks()` does not
filter hidden projects either, so this panel could already name an item the rest
of the window says is not there.

So this panel shows relationships across a boundary every other view honours.
That is now chosen rather than inherited, and it is paid for on screen: a row
whose key is not in `items` gets a `not shown here` note. Clicking such a row
still closes the panel — `App`'s `gone(detailKey)` recovery drops a selection
outside `visibleItems` — and that papercut predates this and stays. The note is
what makes it legible before the click rather than after it.

**Three states, because collapsing any two of them lies.** `getRelated` returns
`Record<string, Status | null>`, and `RelatedStatus` reads it as:

- `undefined` — the round trip has not answered. Not a hypothetical: the panel
  renders before the IPC lands, so treating "no status" as "deleted" flashed
  `missing` on every open.
- `null` — answered, and the target is gone. `addLink` validates the target
  exists and `doctor` checks for dangling item links anyway, because deleting
  the other end still happens; the row says `missing` rather than leaving a
  pill-shaped hole.
- a `Status` — the pill, in the same colour every other view uses.

One component for all three sections, so they cannot drift apart on what a
missing or an out-of-window target looks like. The two questions have different
sources on purpose — the status from main, which holds everything; `inWindow`
from the `items` prop, which is what this window admits exists. Same split the
parent field makes with `offProject`.

**No CSS.** `.link-row` is a left-packed flex row with no `margin-left: auto` on
`.clear-btn`, so the pill drops into the existing gap; `.row` already ends with
a pill everywhere else; `.field-note` already existed.

**Driven in the real app** against a fixture vault holding all three cases at
once — five children in five statuses, a link to a deleted item, and a link plus
a backlink into a hidden project. Worth recording how, because the usual recipe
did not apply: `playwright-core` is not installed, so instead of
`_electron.launch` the driver spawns Electron with `--remote-debugging-port` and
speaks CDP over Node's global `WebSocket`. No new dependency. The isolated
`--user-data-dir` is still the load-bearing part, and it doubles as the way in:
seeding `settings.json` under it points the app at the fixture vault without
touching the first-run picker.

Building that fixture turned up a rule worth knowing: **`project hide` refuses
while any item is open**, so a hidden project reached by the normal path only
ever contains closed work. The `in_progress` item behind the curtain had to be
closed, hidden, then reopened via the CLI — which is exactly the cross-boundary
write the parent field's `offProject` comment already describes.

## The board groups into one band per project ✅ built and driven

Promoted out of IDEAS.md. Renderer-only, like collapse and the type filter: view
state behind `g`, forgotten when the window closes, nothing on disk.

A board column mixes projects, and Phase 2 records the two bugs that came of
that — ranks compared across projects, and a drag that appeared to reshuffle
everything. The fix there was to *sort* by project inside each column. This is
the same information drawn as structure instead: `boardLanes` returns a list of
bands, each a full row of status columns, and the grouped board renders one per
project in sidebar order.

**One function for both modes, and it is the same one `orderedKeys` calls.**
Ungrouped is an early return — a single lane, `project: null`, holding the
columns the board already drew — so the flat board is now a special case of the
grouped one rather than a second code path. That matters because `App.tsx` calls
`boardLanes` again to build the keyboard order, and the rule the collapse work
set still holds: the cursor walks the order the eye sees, and the only way to
guarantee that is for there to be one answer to what the order is.

**Grouping turns that order from status-major into lane-major**, which is the
whole point of the flattening being derived rather than written twice. With
bands on screen, walking every project's To do column before any project's In
progress column would send the cursor back up the page. There is a test for
exactly this, because it is invisible until someone presses `j` eleven times.

**`project: null` rather than a sentinel key** for the ungrouped lane. It is the
one value a project key can never be, so nothing downstream has to know which
made-up string means "all of them" — and `laneAllows` reads it directly: a null
lane accepts any card, a named lane accepts only its own project's.

**A project with no cards in the filtered set gets no lane.** "Hide closed" is a
filter and it is on by default, so the alternative is a screen of empty bands
with the real cards buried among them. An *unknown* project still gets one, at
the end, sorted among its fellows — `boardColumns` already refused to drop a
card whose project the sidebar does not know, and a lane that silently swallowed
one would break the same promise.

Three things worth remembering:

- **The lane header counts its own cards, not the project's open items.**
  `ProjectSummary.openItems` is computed over the whole vault *and* counts only
  open work, so it disagrees with the cards under it in two directions at once —
  with Hide closed off, a band of twelve headed "7".
- **`--columns` is set from `BOARD_ORDER.length`, not written as `6` in the
  CSS.** The status names are drawn once, sticky, above the lanes — and the
  header row and every lane are *separate* grids, because a sticky element
  cannot escape its own grid area and one big grid gave it nowhere to travel.
  Separate grids have to be told the same track count or the names stop sitting
  above the columns they name, so `BOARD_ORDER.length` feeds both. This is the
  third place `BOARD_ORDER` has turned out to own something (see `disregard`,
  and `pieces.tsx`'s note about vanishing cards); the "Scheduled" idea in
  IDEAS.md prices a seventh status against it.
  *Found while writing this up:* the comment at that line said a seventh status
  would wrap the extra header cell onto the lanes' row, which two separate grids
  cannot do. Corrected in place — the reason is real, the mechanism was not.
- **The intra-column reorder walk was left exactly as it was.** Grouped, every
  card in a lane shares a project, so the search for the nearest same-project
  neighbour finds the drop target on its first step and reduces to "after the
  card you dropped on". Ungrouped columns still interleave, so the walk is still
  load-bearing there. One path that is exactly right in both modes beats two,
  which is the same call Phase 2 recorded making.

**`g` is gated on the board** rather than bound globally. It is the only view
with lanes, and a key that silently changes something two views away is worse
than one that does nothing. It appears in the `?` overlay for free, under
Display — the registry earning its keep for the sixth time.

**Eleven tests**, which is why the desktop suite went from nine to twenty. They
cover the two claims nothing else could check: that every item appears exactly
once whether grouped or not, and that grouping is what turns the keyboard order
lane-major.

## Starting something date-stamps it ✅ built

Promoted out of IDEAS.md. `startDate` was stored, editable and pushed to Jira,
and nothing ever wrote it except a person typing into the detail panel. Nobody
types the date they started something on the day they start it, so the field was
empty on exactly the items being worked — which is what made it useless as the
filter the "Scheduled" idea still wants it to become.

**The rule lives in `updateItem`, and that is the whole implementation.**
`transition()` is a one-line delegation to it, so the board drag, the detail
panel's status control, `vault done`/`vault disregard` and
`vault_transition_item` were never the risk. The risk was the callers that skip
`transition` entirely and patch `status` directly: `vault_update_item` and
`vault set --status`. A rule written inside `transition` would have looked
complete while missing both — the two least likely to be checked by hand. The
desktop `vault:update-item` IPC is a third, latent: it passes `patch: unknown`
through unfiltered, so nothing but `UpdateItemInput` stops a status arriving that
way, and now it would be handled if one did.

**Any move into `in_progress`, not `todo → in_progress`.** `TRANSITIONS` reaches
`in_progress` from every other status, and `todo → blocked → in_progress` is the
ordinary shape of picking up work that was waiting on somebody. The narrow rule
never fires there and leaves the item in progress with no date, which is the case
it exists to fix. "Unless already set" makes the broader rule identical
everywhere else.

**Skipped, not clamped, when it would collide with `dueDate`.**
`ItemFrontmatterSchema` rejects `startDate > dueDate`, and it refines the merged
object, so stamping an overdue item would fail the whole write — including the
status change — and blame two dates the user never typed together. Dragging an
overdue card into In Progress worked before this and still does. A convenience
must never be why an action fails, so it yields. The cost is honest and worth
stating: the items likeliest to be started late are the ones this does nothing
for. Due *today* still stamps, since the check is strict `>`.

**Creation too**, because `CreateItemInput.status` takes any status and there is
no transition to hang the rule on. `vault new --status in_progress` is the only
live route in — `vault_create_item` has no `status`, the desktop dialog sends
none, and `DRAFT_SCHEMA` has neither `status` nor `startDate` — but discovering
that gap later would have been worse than closing it now.

Two writers were left alone deliberately. `restoreItem` and `rekeyItems`
re-serialize frontmatter straight through `writeAndIndex`, carrying `status`
verbatim, so an item trashed while `in_progress` comes back untouched: restoring
is not starting, and renaming a project is not either.

**It drifts pushed items, and that is now safe.** `startDate` is in
`pushableFields` while `status` and `rank` are not, so this is the first time a
plain status change can flip an item to `drifted`. Investigating this idea is
what turned up why that used to be dangerous — `buildPushPlan` checked only
`state === "pushed"`, so a drifted item was re-drafted as a duplicate issue with
no warning. That is fixed separately, and it was a prerequisite rather than a
side note.

`todayIso()` is local-time, built from `getFullYear`/`getDate`, so a late-evening
start records today rather than tomorrow. It takes the date as a parameter for
the same reason `tickItem` does.

One limit accepted rather than engineered around: `updateItem` clears fields by
mapping `null` to `undefined`, so "no `startDate`" cannot distinguish "never had
one" from "deliberately emptied". Clear it, cycle through `blocked`, and it comes
back. The rule reads the *merged* value, so at least clearing it and moving in
the same call does not immediately refill it.

## Links count as drift, and the check moved down a level ✅ built

Found by auditing IDEAS.md against the code rather than by using the app, which
is worth saying because it was invisible from the outside: nothing failed, an
item simply stayed silent when it should have spoken up.

`buildDescription` puts every one of an item's `links` into the Jira description,
under a `## Links` heading — that is what `PLAN-LINKS.md` gotcha 12 meant by
"links are pushed". But `pushableFields`, which is the hash deciding whether a
pushed item has drifted, omitted `links` entirely. So adding a link to a pushed
item changed what Jira *should* hold and changed nothing the plan could see:
`buildPushPlan` read it as "Already pushed as ENG-412 and unchanged since" and
skipped it. Not a wrong answer on screen — no answer at all.

That also made `SCHEMA.md`'s flat claim that "`contentHash` covers only the
fields that actually get pushed" false in exactly one case, which is the kind of
sentence that stays trusted precisely because it reads as a definition.

**IDEAS.md had this backwards and now says so.** Its caution paragraph told the
next reader that `PLAN-LINKS.md` was wrong about links causing drift and to
"check the field list rather than the prose". The mechanism it describes is
right and the conclusion was not: the field list was the thing that was wrong,
and the prose it warned against was describing correct behaviour that had never
been implemented.

**Links are flattened to strings before hashing, and this is not a style
choice.** `contentHash` hands `Object.keys(input).sort()` to `JSON.stringify` as
the *replacer* argument, and an array replacer filters object properties at
every depth, not just the top. Raw link objects would have hashed as
`[{"type":"url"}]` — `target` and `label` dropped, `type` surviving only because
it collides with the top-level field of the same name. The naive version
typechecks, passes a test that changes a link's type, and detects nothing else.
Every other value in `pushableFields` is a primitive or an array of strings,
which is why this never came up before; a comment now says so, because the next
field added there will face the same trap.

**Not sorted, unlike `labels` and `components`.** The footer renders links in
array order, so their order is part of what reaches Jira.

**The check moved from `updateItem` into `persist`, and that is most of the
value.** `addLink` and `removeLink` build the next item themselves and go
straight to `persist` — they never pass through `updateItem` — so the hash fix
alone would have left the *label* saying `pushed` while the plan correctly
re-drafted the item. Two surfaces disagreeing is worse than one being wrong.
`persist` is the funnel Phase 0.5 built for exactly this reason, and the
argument is the one the `startDate` rule already made: a rule one level up looks
complete while missing the writers least likely to be checked by hand.

Moving it is safe in a way worth recording rather than re-deriving. Of
`persist`'s ten callers, `createItem` carries `state: "never"`, `tickItem`,
`untickItem`, `addComment` and `moveItem` touch nothing pushable, and
`markPushed` re-hashes the item it just stamped and finds it equal. The two
writers that reach `writeAndIndex` directly stay excluded on purpose: respacing
only rewrites `rank`, and `rekeyItems` is a project rename, where a local key
changing is not a claim about Jira's copy.

**`addAttachment` is the tenth caller, and it is deliberately left alone.** It
looks like the same shape as links — `buildPushPlan` carries an `attachments`
list, so attaching a file to a pushed item does change what a push would do —
but the resemblance stops at the surface. Links are *content*, rendered into a
description field that a re-push overwrites; attachments are uploaded by a
separate call that appends, so an item marked `drifted` for a new attachment
would be telling the user Jira is stale while offering a remedy that duplicates
every file already up there. Making that honest needs a push that can upload
attachments incrementally, which is Phase 5's problem. Recorded here so the
asymmetry reads as a decision rather than as the same oversight left half-fixed.

Still one-way. Nothing moves `drifted` back to `pushed`, because only a real
push can say Jira has caught up — and `buildPushPlan` already compares hashes
rather than trusting the label, so a reverted item is skipped correctly despite
reading `drifted`. The detail panel's stale pill is unchanged, and is still
IDEAS.md's to fix.

**Four tests.** A link added after a push drifts the item and reaches the plan's
warnings; retargeting a link drifts it; relabelling one drifts it while leaving
the stored baseline hash alone. Those middle two exist because the replacer trap
is exactly what a careless fix falls into, and it passes a test that only ever
changes a link's type.

The fourth guards the other direction, and is the one that would fail silently
years from now. Moving the check into `persist` means it runs *before*
`writeAndIndex` parses, while `markPushed` stamped a hash of an already-parsed
item — so the two agree only as long as nothing in `LinkSchema` defaults or
transforms. Nothing does. If that ever changes, every pushed item carrying a
link would read `drifted` after any edit at all, and a test asserting that a
comment and a reorder leave a linked, pushed item alone is what says so out
loud. The suite is at 84 — 64 in the core, 20 over the app's `ordering.ts`.

## `doctor` checks that attachments resolve, and the tool descriptions name synced storage ✅ built

Two entries from IDEAS.md, picked up together because both are the same failure
shape — something recorded in a way that cannot be queried, or recorded and then
silently untrue — and both were small enough to need no external instance, no
schema change, and no new design decision.

**`doctor` gained a third check.** Beside the existing dangling-parent and
`link.type === "file"` checks in the `doctor` loop (`cli.ts`), a new loop over
`item.attachments` calls `vault.resolveAttachment()` and `fs.access()`s the
result, reporting the item key and the stored POSIX path — not the resolved
native one — when it fails. What this proves is narrower than it sounds: a
passing check means the file at that path exists, not that it is the *right*
file. A `copy: true` attachment silently replaced by a same-named file passes
just as cleanly as one that was never touched. Content is not verified, only
presence.

**The loop that check runs in was also capped at 500 items,** silently, since
`vault.listItems({ limit: 500 })` is bounded by `ItemFilter.limit`'s `.max(500)`
(`schema.ts:317`) while the `doctor` usage line promises "Validate every file and
report problems" (`cli.ts:47`). Fixed by paging with the `total` that `listItems`
already returns, stopping when `offset >= total` or a page comes back empty —
the latter guard is what keeps this from looping forever if the two ever
disagree, which they shouldn't but cost nothing to guard against. Only the
cross-reference checks were capped; parse errors come from `load()` and always
covered every file. The fixture vault is 15 items, so this is verified at
fixture scale, not at 500.

**The two MCP tool descriptions (`vault_link_item`'s `url` line,
`vault_attach_file`'s `copy` line) now name OneDrive, SharePoint, Google Drive,
and Dropbox explicitly,** and `SCHEMA.md`'s Links section carries matching
wording plus a one-line note that share URLs with `?e=`, `?d=`, or
`guestaccess.aspx` are capability URLs a `--git` vault with a remote will
happily commit. This does not contradict `PLAN-LINKS.md` gotcha 3, which
concludes the CLI, MCP tool descriptions, and `SCHEMA.md` table "need no
changes" — that ruling is about the *schema*: storing OneDrive as `type: url`
requires no format change, and still doesn't. This edit is not a schema change;
it exists because a model given no instruction writes the URL into the
description body instead, where it cannot be queried. Guidance, not a guard —
the guard is `syncedRoots`, and it stays unbuilt (`PLAN-LINKS.md` build steps
3–4). IDEAS.md's OneDrive entry is trimmed to record only what remains.

No test file changes. `doctor`'s two existing sibling checks were untested
CLI-level behaviour before this, and stayed that way — verified by driving the
command against the fixture vault instead.

## Bulk edit in the backlog ✅ built and driven

Shaped in its own working document rather than filed as a phase, because there
were real decisions in it. That draft was never committed, so this section is
the record of it. Scope, settled up front: status, assignee, reporter,
priority, due date and labels, in the backlog table only, under one git commit
per batch.

**The write happens in one place in the main process, not a renderer loop over
`updateItem`.** The obvious implementation already exists as a pattern — `useVault`'s
undo path loops `updateItem` over a list — and looks free. Twelve items on that
path costs twelve of each of: a `vault.load()`, a `git add -A` plus `git commit`
subprocess pair, another `load()`, a whole snapshot pushed at the renderer, and a
React re-render, with the chokidar watcher firing throughout. `writeAndIndex` is
private, so assembling a batch from the app side was never on the table — it has
to live inside `Vault`, which is the fact that shaped everything else.

**Two passes, because there is no rollback.** `writeFileAtomic` is atomic per
file only, and a throw partway through a loop would leave the earlier files
written with nothing to undo them. `Vault.updateItems` builds and validates every
candidate in memory first — nothing touches disk until the whole set is known to
be acceptable — then writes every candidate and commits once. A genuine I/O
failure partway through the write pass still commits whatever reached disk before
rethrowing, so a crash mid-batch cannot leave written files outside the audit
trail `--git` exists to provide.

**`updateItem` and `updateItems` now share one `mergeUpdate` step**, pulled out of
the old `updateItem` body: the patch parse, the transition and parent checks, the
field merge, and the `in_progress` start-date stamp. A copy would have passed
review and then silently stopped stamping `startDate` the next time that rule
changed; sharing it means the bulk path cannot drift from the single-item one on
any of the four.

**The status control offers only the intersection of what every selected item can
legally reach, not a raw list of every status.** A selection holding a `todo` and
a `done` item does not have "the legal moves"; it has an intersection, which can
be empty. `commonTransitions` builds this on `canTransition` rather than
intersecting `legalTransitions` arrays directly, so that an item already at the
target status is never the reason the whole set is refused — "set everything to
done" must not choke on the one item that already is. Driving it turned up a
fact worth recording rather than changing: `disregard` is reachable from every
other status in `TRANSITIONS`, so the intersection can never actually come up
empty through this UI today — the fully-disabled state is correct and
unit-tested, just not reachable with the current transition table. Left as is;
narrowing `TRANSITIONS` to make the disabled state reachable would be solving a
problem the feature does not have.

**Labels take a `mode` — add, remove, or replace — instead of the whole-array
replace `UpdateItemInput.labels` uses everywhere else.** For one item at a time,
replace is fine: the detail panel shows you the current list while you edit it.
For twelve it is almost never what is meant — "add `blocked-on-legal` to these
twelve" would otherwise silently drop every label the twelve already had. The
patch resolves per item, into a plain array, before `mergeUpdate` ever sees it —
so `UpdateItemInput` is untouched and the CLI and MCP server do not inherit set
arithmetic nobody asked them for. Duplicates fold on add and replace; removing a
label an item never had is a no-op, not an error.

**The checked set is a third notion of "which item", beside the keyboard cursor
and the detail panel, and deliberately so.** Folding it into the cursor would
mean every `j` throws away a twelve-item selection, which defeats the cursor's
whole job of moving freely. It is pruned against `visibleItems`, not against the
filtered view: a bulk edit routinely pushes its own targets out of the filtered
table — set twelve items to `done` with "Hide closed" on and they all vanish from
the rows on screen — and the selection has to survive that rather than being
silently discarded as a side effect of the edit that just ran. Where the two
diverge, the bar says so: "12 selected — 3 not shown here."

**`Escape` gained a first rung.** It already closed the detail panel, then
cleared the cursor. A checked selection now clears before either of those, the
same order Gmail and Finder use — otherwise dropping a twelve-item selection
costs as many `Escape`s as the panel does.

**`Space` was free to take.** `x` already means delete, so the Gmail/Linear
convention of `x` for toggle-selection was never available here. `Space` toggles
the row under the cursor; `Shift+J`/`Shift+K` move the cursor while extending the
selection from an anchor, arriving as plain `"J"`/`"K"` since the existing
keyboard gate excludes Ctrl/Meta/Alt but not Shift, so the gate itself needed no
change.

**No MCP or CLI surface for this, yet.** An agent that wants to update a dozen
items can already call `vault_update_item` a dozen times, and pays a dozen
commits for it. Recorded as an asymmetry rather than assumed away — see the list
in the README.

**Left alone deliberately: board and agenda multi-select, bulk delete, bulk
move-to-project, and bulk tick.** The board's cards are already dnd-kit
draggables and droppables; layering checkbox selection over that is a second
design problem, not a second checkbox, and is worth revisiting once the backlog
version has been lived with. `moveItemsToProject` re-keys the whole subtree, so
every key in a bulk selection would go stale the moment the first call in a batch
returned — the same objection `README.md` already raises against letting a stray
drag re-key an item, just at bulk scale, and bulk delete is technically easy
enough that it is excluded for the same reason rather than a separate one.
Ticking is per-cadence and per-period, so a mixed selection has no single
meaning for it.

Driven against a freshly seeded vault under an isolated `--user-data-dir`, over
CDP rather than `playwright-core` (not installed): a shift-click range checks
exactly the rows between two clicks, in both directions, and a collapsed
parent's hidden children are never included even when the range spans past them.
A `todo`/`in_progress` mix narrowed the status control to the two statuses both
can reach; a fourteen-item batch landed as exactly one commit. `Escape` cleared a
live selection before it touched an open detail panel, and only closed the panel
on the second press. Turning on "Hide closed" and bulk-closing two open items
reported how many were no longer visible rather than letting them vanish with
nothing on screen explaining why. The keyboard cursor sat on the same row after
the batch edit that it sat on before. Screenshotted in both colour schemes.

The suite is at 96 — 69 in the core, 27 over the app's renderer logic, the newest
of them `selection.ts`'s range and status-intersection functions for the same
reason `ordering.ts` has its own: this is renderer logic where a wrong answer is
invisible, and the wrong rows would simply be selected with nothing on screen
looking broken.

## OneDrive documents stay in OneDrive ✅ built, not yet driven

Steps 3–4 of `PLAN-LINKS.md`, landed together because that plan is emphatic
that step 3 alone ships something which looks finished and prevents nothing.
The failure being prevented: copying a synced document into `attachments/`
produces a second version that starts diverging the moment either is edited,
of a file whose entire point is that there is one of it.

**The rule lives in the core, the knowledge does not.** `VaultOptions.syncedRoots`
is a list of absolute paths, empty by default, and `addAttachment` refuses
`copy: true` from inside one. Discovering *where* OneDrive syncs is Windows-shaped
and per-user, so `apps/desktop/src/main/synced-roots.ts` reads the
`OneDrive`/`OneDriveCommercial`/`OneDriveConsumer` variables and falls back to
`HKCU\Software\Microsoft\OneDrive\Accounts\*\UserFolder`, then hands the union
in at startup. Both sources are read because they fail differently — the
variables are missing for a process that started before OneDrive did, and the
registry is the only place a second account reliably appears. Roots that no
longer exist on disk are dropped, so an unlinked account cannot leave a stale
key refusing copies from what is now an ordinary directory.

**Refuse in the core, downgrade at one surface.** `addAttachment` throws, naming
`copy: false` as the way through, so the API never quietly does something other
than what was asked. The drop handler is the single exception: a drag carries no
dialog in which the choice could have been made, so main links the file in place
and the panel says so in a dismissible note. The file picker's "Copy in" *was* an
explicit choice, so there the refusal stands and reaches the error toast intact.

**No new link type, and the enum is the reason.** Adding `onedrive` to
`LinkSchema.type` would make every item carrying one unparseable to an older
build — `snapshot.errors`, gone from every view — and running the app against a
globally-installed MCP server at a different version is the normal state, not an
edge case. OneDrive links are stored as `type: url`; the row derives its
"onedrive" chip from the target, which is the only thing the separate type would
have bought. The same argument kills the `removeLink` collision gotcha 8 warns
about, since there is never a second URL-shaped type to collide with.

**A split the plan did not anticipate.** The proposed shape put
`classifyLinkTarget` beside `isSyncedPath` in one core module. That cannot work:
the sync-root comparison needs `node:path`, the renderer is sandboxed and bundles
for Chromium, and the link form is exactly where the classifier is needed. So the
string-only half is its own leaf entry point, `todo-vault/link-target`, importing
nothing — the same reason `constants` and `recurrence` are separate — and
`links.ts` keeps the path logic. Verified by grepping the built renderer bundle:
the OneDrive hostnames are in it and `node:path` is not.

**Two dead gestures now work.** Dropping a folder used to throw and fail the
whole drop, because `addAttachment` accepts files only; directories now route to
`folder` links. Dragging a document out of the OneDrive *web* UI used to do
nothing at all, because `dataTransfer.files` is empty for it; `text/uri-list` is
read when there are no files, and non-http schemes are dropped rather than stored
as links that would be refused on click.

**The suite is at 103** — 73 in the core, 30 over the app. The new ones cover
`syncedRootFor` against nested, sibling and case-differing roots (the sibling
case is the one a naive prefix match gets wrong: `…\OneDrive` must not swallow
`…\OneDrive - Contoso`), `classifyLinkTarget` across all three OneDrive URL
shapes plus a SharePoint library and a Windows path — which parses as a URL,
drive letter as scheme, and is the case most likely to be misread —
`addAttachment` refusing and still linking, `parseUriList`, and the two
discovery parsers.

**Discovery is proven on this machine; the gesture is not.** `discoverSyncedRoots`
was run for real and returned `C:\Users\bisch\OneDrive`, with the environment
variables and the registry agreeing and deduplicating to one root; a path inside
it resolves to that root and a path outside it resolves to nothing. That was the
seam most likely to be quietly wrong, because its failure mode is silent — a
synced file copied in as though nothing were special about it, which is exactly
what this exists to prevent — and `reg query`'s real output does match what
`parseUserFolders` expects.

What has *not* been done is dropping an actual file out of that folder onto the
detail panel and reading the note, or pasting a share link into the link form
and watching the warning behave. Both are UI paths with tests underneath them
and no verification above them. Note also that this account is consumer OneDrive
only — `OneDriveCommercial` is empty here — so the two-account case the registry
fallback exists for has never actually been exercised.

## Two more agenda scopes ✅ built and driven

Two of the three from `IDEAS.md`: `twoWeeks` (this week and next, as one
fourteen-day window) and `next30Days` (rolling, today plus thirty). `nextMonth`
was deliberately left out and stays in `IDEAS.md`, which now holds only it.

**The list became a constant, which is the part worth keeping.** The idea entry
counted six places where the `AgendaScope` union was retyped by hand with
nothing forcing them to agree, and it was right — but paying that tax twice more
was the wrong move when the fix is smaller than the tax. `AGENDA_SCOPES` now
lives in `constants.ts` beside `ITEM_TYPES` and `STATUSES`, `AgendaScope` is
`(typeof AGENDA_SCOPES)[number]`, and every other site imports rather than
restates: `mcp-server.ts` does `z.enum(AGENDA_SCOPES)` exactly as it already did
for the other enums, `shared/api.ts` aliases `AgendaSection["scope"]`, and
`cli.ts` uses the type for both the argument and the phrase record. `constants.ts`
is the right home rather than `vault.ts` because the renderer's `<select>` and
the zod enum both need the values and neither can import `vault.ts` — that file
pulls `node:fs` into a browser bundle.

The payoff is not tidiness, it is that `ranges` is now `Record<AgendaScope, …>`:
a scope in the array without a range fails the typecheck instead of arriving as
`undefined` and dying in a destructure. That failure mode was reachable from the
CLI until now — `vault agenda nextmonth` threw a `TypeError` about destructuring
undefined. It is checked against `AGENDA_SCOPES` and names the six valid scopes
instead.

**`twoWeeks` is one range, not two stacked.** The trap the idea entry called
out, restated where it can bite: `overdue` is `open.filter(dueDate < reference)`
and does not read `to` at all, so `agenda("week")` and `agenda("nextWeek")`
return identical overdue lists and a caller-side merge shows every overdue item
twice. The dedup — `alreadyListed`, and overdue winning the tie against an item
due earlier in the same window — only holds inside one call. So this is a real
entry in `ranges`, `startOfWeek(reference)` to `+13`, and the test asserts both
the fourteen-day span and that no key appears in two sections.

**`next30Days` earns its place against `month` at the end of the month.** Both
carry `["daily", "weekly", "monthly"]` and on the 1st they nearly agree, which
is why the test uses the 28th: `month` has three days left and returns nothing,
while the rolling window still reaches a month out and finds the work. The MCP
description says this in as many words, because "what's coming up in the next
month" and "what's left this month" are the same sentence to a model otherwise.

Neither scope needed a change to `isSettledForWindow`. Both put `reference`
inside their own window — `next30Days` at its start, `twoWeeks` in its first
half — which is the already-proven case, and neither inherits the
`cadencePeriod` subtlety that makes `nextMonth` the awkward one. That analysis
survives intact in `IDEAS.md` for whoever builds it.

**The suite is at 105** — 75 in the core, 30 over the app. Two new tests:
`twoWeeks`'s span, its cadence set (monthly does not come round inside a
fortnight), and the no-double-count assertion; `next30Days`'s inclusive
thirty-day boundary, that a monthly cadence recurs inside it, and the
end-of-month divergence from `month` in both directions.

**Driven at the CLI and in the app.** `vault agenda twoWeeks` and
`vault agenda next30Days` were run against the example vault and their headers,
ranges and sections read correctly — "Due this week and next (2026-08-03 to
2026-08-16)", "Due in the next 30 days (2026-08-03 to 2026-09-02)" — and the
unknown-scope error was triggered on purpose. Both new `<option>`s were then
picked from the dropdown in a running window, and their `SCOPE_PHRASE` headings
render as "Due this week and next" and "Due in the next 30 days" with the
matching "Recurring …" below. One thing to know if the typecheck ever seems to
lie: the desktop workspace resolves `todo-vault` through `packages/core/dist`,
so a change to `constants.ts` does not reach it until
`npm run build -w todo-vault` has run — the first typecheck of this change
failed for exactly that reason and not for any fault in the code.

## A long agenda window subdivides ✅ built and driven

The complaint behind it: `next30Days` and `month` return a flat list, and a flat
list of fifteen dated items is not a month — it is fifteen dates the reader has
to hold in their head to see the shape of.

**Ranges, not groups.** `AgendaSection.bands?: { label, from, to }[]`, present on
`due` and only for the scopes long enough to want it. It carries no items:
`items` stays one flat list and a band is the slice of it inside that range.
That works because `sortByWorkOrder` compares due dates before anything else and
everything in a `due` section has one, so the list is already in date order and
a band is a contiguous run — nothing re-sorts, and appending the bands back
together reproduces the order the section already had, which is what leaves the
desktop keyboard walk untouched. The alternative — bands carrying their own
items — would have doubled an agenda payload the MCP server has to fit in 24k
characters, to say something every consumer can already derive.

The compatibility property is the point of the shape: a consumer that ignores
`bands` reads exactly the agenda it read before they existed, so the CLI's
`--json`, `SCHEMA.md`'s "up to three sections", and the section `kind` all still
mean what they meant.

**Decaying resolution, not one band per week.** `twoWeeks` gets This week /
Next week, `month` gets This week / Rest of the month, `next30Days` gets This
week / Next week / Later. The rejected design was a band per calendar week,
which sounds more uniform and is not: a thirty-day window opening on a Wednesday
touches six calendar weeks with a partial one at each end, spending six headings
to repeat what the date beside each row already said. These are two or three
whatever day it is, and the first is always the current week because that is the
horizon that can be acted on. `twoWeeks` is the two-band case of the same rule
rather than a rule of its own, so "This week" means one thing everywhere.

**Two edges that needed deciding rather than falling out.** The first band
starts at the current week's Monday, not at the window's own `from` — they
differ only for `month`, where a band running from the 1st would be a nine-day
"this week" on the 3rd. Nothing is lost, because anything due before the
reference date is overdue and left the section already. And when only one band
survives clipping — the last week of a month, where "this week" has swallowed
what remains — `bandsForWindow` returns `undefined` rather than one band, since
a single band is the section again with a second heading on it.

**Where the renderer's half lives.** `groupIntoBands` went into `ordering.ts`
beside `backlogOrder` and `boardLanes`, not into `Agenda.tsx`, so the desktop
suite can test it — that file is where the pure "how do rows arrange" functions
live precisely because their failures are invisible on screen. It renders each
group as a `Fragment`, so an unbanded section produces exactly the DOM it did
before, and it places a key no band covers in the last band rather than skipping
it: a row in a slightly wrong band is a display bug, a row silently dropped off
the agenda is a missed deadline.

**Empty bands are dropped**, matching what `populated` already does to an
emptied section. The cost is real and worth writing down: a clear week now says
nothing rather than saying it is clear. What partly covers it is that the
surviving heading still narrows the claim — a `next30Days` agenda showing only
"This week" is telling you the next three weeks are empty.

**The suite is at 114** — 78 core, 36 desktop. Core: which scopes band and which
do not, the clipping at both a month's end and its ragged start, a Sunday
reference where "this week" is one day, and that every due item is claimed by
exactly one band. Desktop: the contiguous cut, order preservation, the empty
band dropping, and both fallbacks — an uncovered key and an item missing from
the map — landing rather than vanishing.

**Driven at the CLI and in the app.** A scratch vault with due dates spread
across all three bands was run through `twoWeeks`, `month` and `next30Days` at
the CLI, each printing its own shape, and then opened in the desktop app with
each scope picked from the dropdown. The headings render as designed: band
titles a step down from the section title, one note per section rather than per
band, and each band its own rows card. `month` showed six items to
`next30Days`'s seven — the 1 September item correctly outside the calendar
month — and its first band read `2026-08-03 → 2026-08-09` under a section
reading `2026-08-01 → 2026-08-31`, which is the Monday clamp visible on screen.
The example vault exercised the empty-band path from the other direction:
everything in it falls in one week, so the two later bands printed nothing at
all.

Two notes for whoever drives it next, because both cost time here. The desktop
app's userData is **nested**: the package is `@todo-vault/desktop`, and Electron
turns that scoped name into `%APPDATA%\@todo-vault\desktop\`, so the
`settings.json` sitting directly under `%APPDATA%\@todo-vault\` is a leftover
that is never read — editing it to repoint `vaultRoot` changes nothing and
looks like it should have. And a PowerShell screenshot driver must be
`SetProcessDPIAware` and must pick the Electron window by largest area rather
than by title: while a native `<select>` popup is open the main window reports
an empty title, and the obvious fallback of "first window handle" grabs a 0x0
helper and captures nothing.

## A History view over the vault's git log ✅ built, driven for the global view

The app auto-commits every write and calls that its undo story, and none of it
was visible from inside the app. The only git surface was diagnostic — a
sidebar dot and a three-case warning banner. The app could tell you history was
being kept; it could not show you any of it.

**The diff is the whole feature.** Real subjects in this vault are `Update
OPS-5` and `Update 2 items`; a view listing them would say nothing. The value is
entirely in turning `-dueDate: 2026-08-06` / `+dueDate: 2026-08-19` into
`due 2026-08-06 → 2026-08-19`, which is only tractable because
`FRONTMATTER_ORDER` fixes field order so a diff shows what changed and nothing
else. That constant's comment says git diffs should show only what actually
changed; this feature is the payoff for a decision made for other reasons.

**`--unified=1000`, and why that is not the bug it looks like.** With that much
context the single hunk spans the whole item file, so `context + minus`
reconstructs the *before* file byte-for-byte and `context + plus` the *after*.
Both then go through the real `parseFrontmatter` and the field diff becomes an
object comparison — exact for multi-line YAML, arrays, and the nested `sync:`
block, where no hunk heuristic can be: a `sync.state` change arrives as
`-  state: never` / `+  state: pushed` with only indentation to say what owns
it. It works because `updated:` changes on every app write and sits in the first
~25 lines, so the hunk always reaches line 1. That is a property of how the app
writes files, not a guarantee, and the code says so — an external tool editing
only the tail of a very long description falls through to "description
changed", which is the right answer anyway. The measured worst case in a real
110-commit vault is an 18 KB patch, so reading whole files costs nothing today.

**Measured before designed.** Several calls rest on facts about the real vault
rather than caution. `git log` emits no NUL bytes even for a committed 2.6 MB
PDF, so a `%x00`-delimited `--format` is safe. That PDF's own patch is 426
bytes, not megabytes — so `attachments/` is excluded for *readability*, not
safety, and nothing is lost because attaching a file also rewrites the item's
`attachments` array in the same commit. Trash and restore already appear as
`R100` renames between `items/` and `.trash/items/`, which is what makes them
render as `trashed`/`restored` rather than as a raw path into `.trash`. And a
project rename scores only 57–75% similarity, because the key is rewritten
inside the file as well as in the filename — so rename detection stays at git's
default 50%. Tightening to 90% would have broken exactly the case `--follow`
most needs to survive.

**A pathspec is always passed, never omitted.** `gitStatus()` already models
`repoRoot !== root` because a vault can live inside a larger notes repo; with no
pathspec, History would list that repo's unrelated commits. There is a test that
puts a vault in a subdirectory of a repo with its own commit and asserts it does
not appear.

**Everything degrades rather than throws.** Binary blocks, multi-hunk patches
and unclosed frontmatter each produce a coarser answer with an `unparsed`
reason, never an exception. A history view that dies on one odd commit is worse
than one that says "changed — too large to summarise".

**`updated` is hidden entirely** — it changes on every write and is implied by
the commit timestamp — as is `sync.contentHash`, a digest nobody reads. **`id`
is deliberately not hidden**: the schema calls it "stable identity, survives
renames and key changes", so an `id` that moved means something went wrong, and
that is precisely what an audit log must not swallow. It showed up immediately
in the real log, on the reseed commits. A file whose only change was `updated`
renders as "touched, no visible change" rather than vanishing.

**Parsing lives in core, not in desktop main.** It needs `parseFrontmatter`, the
two frontmatter orders and the nested `sync` shape; main would have had to
import core anyway, at which point it is core code in the wrong workspace. Core
also owns the only test harness that does a real `git init`, and the CLI gets a
`vault history [KEY|PROJ]` verb for free — which is what made every later step
debuggable without launching Electron, and is where the field rendering was
first judged against 110 real commits.

**The one read that skips the write queue.** `git log` reads the object
database, which auto-commit only appends to, and touches neither the working
tree nor the in-memory index — the two things `serialize` exists to protect.
Queuing it would make History wait behind a batch of attachment writes for an
answer none of them can change. `listTrash` stays queued for the opposite
reason: it reads the working tree, which a write is part-way through rewriting.
The reason sits in a comment next to the method, because it is the first
exception to a rule the file otherwise keeps.

**`git.lastCommit.hash` as the refresh key.** `Agenda.tsx` keys its fetch on
`items`; copying that would have re-read the whole log every time the snapshot
changed for a reason git had nothing to do with. `GitStatus` rides on every
snapshot and `lastCommit.hash` changes if and only if a commit landed, so the
view refreshes through the existing `onChanged` subscription with no second
channel, and never otherwise. `ItemDetail` uses the same trick with
`item.updated` — that component re-renders on every keystroke, and `git log` is
the most expensive call in the app, so keying on `item` would have refetched
while you typed a comment.

**`pageCount` is explicit state, not `pages.length`.** They are the same number
one render later, and deriving it makes the effect that *fills* page N the
effect that *asks for* page N+1 — the view walks the whole log on its own. This
was caught before it shipped but it is the kind of bug that reads as correct.

**No new CSS tokens.** The light-mode block overrides only about ten tokens, so
an `--added`/`--removed` pair would have been invisible in light mode.
`--highest` (red) and `--done` (green) are already handled there and already
mean "was" and "is" everywhere else in the app.

**The suite is at 158** — 94 core, 47 desktop, 17 root. Core covers the parser
against hand-written fixtures (binary, multi-hunk, rename headers, the
no-newline marker) and `Vault.history()` against a real `git init` vault: a
field change without the `updated` churn, creation with zero fields, the
trash/restore round trip, `sync.state` without `contentHash`, a description-only
edit, multi-line YAML labels, pagination with `hasMore`, the nested-repo case,
and empty-rather-than-error for a non-repo and a bad key. Desktop covers
`history-format.ts`: the em dash for an absent side, which fields get renamed,
truncation, which kinds earn a badge, the "touched, no visible change"
fallback, and day grouping that never re-sorts.

**Driven in the real app, with one gap.** Pressing `4` renders commit `828a4dd8`
as `OPS-5 · due 2026-08-06 → 2026-08-19` with no `updated` line, day headings
grouping the log, and the short hash at the right edge. `OPS-6` shows `trashed`
and `restored` badges rather than a `.trash/items/OPS-6-2026-…Z.md` path, and
commit `5584fbaa` — the 2.6 MB PDF — renders as `attachments — → 1` with no PDF
bytes anywhere. The live refresh was driven from outside the app: a
`vault set` with `--git` in another process produced a new commit, and the entry
appeared with a new day heading and no manual refresh, which is the
`lastCommit.hash` dependency working end to end. The detail panel's History
section was confirmed present, last, after Comments, behind its **Show history**
button.

The detail panel's list went unverified on the first pass and was driven
immediately afterwards, alongside the fix below. It renders `status todo →
in_progress`, `cadence monthly → daily` and the reseed commit's `id` change,
scoped to the one item and with no day headings, which is what `showDays={false}`
is for.

A third note for whoever writes the next screenshot driver, beside the two
already recorded above, because it cost most of an afternoon here:
**`SetCursorPos`, `MoveWindow` and `GetWindowRect` all speak *logical* pixels to
a non-DPI-aware caller, while `CopyFromScreen` captures *physical* ones.** On
this 1.5× display that puts every click a third of the way off target and makes
a `MoveWindow` to "the screen size" push the window 120 px off the right edge —
which is what hid the detail panel and the commit hash through a dozen confusing
screenshots. The failure is silent and reads exactly like input being blocked: I
concluded from it that Electron was ignoring `mouse_event` and `SendInput`, which
was wrong, and shipped a commit saying so. `SetProcessDPIAware()` as the first
line of the driver makes every one of those APIs agree, and then clicks land.

## The item panel's history can be hidden again ✅ built and driven

Shipped broken and reported straight back: opening the history on one item
turned the section on for every item, with nothing on screen to turn it off.

The cause was a one-way door. `setShowHistory(true)` — never a toggle — and the
button lived inside the `!showHistory` branch, so the act of using it removed the
only control that referred to it. Sticky-across-items was deliberate and is
still right; sticky with no way out is just a section you cannot dismiss, and the
two are easy to conflate when the "off" state is the one you develop in.

The fix takes the shape the panel already had an answer for: a toggle in the
`<h3>`, labelled with the action, exactly like `Links`' `+ add`/`cancel`. That
also puts it in the one place guaranteed to stay on screen — the heading is
rendered in both states, which is precisely what the first cut got wrong.

The lesson worth keeping is not about React. Both the plan and the commit said
"behind a show/hide toggle" and what got built was show-only, because the branch
that was exercised while writing it was the one where the button exists. A
control whose *only* affordance sits inside one branch of the state it controls
deserves a second look before it ships.

## Phase 5 — Jira push from the UI

`buildPushPlan` output in a review pane, then the POST as an explicit user
action. `vault jira discover` was the other half of this phase and has been
built ahead of it — see its section below — because it had stopped being a
missing feature and become a warning that named a command the CLI would reject.
What remains here is the push itself, which is the part that writes.

One requirement for the pane, raised in the September review: show a **per-field
diff**, not a list of items. For a new issue that means the payload as Jira will
receive it, after `buildDescription` has added its footer. For a drifted item it
means local against the last-pushed baseline. The diff is what makes an explicit
POST an informed choice rather than a confirmation dialog, and it is the view the
missing "update a drifted issue" path (IDEAS.md) needs anyway. Build the diff
once and both of them get it.

The bulk-create CSV (PR #53) and `vault jira record` now give a no-API route into
Jira. That changes how urgent this phase is, not whether it is wanted: the CSV
round trip is right for a first import, and the pane is right for the trickle of
edits after it.

## `reporter` — who asked for it, surfaced in the app ✅ built and driven

Promoted out of IDEAS.md. The field already exists everywhere except the place
you would actually use it: `ItemFrontmatterSchema`, `CreateItemInput` and
`UpdateItemInput` all carry `reporter`, and `cli.ts` maps `--reporter` onto it.
The desktop app has never mentioned it. So this is renderer-only work — no schema
change, no new IPC channel, nothing to migrate in existing files.

**Correcting the note this idea was filed under:** `reporter` does *not* map to
Jira's reporter on push. `buildPushPlan` writes `assignee` and stops there, and
`pushableFields` — the hash deciding whether a pushed item has drifted — omits
`reporter` too, so editing it would not even mark the item as changed. Today the
field is stored, CLI-settable, and otherwise inert. Pushing it belongs to Phase 5:
instances routinely forbid setting reporter without elevated permission, and Cloud
wants an `accountId` where the existing assignee mapping uses Server-style
`{ name }`. That is a decision to make against a live instance, with the rest of
the push work.

**Labelled "Reporter", not "Requested by".** It sits directly beside Assignee,
which is Jira's word too, and the panel is a view over the file — where the key is
`reporter`. The app does translate elsewhere (`in_progress` → "In progress",
cadence `none` → "one-off"), but those rename encodings nobody types; this would
rename a field you can also set from the CLI.

### The suggestion list is derived, never stored

`knownReporters(items)` in `pieces.tsx`, beside `legalParents` and for the same
reason: one copy read by every surface, so the create form and the detail panel
cannot disagree about what has been used before. The renderer already holds every
item in one snapshot, so this is a `useMemo` — not an IPC call, and not a second
list on disk to keep in sync with the items that are the actual source of truth.

It is computed twice, over two different sets, because the menus ask different
questions. **Typing** a name draws on the whole snapshot, hidden projects
included: a name is not an item, hiding a project should not make a colleague
un-nameable, and the alternative is that the person you are trying to record
silently stops being offered for a reason nothing on screen explains.
**Filtering** draws on `visibleItems` alone, because a name used only inside a
hidden project could only ever return an empty view — the exact failure the
dangling-filter recovery below exists to prevent.

Neither list is ever scoped to the project selected in the sidebar. That filter
narrows the view, not the vocabulary: the names on offer are every name the vault
knows, whichever project you happen to be looking at.

**Case drift is deduped for display, never rewritten on disk.** "John Doe", "john
doe" and "John doe" collapse to one entry: group case-insensitively, offer the
spelling used most often, ties broken alphabetically. Picking from the menu then
converges the vault on that spelling over time, without any write ever touching an
item you did not edit. Trimming comes free — `EditableText` commits trimmed.

### `Suggest`, after `<datalist>` failed

Built first as a `suggestions` prop on `EditableText` that added a `list`
attribute, a `<datalist>`, and `showPicker()`. That shipped, typechecked, and was
wrong, in a way worth recording because the *verification* was what let it
through.

**Chromium filters the native datalist popup against the input's own contents.**
So a field reading `Dan Okafor` opened a menu of exactly one name — itself — and
every other name was unreachable without emptying the field by hand. An empty
field showed all of them. Two items behaved differently for a reason nothing on
screen explained, which is how it was reported: "OPS-1 doesn't show the same
dropdown values as OPS-5."

The check that missed it read `datalist.options` out of the DOM, which is always
the full list no matter what the popup renders. The popup is native and not in the
document at all, so nothing reachable from the page could have caught this. It
took an OS-level screen capture of the open menu — `grab.ps1` beside the drivers —
to see it.

So the menu is ours: `Suggest`, in `Editable.tsx`, used by both the detail panel
(through `EditableText`, which delegates to it whenever `suggestions` is
non-empty) and the create dialog. That buys the behaviour the field actually
needs, **opening shows everything, typing narrows**, which a datalist cannot
express — and as a side effect the options are now real DOM the next test can
read.

`touched` is what separates the two states, because the value cannot: `Dan Okafor`
as the committed value and `Dan Okafor` as what you have typed looking for it are
the same string and want opposite menus. It resets every time the menu opens.

Three details that are load-bearing rather than decorative:

- **The menu is `position: fixed`**, anchored off the input's measured rect. Both
  hosts scroll their own body — `.detail-body` and `.modal-body` are each
  `overflow-y: auto` — so a menu positioned within one is clipped by it exactly
  when the field sits near the bottom. It closes on scroll, which is what makes
  viewport anchoring honest.
- **Options `preventDefault` on mousedown.** Blur commits, so without it the field
  would close before the click landed — the same trap `EditableDate`'s clear
  button documents.
- **Escape is two-stage, and stops propagating on the first.** Dismissing the menu
  is not abandoning the edit, and both layers above would read it as that: the
  modal closes on Escape, and App's handler blurs the focused field, which commits
  it.

The create dialog's field is a `div.modal-field`, not a `<label>`, for the reason
the description field beside it already documents: a click anywhere inside a label
is forwarded to the control it names, so picking a name would re-focus the input
and reopen the menu just chosen from.

### The four surfaces

1. **Detail panel** — a `Reporter` row after `Assignee` in the `fields` list,
   committing `{ reporter: value || null }` exactly as Assignee does.
2. **Create dialog** — a field in the last `.modal-row`, submitted as
   `reporter: reporter.trim() || undefined`. This leaves the form asymmetric,
   since Assignee is still not on it. Deliberate: who asked for something is known
   while you are logging it, whereas who will do it usually is not yet.
3. **Filter bar** — an "Any reporter" `<select>` beside status and cadence,
   applied client-side in `filtered`, and needing nothing from the core:
   nothing in this window goes through `listItems`. (`ItemFilter` gained
   `reporter` later, for the MCP server — see below.) Absent rather than empty
   where nobody has used the field — a select offering only "Any reporter" is a
   control that cannot do anything.

   It holds a *folded* name rather than the displayed one. `knownReporters` picks
   the spelling the vault uses most, so the canonical one can change under a live
   filter when an edit tips the count; matching folded makes that reshuffle
   invisible, and makes the menu's claim that "John Doe" and "john doe" are one
   person hold when you act on it. It still needs the recovery `App.tsx` already
   performs for a dangling project filter — a name that leaves the vault entirely
   (last item deleted, or its reporter cleared) falls back to "any", or the view
   empties with nothing saying why.
4. **View search** — `reporter` joins the haystack in `filtered`, so `/` finds a
   person's items by name.

Not doing: a Reporter column in the backlog table, already seven columns wide.
MCP parity was deferred here too and has since landed — `reporter` is in `detail()`,
in both write tools' `inputSchema`, and in `ItemFilter`, where it matches folded so
`listItems` agrees with the app about who is one person.

### The fixture demonstrates it

`seed-vault.ts` sets a reporter on nine of its fifteen items: four names across
three projects. A name appearing more than once is the point — a fixture where every
name appeared exactly once would show a menu you can only ever add to and never
pick from, which is the opposite of what the field is for. Plenty of items carry
none, because work you raised yourself has no reporter and empty is the state the
field is in most of the time.

One spelling each, deliberately. The UI folds `Priya Raman` and `priya raman`
together and offers the commoner one, but that is a defence against drift, not
something a worked example should model as normal.

**`Nadia Hart` earns her place by being awkward.** She reports one item, in the
archived `LEG` project, and appears nowhere else — which is the only way the
fixture shows that the two menus differ. Verified in the app: the detail panel
offers `Dan Okafor, Mei Lin, Nadia Hart, Priya Raman`, and the toolbar filter
offers the same list without her.

### While in there: what the fixture could not previously show

Auditing the seed against what the UI actually renders turned up several
surfaces with nothing to display, all now filled:

- **Both endings.** `ACME-8` is driven to `done` and `ACME-9` to `disregard`,
  through legal transitions rather than created in that state. Before this, two
  of the board's six columns were permanently empty, "Hide closed" had nothing
  to hide, and the sidebar's open count always equalled its total. The board now
  reads `To do 8 · In progress 2 · In review 1 · Blocked 1 · Done 1 · Disregarded 1`.
- **Assignees**, on four items, from a cast deliberately disjoint from the
  reporters — overlapping them would make the fixture read as though the two
  fields were interchangeable, and `assignee` is the one of the pair that
  actually reaches Jira.
- **A hidden project.** `LEG`, closed out and hidden, so the Hidden panel has
  something in it. It is hidden by driving its item to `done` and then calling
  `hideProject` — which refuses while a project holds live work, so the sidebar's
  disabled Hide button is exercised rather than asserted.
- **One pushed item.** `ACME-2` carries `ENG-412`, matching ACME's declared
  `jiraProjectKey`, so the detail panel's Jira row reads `ENG-412 pushed` instead
  of "not pushed". `markPushed` runs last, after every edit to that item, because
  it stamps a hash of the pushable fields as they stand — pushing first would
  seed an item reporting itself as drifted, which is a different demonstration.
- **`components` and `lowest`**, the last two schema values with no example.

Still not covered, and deliberately: nothing in `.trash` (the panel opens onto an
empty list), and no item that fails to parse.

A seeded vault is *not* what is checked in at `vault/` — that one carries real
edits. Reseeding is `npm run seed -- ./vault --force`, and that flag is sharper
than it reads: it clears `items/`, `projects/`, `attachments/`, `.trash` and
`.counters.json`, and it writes **no commit**, because the script calls
`Vault.init` without `git: true`. So a reseed of a git-backed vault is
recoverable exactly as far as its last commit and no further — there is no
reflog entry, because nothing ever entered git. `vault/` was reseeded once
during this work and came back only because `git checkout` had a commit to come
back to.

### Verification ✅ driven in the real app

Built, then driven end to end against the example vault under Playwright's
`_electron`, because none of this is provable by typechecking it:

- The toolbar select is **absent** on a vault where nobody has used the field,
  and appears once a name exists.
- Typing "John Doe" into OPS-5's Reporter row wrote `reporter: John Doe` into
  `vault/items/OPS-5.md`, and it was on ACME-4's menu next — the name having
  never been stored anywhere but the item.
- Spellings fold: OPS-7 set to "john doe", and filtering on that one menu entry
  returned OPS-5 *and* OPS-7.
- Creating through the dialog's field wrote `reporter: Jane Doe`.
- `/` finds a person by name.

After the menu was rewritten, driven again against a fresh seed:

- A field already reading `Dan Okafor` now offers **all three** names with
  `current` beside its own — the defect, gone.
- Typing `me` narrows to `Mei Lin`; ArrowDown and Enter pick it and write it.
- Escape closes the menu, and a second Escape reverts: `zzz` typed over
  `Priya Raman` left the file untouched.
- Clicking a name in the create dialog fills the field and closes the menu
  rather than reopening it.
- Scoped to OPS in the sidebar, the menu still offers the ACME-only names.
- Across the whole run, exactly one item file was written: the one deliberately
  changed.

The lesson worth keeping: **a check that reads the DOM cannot verify a native
control.** The datalist bug was invisible to every assertion the page could make
about itself, and survived a run that reported green on every point. Anything
rendered by the browser rather than by us — a native picker, a select popup, a
file dialog — needs a screen capture or it is not being checked at all.

Re-run against a freshly seeded vault in a throwaway Chromium profile, which also
answered the question the first run raised: opening the field, escaping out, and
blurring it by opening the modal writes **no** item file at all.

The example vault at `vault/` was left as it was found — every commit the driving
produced was rolled back, so nothing here ships test names in `items/`.

**One write happened that is still unexplained.** A driving run that had leaked a
previous app instance — `app.close()` did not kill it, and two were briefly live
at once — left `reporter: John Doe` on ACME-5, a value that run never typed. The
obvious suspect was Chromium autofill replaying an earlier session's typing, and
that was tested directly and ruled out: in a profile where a name had just been
committed to the same field, opening a different empty Reporter gave an empty
input and blurring it wrote nothing. Controlled runs since have produced no
stray writes. The likeliest remaining explanation is the overlapping instances,
one of them holding renderer state for files that had been rewritten underneath
it by a `git reset` — an artefact of how it was driven, not a path a user can
take. Recorded rather than closed, because it was not reproduced.

## The draft box knows that "requested by" is `reporter` ✅ built

Promoted out of IDEAS.md, and the last surface that took prose and had nowhere to
put a name. The MCP tools got there first; `DRAFT_SCHEMA` in `claude.ts` still had
no `reporter`, so a note reading *"Priya asked for this"* left the model one
reasonable option — write the name into the description body, where
`knownReporters` never sees it and the reporter filter never matches it. Not lost;
filed where it cannot be queried, which is harder to notice than an empty field and
harder to correct.

**One property, and two paragraphs of prose.** The wire schema gained `reporter` in
`required` and in `properties`, and that is the entire main-process change:
`ItemDraft.input` is already `CreateItemInput`, which carries the field, and
`stripEmpty` already turns `""` into absence exactly as it does for `category`. The
work is in the description text and a new paragraph in the system prompt, because
those are the only places a model can learn that "requested by", "asked for by" and
"raised by" all name this field. Both say the same three things: the synonyms, that
a note naming nobody answers `""`, and that a name left in the description is
findable only by accident.

**The note's author is not a reporter**, said in both places. The prompt is written
in the first person by the person creating the item, and a model asked who wanted
the work will otherwise sometimes answer with them. Work you raised yourself has no
reporter, which is the state the field is in most of the time.

**The trap was one layer up.** `CreateDialog` deliberately did *not* apply a draft's
reporter, and its comment gave the reason: the schema never asked for one. Adding
the property without touching that comment would have dropped the drafted name
silently — the same failure this fixes, one layer higher, and the same shape as the
`labels`/`cadence` gap Phase 4 records having caught. So it is applied
conditionally, `if (input.reporter)`, rather than with the unconditional
`?? ""` clear the fields above it use. That asymmetry is load-bearing: a note that
mentions nobody must not wipe a name typed before pressing Draft, because "the note
said nothing about who asked" is not "nobody asked".

**One key, not two.** `requestedBy` is not accepted as an alias. The synonym belongs
in the text the model reads; a schema carrying both keys would immediately need a
rule for what happens when both arrive, and there is no good answer to that.

**The vault's existing reporter names are not passed into the prompt**, though the
categories and labels beside them are, for exactly that purpose. The cases differ.
A near-miss category splits a facet permanently and nobody notices, because nobody
knows the existing set by heart; a person's name you just typed into your own note,
you do. The draft lands in a `Suggest` field with the known names one keystroke
away, in a form that has to be read before Create — and case is folded by the
filter already, so what is left is `Priya` against `Priya Raman`, which the
confirmation step catches. Cheap to add if drafts ever start inventing spellings.

**Verified as far as it can be without a key.** Typecheck clean, and the wire
payload `DRAFT_SCHEMA` now emits was run through `stripEmpty` and `CreateItemInput`
both with a name and with `""`, with the conditional guard exercised in both
directions. `claude.ts` cannot be imported outside Electron — `secrets.ts` pulls in
`safeStorage` — which is why the draft schema still has no committed test and why
this check reproduced the contract rather than the module. Unverified is the half
that needs the model: whether a note naming someone actually comes back with the
name in `reporter` rather than in the description. That wants a real key and one
draft.

## Phase 0.6 — parity across the three surfaces ✅

**MCP is level with the CLI again**, at 23 tools from 13 — 26 today, after
`hide_project`, `unhide_project` and `tick_item`. The ten additions are
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

**`vault jira discover` exists now** — see its own section below. The warning at
`jira.ts:243` that advertised it has told the truth since.

**The OneDrive half of `PLAN-LINKS.md` is built** — steps 3–4, landed together.
A file inside a discovered sync root can no longer be copied into
`attachments/`. What remains from that plan is step 5's other half: the attach
dialog is still file-only, so a `folder` link is created by dropping a
directory or typing the path, not by picking one.

**`reporter` is not pushed to Jira**, and editing it does not even mark an item as
drifted — see the reporter section above for why that is a decision to make
against a live instance rather than a gap to close now.

**Recurring items showing a due date outside the window** — fixed in Phase 3.
OPS-2 now reads `↻ weekly · due 2026-07-29 · after this window` under "recurring
this week", so the date no longer looks like it contradicts the heading.

## Handoff: first run with a real key ✅ done — basic smoke test

A real key was entered and a draft was requested and returned successfully.
That proves the request is accepted and `output_config.format` returns
something the schema accepts. **Not individually re-checked**: the three
specific failure modes below (date resolution, project inference, an empty
vs. invented note) and the vague-prompt behaviour in step 4. Worth walking
through if a draft ever looks wrong, since nothing has ruled those out yet.

**Proven, by driving the built app with no key and then a dummy one:**
status reporting; `safeStorage` encrypt → store → clear round trip (Windows
DPAPI reports available); the settings panel's Save / Replace / Remove; Replace
never revealing the stored key; the create dialog degrading to a plain form with
a "Drafting is off" line; `draftItem` refusing with *"No Anthropic API key is
stored"*, which exercises the whole IPC path into main. The dummy key was
removed afterwards — `hasKey` is false and nothing is left in the keychain.

**Remaining, if a draft ever looks wrong, check in this order:**

1. Press `n`, type something with a relative date and no project, e.g.
   *"chase legal for the signed DPA, high priority, by Friday"*, then Draft.
2. Check the three things most likely to be wrong, in this order:
   - **The date.** Today's date is injected into the system prompt and the model
     is told to resolve against it. A date in the past means that instruction is
     not landing, and it is the failure most likely to go unnoticed.
   - **The project.** With none named it should pick by inference and say so in
     the note; it must be a key that exists.
   - **The note.** Empty every time probably means the field is being ignored
     rather than that nothing needed assuming.
3. Then try a deliberately vague prompt — *"sort out the thing with the invoices"*.
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

## The `npm audit` findings, and why the unreachable ones got fixed anyway

`npm audit --omit=dev` grew to four findings, every one of them arriving through
`@modelcontextprotocol/sdk` — the only runtime dependency `packages/core` has:

| Package | Sev | Advisory | What it is |
|---|---|---|---|
| `@hono/node-server` | moderate | GHSA-frvp-7c67-39w9 | Path traversal in `serve-static` on Windows via an encoded backslash (`%5C`) |
| `hono` | moderate | GHSA-8j4g-w8fx-2239 | ReDoS in the CORS middleware via `Access-Control-Request-Headers` |
| `fast-uri` | high | GHSA-7p8r-x3mc-p8w7 | Host confusion — a backslash authority introducer parses to a different host than it reads as |
| `@modelcontextprotocol/sdk` | moderate | — | Flagged only for depending on the first |

**Three of the four are not reachable from this codebase, on two independent
counts.** The SDK never imports `serve-static` at all — that is a separate
subpath export (`@hono/node-server/serve-static`), and the SDK's only use of the
package is `getRequestListener` from the package root. And that single import
lives in `server/streamableHttp.js`, which is not in the transitive import
closure of `server/mcp.js` plus `server/stdio.js` — the 16-file closure
`mcp-server.ts` actually pulls in reaches nothing outside `ajv` and `zod`. The
server speaks stdio; no HTTP listener is ever constructed, let alone a static
file handler or a CORS middleware.

**`fast-uri` is the one that argument does not cover, and saying so is the
point.** It sits under `ajv`, which the closure above explicitly does reach, so
that code loads on every server start. What it parses is the `$id`/`$ref` URIs
in the tool schemas this repo writes itself — never anything a caller supplies —
so a host-confusion bug in it has no untrusted input to confuse. That is a
narrower and more fragile claim than the other three, resting on where the data
comes from rather than on the code being unloadable, which is exactly why it is
written down separately instead of being waved through with them.

**They are fixed rather than merely recorded, which reverses what this section
used to say.** The earlier verdict was that the upgrade — SDK 1.30.0 widening
the range to `^1.19.9 || ^2.0.5`, pulling `@hono/node-server` up across a major
— bought nothing but a quieter audit line. Two things changed that. The audit
line stopped being private: `scripts/bootstrap.ps1` runs `npm install` in front
of someone installing todo-vault for the first time, so "4 vulnerabilities (3
moderate, 1 high)" is now part of the first thing a new user ever sees, and the
reassurance sits in a file they have no reason to open. And the findings
accumulated — one advisory against an unreachable transport is a footnote, four
including a high is a thing people reasonably refuse to ignore. Neither is a
security argument. Both are reasons the quieter audit line is worth more than it
was.

The bump is lockfile-only. `^1.29.0` already admits SDK 1.30.0, so no manifest
changed; `@hono/node-server` 1.19.15 → 2.1.0, `hono` 4.12.32 → 4.13.0,
`fast-uri` 3.1.4 → 3.1.5, and `ajv-formats` 3.0.1 arrives as a new SDK
dependency. Crossing a major with no source edits is safe here for the same
reason the advisory was harmless: it is a major version of code that is
installed but never loaded. Verified after the bump — audit clean, typecheck
passes, all 127 tests pass, and a stdio smoke test handshakes, lists all 26
tools, and returns real vault data from `vault_list_projects` and
`vault_get_agenda`.

**What would invalidate the reachability argument.** It is contingent on the
transport staying stdio. If `mcp-server.ts` ever imports
`StreamableHTTPServerTransport`, `@hono/node-server` and `hono` enter the
running code and the first three rows above stop being unreachable — see the
note at that file's imports. Keeping the argument written down after fixing the
findings is deliberate: the next advisory against this dependency will land the
same way, and the reasoning is what makes it a five-minute triage instead of a
fresh investigation.

## History shows what changed, not just that it changed ✅ built and driven

The History view (above) could say *that* a description changed or *that* a
comment was added, but never show either — `description changed` was a fixed
string, object arrays collapsed to their length (`comments 2 → 3`), and a
label edit reprinted the whole scalar list and left you to spot the delta.
Both were deliberate calls at the time: the comment at the object-array branch
called entry-by-entry comparison "a diff algorithm this does not need," and a
test asserted "no word diff — 'description changed' is the answer wanted."
Both comments were rewritten rather than deleted, so the reversal is on the
record next to the reasoning it replaces — a reader who finds the old
argument simply gone learns nothing about why the design moved.

**Structural, not textual.** `parseFileBlock` already reconstructs both whole
files from the `--unified=1000` patch and parses them with `parseFrontmatter`
before this feature touches anything, so the change is to the *comparison*,
not to plumbing. A textual diff of the YAML was the rejected alternative:
sparse-integer ranks and ordinary rewrites move array entries around, so a
line diff would report six link changes for a drag that changed nothing.

**`text-diff.ts` is a new pure module with zero imports**, bundled into the
Electron renderer alongside `description.ts` and `recurrence.ts` — pulling in
a diff library there would cost more than the module saves. `diffLines`
trims the common prefix and suffix before running an LCS table over what's
left, which is load-bearing rather than micro-tuning: a pure append to a
description trims to zero DP cells. A flat `Uint32Array` backs the table (a
worst case is 160 KB contiguous, not thousands of boxed arrays), and a
40,000-cell guard (~200×200 lines) returns `truncated: true` instead of
running the DP — measured against a prototype on the real vault (15 items,
110 commits), a whole 25-commit page costs ~0.25 ms against git's own ~85 ms
process-spawn cost, so the feature adds essentially nothing to the page it
rides on.

**Entries are matched by identity, not position**, so a reorder produces no
output at all — the whole reason identity matching earns its code. Identity
is per-field: a link's is `type` + `target`, an attachment's is `path`, a
comment's is `at` + `author`, a scalar array's is the value itself, and
anything else falls back to `JSON.stringify`. This is a heuristic and known
to be one: editing a link's `target` reads as a remove-plus-add rather than a
change, since `target` is half the link's identity — correct for
attachments, where a new path really is a new file, and nearly irrelevant for
comments, which are append-only. Matching links on `label` instead would make
a URL correction read as an edit and a re-labelling read as a replacement;
the chosen tradeoff is the better of the two, not a free one, and it showed
up immediately in the real vault log as a reseed commit whose attachment
rows read as `− Target schema draft` / `+ Target schema draft` — a path
change, not a title edit.

**`bodyChanged` and `FieldChange.before`/`after` keep their exact old
meaning.** Everything new is additive — `FieldChange.items?: EntryChange[]`
and `FileChange.body?: TextDiff` — so a consumer that ignores the new fields
renders exactly what it rendered before. `bodyChanged` stays load-bearing on
its own: the `unparsed: "partial"`/`"unparsable"` degraded paths set it
*without* ever having two parseable sides, so it remains the one honest
signal on those paths, and both `fallbackNote` and the CLI still key off it.

**The renderer gets one expander, not two.** `History.tsx`'s `FileRow` gained
a single `open` boolean: it drives both the collapsed-description button
(`Description edited  +3 −1`, raw text never rendered markdown — a diff of
rendered markdown would hide exactly the syntax that changed) and the cap on
entry-level lines under each field row (4 lines, then `+N more`, revealed by
the same toggle). Entry lines truncate to 80 characters with the full text in
`title`, matching the existing field-row convention.

**The CLI got a `--diff` flag**, off by default because it already prints
every commit on the page and long descriptions would bury the log; the
one-line `description edited (+3 −1)` summary prints unconditionally,
matching what the desktop view shows collapsed.

Driven against the real vault via the Electron dev build: a reseed commit's
`links 3 → 3` row expanded into three real lines (a URL link, an item link,
a file link, each rendered `label — target`), its `attachments 1 → 1` row
into the remove/add pair described above, and its `comments 1 → 1` row into
the old and new comment bodies plus a `+1 more`. A separate commit's
collapsed `Description edited  +4 −0` button expanded into the exact four
added lines the CLI printed for the same commit under `--diff`.

## The server says its own rules, and a link can be taken back ✅ built and driven

`mcp-server.ts` had twenty-six tools and no `instructions` block. That looks
like a straightforward omission — write down the traps an external Claude keeps
falling into — and the first draft was going to be seventeen bullets long. It is
five, and the reason it is five is the finding that shaped the whole change.

**Most of the traps were already stated, at the moment of the call.** Checked one
by one against the file: that `labels` replaces the whole list is written
verbatim in `update_item`'s description; that a rejected transition names the
statuses reachable from here; that `in_progress` stamps `startDate`, exception
included; that `done` is not `disregard`, closing with "do not disregard
something on their behalf"; that re-keying a subtree leaves outside quotes of the
old key stale, and to say so when reporting. Restating any of that in
`instructions` buys a second copy of guidance the client is already guaranteed to
receive, and charges it to every session that connects — including the ones that
never call the tool. Tool descriptions are paid for on use; the block is paid for
on connect, and that asymmetry is the whole budget.

So the bar became: the block carries only what has **no per-tool home at all**,
of which there are three kinds. **Cross-cutting** — true across tools and
therefore fitting in none of them; the symptom is duplication, and the
synced-cloud warning was written out three times (`link_item`, `attach_file`,
`SCHEMA.md`) and held in agreement by hand. **Runtime** — descriptions are string
literals compiled into the file and cannot report the state the process actually
started in. **Absent** — a thing no tool does has no description to be missing
from. That triple is the test for anything proposed for the block later.

**`buildInstructions()` is a function rather than a const because of the git
line.** `mcp-server.ts` opens the vault with `git: process.env.VAULT_GIT === "1"`
where the desktop app hardcodes `git: true`. With it off, no MCP write is
committed, so the history that backstops every irreversible operation does not
exist — and there is no `vault_history` or `vault_git_status` tool, so a client
cannot ask. This is not currently broken: `.mcp.json`, `README.md` and
`connectionSnippet()` in `scripts/menu.mts` all set `VAULT_GIT=1`, and
`menu.test.mts` pins the last of them. The exposure is a hand-rolled config and
the fact that nothing would tell you. The block now does, in one sentence that
says something different in each world — verified by driving `initialize` over
stdio twice and diffing the `instructions` that came back.

**The reversibility bullet exists because `destructiveHint` points the wrong
way.** `delete_item` renames into `.trash/` and pairs with `restore_item`, and it
is annotated `true`. A comment has no inverse anywhere in the core; a copied
attachment has none and re-attaching the same basename overwrites the bytes; and
`move_item_to_project` re-keys a subtree, where keys are never reissued and
moving back burns a third set. All three were `false`. A client honouring the
annotations confirms the recoverable operation and waves through three that are
not. No per-tool description could fix this, because each annotation is locally
defensible — it is only the *set* that misleads. That is the same shape as the
re-key warning, which is thorough on its own tool and still incomplete: the
missing information is *comparative*, and ranking exists only across a set, never
inside one member of it. So the bullet is one paragraph about ordering rather
than a restatement of what each tool does.

**`vault_unlink_item` is the smallest part and changed the most.** `removeLink`
was already built, tested and shipped in the desktop app, and `README.md` listed
it as desktop-only; the MCP was the surface that could not reach it. It could not
be registered as-is: `PLAN-LINKS.md` gotcha 8 recorded that `removeLink` matches
on `target` alone while `addLink` dedupes on `(type, target)`, so one call
deletes every link sharing a target. Survivable behind a ✕ a person clicked, who
could see the rows; not behind a tool an agent calls to undo its own last write.
`removeLink` gained an optional `type` that narrows the match and defaults to
today's wide behaviour, so the desktop caller and its two tests are untouched —
and the gotcha 8 case, previously untested on either side, now has both halves
covered. The tool always passes a type, and is annotated `destructiveHint: true`,
given that wrong annotations are half of why this change exists.

**What it buys the block is subtraction.** The append-only warning would have had
to cover links, comments and attachments; with the tool registered it covers two,
and the trap that said otherwise was rewritten before it was ever written down
rather than a week after shipping. That ordering — server surface first,
conversational skills second — is the reverse of what was first proposed, and the
reason is that a skill in `.claude/skills/` triggers only inside this checkout,
while the complaint was always about someone running this server from their own
Claude Desktop. Rules that must reach that reader go in the block; workflows that
may cite the CLI, the desktop app and `npm run menu` go in skills, which are still
to be written and should point at the rules rather than restate them. The
synced-cloud warning living in three places is the failure mode not to repeat.

Three things were deliberately left out and logged in `IDEAS.md` instead:
`removeComment`/`removeAttachment` in the core, which are schema decisions and
not oversights; a real `vault_git_status`, which is one parity pass over
`doctor`, `git-status` and `history` rather than a twenty-eighth tool; and
exposing `components`, which the core accepts on both input types and no MCP tool
sets — a genuine absence, but a field nobody has yet asked for does not earn a
line in every session's context. The two synced-cloud tool descriptions were also
left long rather than shortened to point at the block: that trades guaranteed
guidance for guidance that only arrives if the client honours `instructions`, and
it is worth doing only once the block has been seen working in more than one
client.

Driven end to end over stdio against a real vault: two links sharing a target
under `url` and `note`, `vault_unlink_item` on the `url` one, and the `note` link
still there afterwards.

## The app starts without a terminal ✅ built and driven

The complaint was a console window sitting open all day behind an app that has
no use for it. The obvious reading is that this is what `PACKAGING.md` is for and
the answer is "wait for the packaged build" — and that reading is wrong, which
is the finding this change turned on.

**The console is a parent process, not a window.** `npm run preview` is npm
waiting on electron-vite waiting on Electron; three processes, and the terminal
lives as long as the innermost one because the two above it are still holding
it. Closing the window kills all three. Nothing about that is Electron's doing,
and nothing about packaging is required to undo it.

**The built app has not needed electron-vite at runtime for some time, and
nobody had noticed.** `index.ts` reaches for a dev server only when
`ELECTRON_RENDERER_URL` is set and otherwise does `loadFile` off
`out/renderer/index.html`; a grep for `process.env` across `src/main/` returns
that one variable and `discoverSyncedRoots`'s injected parameter. So
`electron.exe apps/desktop` is the same launch with two fewer processes above
it. `electron-vite preview` was never a dependency of the running app — it is a
convenience for starting it — and the distinction had gone unstated because
every path to the app went through npm.

**A `.vbs` is not a trick for hiding a console; it is a host that never gets
one.** Windows opens a `.vbs` with `wscript.exe`, a GUI-subsystem binary, where
`cscript.exe` is the identical language with a console attached. That is the
whole mechanism. The `0, False` on `Run` — hidden window, do not wait — is belt
and braces, and the part that matters is `False`: wscript exits immediately and
leaves Electron with no parent at all. Verified rather than assumed, by reading
`ParentProcessId` off the main Electron process after a launch and confirming
the parent was already gone.

**The shortcut targets `wscript.exe` and passes the script as an argument**,
rather than pointing at the `.vbs` and letting Explorer resolve it. A `.lnk` to a
script file goes through the `.vbs` file association, which is not reliably
wscript — administrators repoint it at an editor to discourage script execution,
and a stray "Open with" does the same thing one user at a time. On such a machine
the shortcut opens Notepad and the app never starts, with nothing to suggest why.
Naming the host makes the association irrelevant. `shortcutScript()` is pure and
exported for the same reason `connectionSnippet()` is: both ways this shortcut
breaks are invisible on the machine that wrote it and only surface on someone
else's, so a test is the only thing positioned to notice.

**`MsgBox` is the only channel, which is why both guards exist.** Under wscript
there is no stdout — a message printed on the way out would go nowhere, and a
missing build would present as double-clicking an icon and having *nothing
whatsoever happen*. So the launcher checks for `electron.exe` and for
`out/main/index.js` and puts up a dialog naming the command that fixes each.
Driven by moving the built entry aside and confirming no Electron process
started.

**It launches; it does not build.** Two arguments, and the second is the one
that decided it. A build behind a double-click is about ten seconds of nothing
visible — measured, warm, and minutes on a clone that has to fetch Electron
first — with no console to show progress in; the failure mode is a user clicking
again. And
`package.json` already owns the build-then-launch order for `preview`, with a
comment explaining why that sequence must not live in the menu; putting it in the
launcher too would make that two places, which is the same mistake the
synced-cloud warning made in three. The cost is real and is written down in all
three documents rather than discovered: after a pull that touched the desktop
app, the shortcut starts the old one until `npm run build`.

**Two things it does not fix, both logged rather than papered over.** The app has
no single-instance lock, so a second double-click is a second window over the
same vault — previously unlikely when launching meant typing a command, and much
easier with an icon sitting on the desktop; `IDEAS.md` has it, since it is a
change to the main process and not to the launcher. And a shortcut still requires
a clone, an install and a build on the machine, so it does nothing for the
portability problem. `PACKAGING.md` was rewritten to say which half it now owns,
because its opening line — that you still start the app from a terminal — had
become false.

The icon is Electron's own, taken from the binary with `IconLocation`. There is
still no `.ico` in the tree, and the honest choice was between the stock atom and
wscript's script page, which reads as "some automation" rather than as an app.
`PACKAGING.md` keeps the real icon on its checklist.

One Windows detail worth recording because it looks like it should bite and does
not: `.gitattributes` pins the whole tree to `eol=lf`, and the Windows Script
Host parses an LF-only `.vbs` and starts the app anyway. Checked, not assumed.

## The launcher notices an update is due ✅ built and driven

Starting from an icon rather than a command made the shortcut the one way into
this app that can quietly run a version replaced weeks ago. Every other route
builds on the way past — `dev` and `preview` both do — and the shortcut
deliberately does not, so the staleness it trades for an instant start needed
something to close the loop. The previous change wrote that cost into three
documents. Writing it down is not the same as handling it.

**The check runs after the launch, and that ordering is the design rather than
an implementation detail.** A check in front would spend a `git fetch` of
silence before the window appeared, on every launch including the overwhelming
majority with nothing to report — which is precisely the instant start the
shortcut was built to get. So Electron starts and is orphaned as before,
wscript stays alive a few seconds longer, and a dialog arrives over a running
app or not at all. `launch.test.mts` pins the order, because reversing those two
lines would reintroduce the wait invisibly and nothing else would notice.

**Two questions, deliberately different in cost.** Is the build stale — newest
source timestamp against oldest build output, instant and offline — and is there
a newer version, which needs a fetch. The first is the one that matters most
here and is the one git cannot answer: after `npm run update` the tree is
perfectly clean and the app is still the old one, because update rebuilds the
core alone and `electron.vite.config.ts` compiles the core *into*
`out/main/index.js`. A clean `git status` and a stale app are the same state.
Oldest output rather than newest, so a build that failed partway cannot have one
rewritten file vouch for two that were left behind.

**The verdict travels as an exit code.** VBScript cannot read a child's stdout
without redirecting to a temp file and then owning the cleanup, while
`Run(..., True)` returns the exit code for nothing. 0 up to date, 2 stale, 3
behind, 4 both; anything else — including the 1 Node exits with on an uncaught
exception, and the error `Run` raises when node is not on `PATH` — means the
check could not tell, and the response to that is silence. A test asserts no
verdict is ever 1, since a crashed check surfacing as advice is the failure this
numbering exists to prevent.

**Everything fails soft, which is most of the code.** No git, no remote, no
upstream for this branch, offline, credentials refused, a folder copied out of
its clone: each returns zero and says nothing. `GIT_TERMINAL_PROMPT=0` and
`GCM_INTERACTIVE=never` are both set because this runs from a hidden window —
the first stops a console prompt waiting forever on a stdin nobody can reach,
and the second stops Git Credential Manager raising a GUI dialog that would
appear from nowhere with nothing to say what wanted it. A twenty-second timeout
backstops the rest. The failure mode being designed against is a dialog nagging
on every single launch about something it could not actually determine.

**`Yes` opens a visible terminal**, and picks the command from the verdict:
`npm run build` alone when nothing needs pulling, `npm run update && npm run
build` when it does. Visible and `/k` so the window stays, because this is the
one moment in the whole design where a console is what the user wants — a build
is worth watching and a failure needs reading. `cmd.exe` rather than PowerShell,
since `npm` resolves to `npm.cmd` there and cannot be stopped by an execution
policy, which is the trap `scripts/bootstrap.ps1` exists to explain.

**The bug worth recording is an encoding one, and it was invisible in the
source.** The Windows Script Host reads a `.vbs` through the system ANSI
codepage rather than as UTF-8, so an em dash written into a message arrived in
the dialog as the three characters its UTF-8 bytes spell. It was found by
reading the rendered dialog back out of the window with `GetWindowText` — a step
taken to check the wording, not the encoding — and would have survived any
amount of reading the file. Strings in that file are ASCII now, comments are
not, since nothing renders a comment. `launch.test.mts` pins the rule, and pins
the extractor against a sample with a known answer as well: the first version of
that test passed because it was looking in the wrong place, which a scan for
absence will always do quietly.

All four verdicts were driven end to end, with the dialog text read back out of
the window each time rather than assumed: silent when up to date, the rebuild
prompt naming `npm run build`, and both new-version prompts naming the update.
`No` was confirmed to run nothing; `Yes` was confirmed to open the terminal and
complete the build — which it does with the app still running, so Windows does
not hold `out/main/index.js` open the way it holds a running `.exe`.

## CI, and the three things it decided differently ✅ built

`.github/workflows/ci.yml` runs `npm ci`, a core build, typecheck and the suite
on every pull request and every push to `main`, plus a separate build job. It
came out of an `IDEAS.md` entry, and the interesting part of writing this down
is that the entry proposed a shape and the first real runs overruled it three
times. Each reversal is the sort of thing that only an execution can settle.

**The runner is `windows-latest`, and only that.** The idea argued the opposite,
and argued it well: every Windows-shaped predicate in the tree is tested as a
pure function against canned input — `synced-roots.ts` parsing `reg query`,
`isTransientRenameError` naming `EPERM`/`EACCES`/`EBUSY`, `classifyLinkTarget`
handling `C:\` and UNC paths — so nothing in the suite needs a Windows
filesystem, and Linux would be faster and cheaper. What that reasoning left out
is what a green run would then be evidence *of*. This codebase has Windows in it
on purpose; `menu.mts` routes around the `npm.cmd` shim, and the vault's atomic
write retries its rename for transient Windows locks. Neither path is reachable
on Linux at all, so a Linux pass would be a true statement about a program
nobody runs. Cheapness is not the axis.

**The build job exists, where the idea said to leave it out at first.** The
argument for omitting it was that typecheck already covers all five projects and
`build` only adds bundling, while `prebuild` forces the lazy Electron download on
every run. The first half is exactly wrong in a way worth remembering: typecheck
reads types and never invokes the bundler, so a change can typecheck clean and
fail to build. The second half was real and got solved rather than avoided — the
Electron binary is cached on `package-lock.json`'s hash, and the job is kept
separate so it is the only one paying for it.

**The engines floor was a guess, and CI is what turned it into a fact.**
`package.json` claimed `>=20`, which nothing had ever run. `npm test` globs its
test files; npm hands scripts to `cmd.exe` on Windows; `cmd.exe` does not expand
globs; and Node only learned to expand the pattern itself in 22. The suite could
therefore never have run on 20, in any workspace. Node 20 also left LTS on
2026-04-30. The floor moved to 22, and the matrix runs 22 and 24 — 22 because a
claim nothing tests is a guess, 24 because it is what this gets developed on.

**One thing no one predicted.** The check job builds core before typechecking,
because `apps/desktop` imports the `todo-vault` workspace package whose `types`
field points at `dist/index.d.ts` — build output, and gitignored. A working copy
has that directory lying around from earlier builds, so typecheck passes locally
and a clean checkout reports `Cannot find module 'todo-vault'` ten times over.
This is the class of bug CI exists for: not a mistake anyone made, but a
dependency on local state that no amount of reading finds, because every machine
that could notice it already had the file.

What has *not* been done is the part the idea was most interested in, and it
stays in `IDEAS.md`: a check that compares the test counts written into prose
against the ones the suite reports. That drift has now recurred twice more since
the entry was written. `main` also remains unprotected — verified, not assumed —
so a red run is still a red X that can be merged straight past.

## `vault jira discover` ✅ built, and the one thing here never run for real

This was Phase 5 work that arrived early, because it had stopped being a missing
feature and become a false statement. `buildPushPlan` emits a warning during a
real push — "Run `vault jira discover` to find the custom field id for your
instance" — and `cli.ts` had no case for that subcommand. The `fields` JSDoc in
`jira.ts` said the same thing. Every other gap in this repo is something a
*reader* notices; this one was the app telling a *user* to run a command that
would answer `Unknown command`.

**It reads and prints, and both halves were settled by precedent rather than
decided fresh.** Reading only follows from `jira.ts`'s own opening: the vault is
upstream of Jira and never a mirror, so nothing here creates, updates or
transitions anything — discovery is two GETs against metadata. Printing rather
than writing `jira-map.yaml` is the argument `[C] Connect Claude` had already
had with `claude_desktop_config.json`: merging into a file means reserialising
everything around it, and `jira-map.example.yaml` is nine tenths comments
explaining what each value is for. A writer would have to preserve those by hand
or destroy them.

**Credentials come from the environment, not from flags.** A token passed as
`--token` is in shell history and in the process list. This repo already treats
a credential as something with no read path at all — the Anthropic key goes into
`safeStorage` with no getter on the IPC surface — and a discovery convenience is
not the place to lower that bar. `--url` and `--project` are flags because
neither is secret and neither can be guessed: no map exists yet to read a
`baseUrl` from, and issue type names are per project.

**The two findings worth reporting rather than resolving.** Jira permits two
fields to share a display name, and a company-managed and a team-managed project
each having their own "Story Points" is the ordinary way it happens — picking
one silently is how estimates end up written into a field nobody reads, so both
come back as `alternatives` for a person to settle. And a site that renamed
Story to "Deliverable" cannot be inferred, so unmatched types are named in the
output instead of guessed at. The command's value is that it is checkable: every
id is printed beside the name it carried on the instance.

**A bug the tests caught that reading would not have.** The candidate name lists
originally held case variants — "Story Points" beside "Story points" — while
matching was already case-insensitive, so a single field matched twice and
surfaced as a phantom duplicate in exactly the ambiguity report that exists to
be trusted. Names are now listed once, and matches dedupe by id rather than by
name, since two genuinely distinct fields sharing a name is the finding and one
field counted twice is the bug.

**`packages/core` now globs its tests.** It ran `test/vault.test.ts` by name,
which is not a suite so much as a suite that silently ignores everything added
to it — this change added the second test file and would otherwise never have
run it. That also makes the `>=22` floor in that workspace load-bearing rather
than merely consistent with the root: the glob is expanded by Node, because npm
hands scripts to `cmd.exe` and `cmd.exe` will not do it.

**What has never happened is a request to a real Jira.** The pure matchers are
covered by twelve tests against canned payloads, and the command was driven end
to end against a local stub serving realistic `field` and `createmeta`
responses — which proves the URL building, the Basic auth header, the zod
parsing and the matchers, since the stub 401s without credentials and answered
with data. Argument handling and the unreachable-host path were driven too. None
of that is evidence that Atlassian answers in the shape assumed here. The first
run against a real instance is what would turn this from plausible into
verified, and it is the only way to find out.

## A `+ new child` from the open item ✅ built

The only route to a child used to be the toolbar's **+ New**, which opens the
create form with Parent empty and asks you to find the item you were just
reading in a menu. The detail panel's Children section now carries the
affordance itself — a button in the heading that opens the create form already
pointed at the open item.

**The type and the parent have to be set together, in initial state, or the
form silently undoes the prefill.** `CreateDialog` defaults `type` to `"task"`
and runs an effect that clears `parent` whenever the chosen type makes it
illegal. A parent-only prefill survives from an epic — a task's legal parents
are epics — and is wiped everywhere else, since a story, task or bug can only
parent a subtask and `type` is still `"task"` when the effect first runs. The
form would look like it had ignored the click. Both values go into `useState`
initialisers rather than an effect after mount, so the clearing effect's first
run always sees a legal pairing.

**The menu is filtered by the open item's type, not the four non-epic types
flat, for the same reason.** `CHILD_TYPES` in `pieces.tsx` answers "what may
hang off this type" — the inverse reading of `legalParents`, which answers
"what can this type hang off." `epic` is never offered: an epic takes no
parent, so a child that is one cannot exist. An unfiltered menu would let `+
new task` open under a task, a pairing the vault refuses, and reintroduce the
exact silent-clear failure through a control that looks deliberate. Where only
one type is legal — everywhere except an epic — there is no menu at all: the
button names the type directly (`+ new subtask`), since a menu of one is a
wasted click and the type is genuinely prefilled, not guessed.

**The Children section now renders whenever the open item's type can have
children, with the button as its empty state, because an epic with no children
is worth seeing as an absence rather than a missing section.** It used to be
gated on `related.children.length > 0`, which hid the section from exactly the
item most likely to want a first child. The empty state — heading, button, one
faint "No children." line — is a direct copy of the Links section's existing
`+ add` / `field-note` pattern rather than a new idea, so it costs three lines
of vertical space at rest and no new CSS.

`NewChildControl` (`ItemDetail.tsx`) is the same native-`<select>`,
focus-and-`showPicker()` pattern `ParentField` already uses just above it in
the same file, for the same reason: the panel scrolls its own body, and a
native select renders its list above the page rather than needing to be
reasoned about inside that scroll. `creating` in `App.tsx` became
`NewItemDefaults | null` instead of a boolean, carrying `project`, `type` and
`parent` from wherever the click originated; the toolbar's **+ New** and the
`n` shortcut still pass `{}` and land on an unprefilled `task`, which is the
regression this change was likeliest to cause.

One interaction was left deliberately unhandled: pressing **Draft** in the
opened form can clear the prefilled parent, because `draft()` sets `project`
and `type` from Claude's answer and never touches `parent`, so if the draft
changes either in a way that makes the parent illegal, the same clearing
effect fires. That is the effect doing the right thing — the parent genuinely
became illegal — and the Parent select still shows the true state, so nothing
is hidden. No core work: `parent` was already accepted on create by the vault,
the CLI and `vault_create_item`.

No unit test — `pieces.tsx` and `ItemDetail.tsx` are exactly the kind of `.tsx`
module the desktop suite already excludes, since `tsx --test` importing JSX
drags React in. Verified with a clean `npm run typecheck` (which does cover
`CHILD_TYPES`'s `Record<ItemType, …>` exhaustiveness and the `overlaid`
boolean-to-union change) and, short of a full click-through, a Vite dev-server
fetch of all four touched files confirming each transforms without error.

## Comments get the description's editor ✅ built and driven

The comment box was an `<input>` inside a `mini-form`, so a newline could not be
typed at all, and bodies rendered as raw text. Both halves now reuse what the
description already had: `RichEditor` mounts in place of the input, and bodies
render through `Markdown` instead of `{entry.body}`. No core work — `addComment`
already only trimmed its input, and the frontmatter writer already emitted a
`body: |-` block scalar for anything multi-line.

**The comment editor takes `onChange`, never `onCommit`.** `RichEditor`'s
`onCommit` is what wires blur-to-save and Ctrl+Enter — the right bargain for a
description, which can be edited again after a stray commit. A comment cannot be
removed, so a half-typed paragraph posted because the sidebar was clicked would
be permanent. The cost is real and was taken deliberately: Enter now types a
paragraph instead of submitting, and Ctrl+Enter is dead rather than merely
unbound, because `commit()` returns early with no `onCommit` to call. Posting is
type-then-click-**Comment**, full stop. `onCancel` is omitted for the same
reason in miniature — Escape would discard a paragraph with no undo, and stays
the panel's key instead. Both omissions are also why the toolbar's
`Ctrl+Enter saves · Esc cancels` hint does not render on this mount; that
condition already existed in `RichEditor`, unchanged.

**`.description` split into a frame and `.prose`.** The old rule was two
stylesheets in one selector — chrome (background, border, padding, cursor) and
typography (font size, heading scale, list/quote/code rules) — and a comment
wants only the second: `.comment` already draws its own left rule, and a
bordered inset box nested inside it would read as an editable field, which a
posted comment is not. Renamed rather than duplicated, the same reason
`description.ts` is one grammar instead of two: thirteen descendant selectors
moved from `.description X` to `.prose X`, and the three mount sites
(`Editable.tsx`'s read view, `RichEditor.tsx`'s `rich-surface`, and the new
comment body) each carry both classes now. `.comment-body`'s own font-size and
line-height became redundant once `.prose` supplied them and were dropped;
`white-space: pre-wrap` was deleted outright, since rendered markdown supplies
real line breaks and pre-wrap would double every gap between blocks — the same
trap `.description` had already hit once.

**Rendering old comments as markdown reinterprets them, and that was accepted
rather than avoided.** Every existing comment was typed into a plain input by
someone with no reason to think markdown was in play; a body opening `- `
becomes a bullet, `*roughly*` loses its asterisks. Unfixable, since a comment
cannot be removed — but measured rather than guessed: the example vault held
exactly one comment that rendered differently, and it rendered *better* (a
backtick span someone clearly meant as code). No `format` flag, no per-comment
opt-out — a second grammar for comments would be the drift `description.ts`
exists to prevent, and comments are not pushed to Jira, so there was never a
correctness argument for a richer one.

`commentGeneration` remounts the editor after a successful post, `CreateDialog`'s
`draftGeneration` trick under a local name — `useEditor` takes its content once,
at mount, so `setComment("")` alone would clear the state and leave the typed
text on screen.

No unit test, consistent with the rest of the panel: `ItemDetail.tsx`,
`RichEditor.tsx` and `Markdown.tsx` are all `.tsx` the desktop suite already
excludes, since `tsx --test` importing JSX drags React in.

**Driven in the real app** instead, against the seeded fixture vault, under
`apps/desktop/e2e/comment-editor.e2e.mts` — see "Driving the desktop app with
Playwright" below for the harness itself. The old comment renders as markdown
while the file on disk still holds its literal backticks, the bargain this
feature actually struck. The `Ctrl+Enter saves · Esc cancels` hint is absent
from this mount, proven against the description editor's own hint as a positive
control rather than trusting an unrendered `.field-note` to mean what it looks
like it means. Blur does not post, with the blur itself confirmed via
`document.activeElement` before concluding anything from what did not follow
it. Ctrl+Enter is inert, confirmed by zero `<br>` and byte-identical text
rather than only an unchanged comment count, so a capture-phase handler that
later moved to the bubble phase would still be caught. And posting for real
works — the positive control the two negative checks above depend on to mean
anything at all.

The one check that still wants a person: a nested `> quote`'s left border
reading fine next to the comment's own, in both colour schemes. Two same-width,
same-coloured `border-left` rules stacked can only be proven offset by a
measured amount, not proven to actually *read* as two rules rather than one
thick line or an artefact — the same limit the reporter datalist's "a check
that reads the DOM cannot verify a native control" already put a name to.
`apps/desktop/e2e/artifacts/panel-dark.png` and `panel-light.png` are that
check, and being looked at by a person is what discharges it.

## Driving the desktop app with Playwright, so a click-through stops needing a human ✅ built and driven

The comment editor above was the trigger, but not a one-off: `ItemDetail.tsx`,
`RichEditor.tsx` and `Markdown.tsx` are exactly the `.tsx` the desktop suite
deliberately excludes, since `tsx --test` importing JSX drags React in. So the
panel where most recent work has landed had no automated coverage of any kind,
and every change to it ended the same way — a green typecheck, unverified
behaviour, and a note asking someone to go and look. `npm run e2e` now builds
core and the app, launches the built app against a throwaway vault, drives the
comment editor, and answers those questions — leaving a harness the next panel
change reuses instead of rebuilding.

**`playwright-core`'s `_electron`, not `@playwright/test`** — and **this
supersedes the two "not installed" notes above**, on the related-items status
colour and on bulk edit, rather than editing them: both drove the app over
`--remote-debugging-port` and Node's global `WebSocket` because
`playwright-core` genuinely was not installed at the time. It is now. The
tempting argument against it was the install script — `@playwright/test` pulls
`playwright`, which downloads three browsers this harness would never launch —
but that argument does not hold: the script only downloads browsers, so
`allowScripts: { playwright: false }` would deny it with no functional loss,
Electron already being the browser. The decisive argument is that
`@playwright/test` cannot be run by `tsx --test` — it wants its own CLI, its own
config, its own idea of what a test file is — and this repo has exactly one test
runner. A second one means two answers to "how do I run a test here," a
permanent conceptual cost the polling loop below did not need bought. Auto-
waiting lives in the *library*, not the runner, and comes with `playwright-core`
unchanged — every action retries actionability and every read that resolves an
element waits for it, which is the overwhelming majority of e2e flake, free.
What auto-waiting does not cover is a read that answers about right now
(`count()`, `isVisible()`, …), and "the comment list grew by one" is only true a
React render after the IPC round trip — so `eventually()` and `stays()` in
`e2e/drive.mts` were the only waiting logic this needed writing. The honest cost
is the trace viewer; partly bought back by piping the renderer's console and the
main process's stderr into the test output, and screenshotting the failing case
on the visual check. And the dependency itself: `playwright-core` installed at
~14 MB with no browser download, against a `node_modules` already at hundreds of
MB whose `electron` alone is 351 MB — and `electron` is itself a
`devDependency`, as are `react`, `vite` and `typescript`. Nothing here builds or
launches without them, so "why is a test tool in everyone's install" has an
answer worth writing down once rather than re-arguing at review time.

**`.mts`, not `.ts`.** `apps/desktop` has no `"type": "module"`, so tsx
transpiles a `.ts` file here to CJS — and `todo-vault` is `"type": "module"`
with no CJS entry, so `import { Vault } from "todo-vault"` would become a
`require()` of an ESM-only package, working only on Node ≥22.12 while `engines`
says `>=22`. `.mts` is unambiguously ESM regardless of the package's own
`type`, matching `scripts/*.mts` at the repo root. A fourth tsconfig
(`tsconfig.e2e.json`) rather than folding `e2e/**` into `tsconfig.test.json`:
that config uses `"moduleResolution": "bundler"`, `.mts` with `.mjs`-suffixed
specifiers wants `NodeNext`, and `*.ts` globs do not match `.mts` regardless. It
is wired in as a fourth `tsc --noEmit -p` pass, which does pull `e2e/**` into
CI's `check` job — deliberately: `playwright-core` has no browser to download,
`npm ci` installs it in seconds, and typechecking reads its types without
launching a binary.

**A throwaway vault, and a `--user-data-dir` checked against the app's own
answer, not the string passed in.** The desktop app ignores `VAULT_DIR` — only
the core's CLI and MCP server read it — so the only way in is an isolated
`--user-data-dir` holding a pre-written `settings.json` naming a throwaway
vault, which also avoids the first-run picker's native OS dialogs that no
harness can click. Before the harness does anything else it asks the running
app for its own `app.getPath("userData")` over Electron's `evaluate` and asserts
that answer — not the path this run constructed — resolves under the OS temp
directory. If `--user-data-dir` were ever silently ignored, the app would open
whatever vault this machine last used and every write this suite makes would
land in it: not a flake, damage. `git init` plus a repo-local identity, not
merely `git init`: `VaultService` always opens `{ git: true }` and the core's
auto-commit is best-effort and never throws, so a vault with no identity at all
would not fail — it would silently fail to commit on every write, leaving
`gitStatus().healthy` false and a `banner-info` in `App.tsx` shifting every
screenshot down.

**Teardown asks, checks, then insists.** An earlier driving run, on the
`reporter` field above, recorded `app.close()` not killing the instance, leaving
two briefly live at once — so `close()` here races `app.close()` against a 10s
timeout, checks `process.kill(pid, 0)` for whether the Electron process is
actually gone, and only then runs `taskkill /pid <pid> /T /F` (`/T` for the GPU
and utility child processes, which would otherwise keep the temp directory
open). `fs.rm`'s own retries never clear a Windows `EPERM` — git marks objects
under `.git` read-only, the same reason a Windows worktree refuses to delete —
so removal falls back to `cmd /c rd /s /q`. And because a crashed run can still
leave a leaked Electron holding handles no amount of retrying will free, every
new run first sweeps sibling temp directories over an hour old: the only cleanup
that reliably happens is the one done by the *next* run, not the one that made
the mess.

**Six checks, all under `apps/desktop/e2e/comment-editor.e2e.mts`, one app and
one vault, run in order.** An old plain-text comment renders as markdown while
the file keeps its literal backticks. The `Ctrl+Enter saves · Esc cancels` hint
is absent from the comment form, proven against the description editor's own
hint as a positive control. Blur does not post — with the blur itself confirmed
via `document.activeElement`, the biggest false-pass risk in the file, before
concluding anything from what did not follow it. Ctrl+Enter is inert, confirmed
by zero `<br>` and byte-identical text rather than only an unchanged comment
count. Posting for real works, the positive control the two negative checks
depend on to be falsifiable at all. And a quoted comment's border sits at least
~8px inside the comment's own — mechanical, and paired with three screenshots in
`e2e/artifacts/` (gitignored) for the part no DOM assertion can prove, per the
reporter datalist's lesson above. Proved the suite can actually fail by
temporarily flipping the Ctrl+Enter check to expect a post, watching it go red,
then reverting. Across the whole run the real `vault/` at the repo root stayed
untouched — same precedent the reporter section set.

CI stays out of scope, deliberately: it belongs in `ci.yml`'s **`build`** job,
which already caches the Electron download, not in `check`, which never
downloads Electron and would otherwise pay the ~150 MB twice across the Node
22/24 matrix.

## `vault-capture` and `vault-update`, the draft-then-confirm step for an external Claude ✅ built and driven

The in-app assistant already solves this problem once: `claude.ts` hands
Claude the live project list, categories, and labels in use, then drafts
straight into the create form, where the user sees every field before
anything is written. An external Claude talking to the vault through the MCP
server has no form. Every write tool looks identical from outside —
`vault_update_item` moving a due date and `vault_move_item_to_project`
re-keying a subtree are both one call — and nothing prompted filling in the
fields (category, labels, parent, due date, reporter) that make an item
findable a month later instead of a bare summary nobody can find again.

Two project skills, `.claude/skills/vault-capture/` and
`.claude/skills/vault-update/`, split on trigger rather than tool — "add a
task" and "push it to Friday" arrive in different moods and need different
material in front of them. Alongside `git-recover` / `ship-change` /
`start-change`, so they ship with the repo on clone and are scoped to this
checkout, the same trade those three already made.

**The draft is the question, not an interrogation.** The naive reading of
"ask or assume" is a per-field decision procedure, which produces five
questions before a single task exists. Inverted instead: resolve everything
into one complete draft, mark what was inferred with a `←` note, and let one
reply correct all of it. A question only comes *before* the draft when it
truly can't be built without an answer — no project fits, two fit equally, or
the note implies an illegal hierarchy. Category and label reuse comes from
reading `vault_list_items` before drafting, the same context `claude.ts`
already assembles, rebuilt from the MCP side.

**The confirmation ladder comes from two axes, not a field list.** Who chose
the change — named by the user, or inferred by Claude — crossed with what it
costs to be wrong — cheap to undo, or hard/wide. A named, cheap change (a due
date) just happens, reported in one line after the fact. An inferred or
costly one gets confirmed, and for a costly one the confirmation says what it
touches, not just what it is — "re-keys ACME-4 and its subtask ACME-5, drops
the ACME-1 epic link" rather than "move ACME-4 to OPS?" A list of fields would
need re-deriving by hand for every case it didn't anticipate; the two axes
don't.

Twelve traps are encoded in `vault-update/references/significance.md`, each
one a case where a tool's own description states the rule correctly but too
late — by the time an agent has already chosen `vault_update_item` with a bare
`labels: ["urgent"]`, the four words in that tool's description warning that
labels replace the whole list are behind it. The skill's job is catching the
moment ("add a label" *sounds* like it should be additive) before the call is
reached for, not restating rules the tool descriptions and `SCHEMA.md` already
carry correctly.

Driven against the real dev vault on the branch before merging, each check
reverted after: capture on "add a task to chase the renewal quote" reused the
existing `Procurement` category and `vendor` label rather than coining new
ones; "add a label 'urgent' to ACME-6" preserved `reporting` and `finance`
through a read-modify-write; "I did the morning batch check" on the daily-
cadence `OPS-1` ticked it and left `status` at `todo` rather than closing it
for good; and forcing `ACME-10` from `todo` straight to `in_review` failed
exactly as `SCHEMA.md`'s transition table says it should, then succeeded once
routed through `in_progress`, which also confirmed the `startDate` auto-stamp
along the way. The remaining prompts in the plan's eleven-prompt test table —
a project-move confirmation, `copy: false` on a synced-folder path, a project
rename, a four-item brain-dump split — were left unrun in favor of shipping
the four covering the sharpest failure modes: silent data loss, a permanently
retired recurring item, and a hard validation error.

Left for later, sketched in the plan and not built: `vault-groom` (the
hygiene sweep — stale `in_progress`, missing categories, orphaned epics),
`vault-jira-push` (the multi-tool push loop, worth building once Jira use is
more than one item), and `vault-review` (agenda reporting, lowest priority
since `vault_get_agenda`'s own description already carries most of the
banding advice).

## A Calendar view, beside Agenda ✅ built and driven

A fifth tab, between Agenda and History because the two date-shaped views
belong together. The agenda ranks; the calendar arranges — a month grid is the
one layout that makes density visible, answering "what does the shape of this
month look like" where the backlog column, the board card, and the agenda's
list all only answer "what is coming up."

**It reads `filtered`, not the core.** Deciding which dates count as "this
week" is core logic the agenda rightly goes over IPC for, but a month grid is
pure layout over items that already carry a date. So `calendar.ts` +
`CalendarView.tsx` work from `filtered` in the renderer, the way the board and
backlog do — every toolbar filter narrows the grid the same way it narrows the
board, unlike the agenda, which notably takes only `visibleItems` and a scope.
No new IPC channel, no `shared/api.ts` change, no main-process work, and it
re-renders synchronously with every edit.

**Due dates only.** An item appears on a day when `item.dueDate` equals it;
recurring items appear only if they also carry one. Projecting cadences onto
the grid (a weekly item landing on each Monday) was considered and rejected —
a single daily item would put a chip in every cell, burying the deadlines the
view exists to show. Recurrence is a schedule, not a deadline, and the agenda
already has a section that says so.

**Sunday-anchored weeks**, deliberately apart from `recurrence.ts`'s
Monday-anchored `startOfWeek`. The two consumers that key off that shared
anchor — the agenda's week bands and a weekly cadence's period — never draw a
grid, so there was no second consumer for the calendar's own visual anchor to
stay in step with. A small local `sundayOnOrBefore` in `calendar.ts` handles
it, tested on its own in `test/calendar.test.ts` alongside `stepMonth` and the
priority/key tie-break `compareWithinDay` uses within a day.

**The grid grows; it does not truncate.** Rows are `minmax(110px, auto)`, so a
heavy day makes its week taller rather than hiding chips behind a "+N more" —
which would break the keyboard walk, since `j` stepping onto an off-screen chip
is exactly the failure `orderedKeys` exists to prevent.

**Overdue work from before the visible month** gets a one-line banner above
the grid with a jump-to-earliest button, so the view never silently reads as
"you are clear" just because last month's deadline scrolled off the left edge.

Phase 1 shipped the read-only grid: `calendar.ts`, `CalendarView.tsx`, the tab
(renumbering History from `4` to `5`), the month stepper, `[`/`]` to page
months, and `j`/`k` walking the grid in reading order through `orderedKeys`.

**Phase 2, drag to reschedule, followed the same session.** `Board.tsx` was
the working model: `@dnd-kit/core`'s `DndContext` wraps the grid, each day
cell is a `useDroppable` keyed on its own `YYYY-MM-DD` — already globally
unique across the grid, leading/trailing days included, so no composite id
was needed the way the board needs one for `project` + `status` — and each
chip is a `useDraggable` keyed on the item's key. Dropping fires
`vault.mutate(() => window.vault.updateItem(key, { dueDate }))`, a plain field
on `UpdateItemInput` that needed no schema change. Deliberately kept out of
Phase 1: a calendar that only reads is useful on its own, and a mis-drop that
silently rewrites a deadline is a worse bug than a missing feature — so it
shipped once the read-only view had already proven itself.

Driven end to end against the built app: a chip dragged from a seeded item's
due date onto today's cell moved the due date on disk and the chip followed
in the DOM, checked on both layers the way the comment-editor e2e suite
already does. No permanent e2e file was added — the drag path was verified
with a throwaway script against `e2e/harness.mts`, then deleted, in line with
the plan's own "Verifying it" section treating this as a by-hand check rather
than an addition to the unit suite.

**The seven columns came out uneven, and the fix was one keyword.**
`.cal-grid` read `grid-template-columns: repeat(7, 1fr)`, which looks like
seven equal fractions and is not one: `1fr` is shorthand for
`minmax(auto, 1fr)`, and grid track sizing always satisfies every track's
*minimum* before the `fr` units divide whatever space is left. With `auto` in
that minimum slot, a track can never end up narrower than its widest chip's
min-content width — and `.cal-chip`'s `white-space: nowrap` makes that width
the chip's entire un-truncated summary, since intrinsic sizing runs before
`overflow: hidden` / `text-overflow: ellipsis` get a chance to clip anything.
The practical effect: a Tuesday holding a long summary grew visibly wider than
its neighbours, the header row (sharing the same grid) drifted out of line
with the days below it, and past a certain point the whole grid started
scrolling sideways — which a seven-day week, unlike the board's paginated
columns, has no business ever doing. The fix takes content out of track
sizing entirely: `repeat(7, minmax(0, 1fr))`. An explicit `0` minimum means
all seven tracks split the container evenly regardless of what is inside
them, and the truncation CSS that was already sitting on `.cal-chip` — written
for exactly this, never once engaged — finally does its job. Deliberately not
given the board's `minmax(170px, 320px)` floor: the board can fall back to
horizontal scrolling because its columns are a list that happens to be six
long, but a week is fixed at seven and cannot be paged, so a floor would just
push the seventh day off the right edge instead of narrowing it. The window's
own 900px `minWidth` already bounds how far the columns can shrink.

Verified with a new permanent spec, `e2e/calendar-columns.e2e.mts`: a positive
control confirming a chip is genuinely truncated (unfalsifiable without it —
seven equal columns is also what an empty grid or the wrong view produces),
equal day-column widths, the weekday header aligned to the columns below it,
and equal-and-widening columns with no horizontal overflow across a resize
from 1000px to 1600px, screenshotted at both. Running it against the
pre-fix CSS first, deliberately, showed the mechanism rather than assumed it:
the positive control itself failed — no chip truncated, because the track
was still growing to fit it — alongside the uneven-column assertion. 10/10
desktop e2e, 112/112 core unit tests, typecheck clean.

## Assignee gets the menu Reporter already had ✅

Reporter and Assignee sit next to each other, hold the same kind of value —
a person's name, typed free-hand, `max(120)` in the schema — and behaved
completely differently. Reporter offered every name the vault had ever been
told; Assignee was a bare text box. The asymmetry was not a decision anyone
made, it was where the work stopped: `knownReporters` was written for the
reporter menu, wired into the two places that needed it, and Assignee was
never revisited. The consequence was the one a suggestion menu exists to
prevent — the same person accumulating as "Dan Okafor", "dan okafor", and
"Dan  Okafor" with nothing offering the spelling already in use.

`knownReporters` generalized into `knownPeople(items, field)` in
`pieces.tsx`, kept as a thin wrapper at its old name because it reads
better at its call sites and because the doc comment above it — about why
the list is derived rather than stored, and how spellings fold — was worth
keeping attached to something. `App.tsx` derives `allAssignees` from the
whole snapshot the same way it derives `allReporters` (hidden projects
included — a name is not an item, and hiding a project should not make a
colleague un-nameable). `ItemDetail`'s Assignee field gets `suggestions`
the same way Reporter's does.

`BulkBar`'s Assignee input got a matching `<datalist>` rather than
`Suggest`, deliberately, even though `Editable.tsx` carries a pointed note
about why `datalist` was wrong *there*: Chromium filters the native popup
against the input's existing value, so a box already reading "Dan Okafor"
offers a menu of one name. The bulk bar's boxes are always empty — they
reset after every commit, because a pick there is an instruction rather
than a fact about the selection — so that failure mode can't arise. And
`Suggest` doesn't express the bulk bar's actual commit semantics anyway:
Enter commits even when empty (clearing the field across the whole
selection), blur commits only when non-empty (a passive click elsewhere
must not read as "clear the assignee for twelve items"), Escape discards.
`CreateDialog` was left alone on purpose — there is still no Assignee
field on the create form, for the same reason Reporter's comment already
gives: who wants the work is known while logging it, who will do it
usually is not.

Taken with it: once the menu folds spellings for Assignee, an exact-match
filter would contradict it — pick "Dan Okafor" off the menu and a query for
"dan okafor" would miss the item just written, which is precisely the
failure the reporter fold was introduced to avoid. `Vault.listItems` now
folds `filter.assignee` case-insensitively in the same pre-pass `reporter`
already gets, the free-text search haystack (`vault.ts` and `App.tsx`'s
client-side filter both) now includes `assignee`, and `schema.ts` /
`SCHEMA.md` describe one rule for both fields instead of spelling out an
asymmetry that no longer existed.

112 core tests green (new: case-insensitive assignee filter, mixed
whitespace/case, assignee-only text search), 65 desktop tests green (new:
5 `knownPeople` tests covering fold, tie-break, whitespace-only values, and
parity between the two fields over the same data), typecheck clean.
Verified by hand against the running app: the detail panel's suggestion
menu, the bulk bar's native datalist popup and its empty-box commit
semantics, and a hidden project's assignee still surfacing in the menu.

## The theme is chosen rather than inherited ✅ built and driven

The app has had a light theme since `004a8f3`, the first Electron commit —
`index.css` carries a `@media (prefers-color-scheme: light)` block that flips
`color-scheme` and redefines the surfaces. What it never had was a way to say
which one you wanted. The OS decided and the app followed, silently: on a
machine reporting light there was no way to see the dark design the app was
actually built against, and on one reporting dark, no way out.

The mechanism is `nativeTheme.themeSource`, not a `data-theme` attribute on the
document, and the stylesheet was not edited at all. `themeSource` changes what
`prefers-color-scheme` reports in every renderer, so the media query that has
been there since day one simply *becomes* the thing the button drives. The
attribute was rejected for a specific reason rather than a stylistic one:
keeping a "follow the OS" option means keeping the media query whatever else is
added, so an attribute would leave the palette with two independent ways of
being chosen — exactly the seam a future token gets added to only one side of.
That is not hypothetical here. `--disregard` was added to `:root` in `e383a5b`,
a day after light mode already existed, and never got a light counterpart, on a
codebase that has only ever had one selection mechanism.

`themeSource` also reaches what CSS cannot. `color-scheme` follows it, so
Chromium's own controls flip with the page — the date picker's popup and its
indicator icon, scrollbars, focus rings — which is the thing `index.css`'s own
comment at the `color-scheme: dark` line is already an argument for: without it
the date input's calendar icon rendered dark-on-dark and the picker "was there
the whole time and simply could not be seen." On Windows the window frame
follows `shouldUseDarkColors` for free.

Three states rather than a toggle, borrowing `themeSource`'s own vocabulary:
nothing in a boolean can express "I have no opinion", so a two-position switch
would strand the user the first time they pressed it, with "follow the OS"
unreachable forever. `system` stays the default and an absent `theme` key in
`settings.json` means `system`, so upgrading changes nobody's rendering.

Theme went into `settings.json` beside zoom, on the argument that file's own
comment already makes — it "is a property of this screen and these eyes, not of
the vault" — but it is applied at a *different moment*, and that difference is
the whole point. `restoreZoom` runs on `did-finish-load`, after the renderer has
painted, which is fine because a page resizing a tick late is invisible. A
theme applied a tick late is a flash of the wrong palette on every launch, so
`applySavedTheme()` runs inside `whenReady` before `createWindow()`. The
consequence removes work rather than adding it: the renderer never fetches the
theme in order to render, only to label its own button, and a label that
resolves one tick late is not visible to anyone.

Which made `backgroundColor: "#111318"` — the colour Chromium paints before the
renderer's first frame — a bug one line below the fix, since under light mode it
is a near-black flash on every launch. It resolves from
`nativeTheme.shouldUseDarkColors` now, and `setBackgroundColor` is called again
when the toggle flips so a later reload does not flash the scheme just left.
While there: `#111318` was never `--bg`, which is `#0f1115`. Harmless in the
dark-only world, but the pre-paint colour exists specifically to be
indistinguishable from the first painted frame, so both constants are the token
values exactly and carry a comment saying they are copies that must move when
`--bg` moves. Main cannot read the stylesheet, so the duplication is
unavoidable; saying so is the mitigation.

The control is one `.btn` in the `.sidebar-foot` row, beside Folder / Trash /
Hidden / Switch / Claude / ?, cycling `◐ Auto → ☀ Light → ☾ Dark`. Not a
three-segment `.chips` group, which is otherwise the house idiom for a small
exclusive set: the sidebar is 236px and that row already wraps at six buttons.
It is labelled with the state it is *in*, never the state pressing would move
to, which settles the ambiguity every mode button has — "does ☾ mean it *is*
dark, or that pressing makes it dark?" — and is the reading that stays true when
the OS flips underneath `Auto`. No keyboard shortcut and no palette entry: a
theme is set once and left, `SHORTCUTS`' Display group is for things pressed
while working, and `CommandPalette` has no command layer to add one to.
Accepted limitation: `.sidebar-foot` only exists once a vault is open, so the
button is unreachable from `Welcome` — which is the wrong moment to be adjusting
a theme and the right one to be picking a folder.

**What the e2e found, and it was not in the product.** The plan flagged one
thing to confirm while writing the spec: whether Playwright's
`page.emulateMedia({ colorScheme })` — which `comment-editor.e2e.mts` uses to
screenshot both schemes — would fight `themeSource`. The answer turned out to be
worse than the question. `electron.launch`'s `colorScheme` option **defaults to
`"light"`**, so Playwright has been forcing `prefers-color-scheme: light` over
CDP in every e2e run since the harness was written, above anything the app does.
The first run of this spec watched Electron flip to dark — `themeSource` and
`getBackgroundColor` both agreed — while the page sat at `rgb(247, 248, 250)`,
the light `--bg`. The harness grew a `colorScheme` passthrough and this spec
passes `null`, which resets to the system default; every other spec keeps the
`"light"` default deliberately, because that is what stops their screenshots
depending on the OS theme of whichever machine ran them. The flip side is
reassuring: `comment-editor.e2e.mts` was never at risk, since its emulation sits
*above* `themeSource` rather than beside it.

The harness also grew what the plan assumed it already had. It hardcoded
`{ vaultRoot, zoomLevel: 0 }` and `close()` removed the whole temp stem, so
there was no seam to seed a theme and no way to relaunch against the same
`userData`. `launchHarness` now takes `settings` and `stem`, exposes
`userDataDir` and `stem`, and `close({ keepStem: true })` leaves the stem for a
relaunch — which is what makes the no-flash check possible at all, since
`win.getBackgroundColor()` reads the colour painted *before* the renderer exists
and no page assertion can see that.

231 tests green (new: 5 in `test/theme.test.ts` — the cycle closes from every
starting point, holds each preference once, has a label and a spoken description
for every state, and recovers to `system` from an unrecognised value), 21 e2e
green across four specs, typecheck clean on all four desktop projects. The e2e
proves the part that matters: `getComputedStyle(document.body).backgroundColor`
resolves to the dark `--bg` after two clicks, which — since no CSS was written
for this feature — is the evidence that the untouched media query is the thing
the button drives.

Checked afterwards by hand, and both fine: the date picker's popup and its
indicator icon follow into Light and back, and the Windows frame follows into
Dark. That was the pair a `data-theme` attribute would have failed silently.

## Identity colours are chosen against both grounds ✅ built and driven

Part 2 of the same plan, and the thing that turned light mode from offered into
supported.

The light block redefined twelve surface tokens and left ten identity hues —
every status, and three of five priorities — at values chosen against `#0f1115`.
Diffing the block against its first version shows it was *born* that way rather
than drifting: it covered surfaces and skipped identity colours from the start.

**But the plan's ranking of the damage was wrong, and measuring it said so.**
The plan's by-hand check was whether the six status dots stay distinguishable at
6px in light, with `--disregard` called "the worst possible token to have
missed". Measured, `--disregard` lands at 3.05–3.49:1 on the light surfaces —
it clears the 3:1 that non-text UI owes, and it was confirmed fine by eye. The
real failure was the tokens that also render as *text*, which that check never
looks at: `--done` is **1.97:1** as `.history-diff-add` on white, and
`--overdue` is 2.60:1 as `.due-overdue`. The History view's whole red/green diff
was failing WCAG AA, and the dots — the thing being inspected — were the half
that mostly worked.

Three things the plan did not mention at all. `--lowest` already *had* a light
value and it was still wrong at 2.63:1, which breaks the rule the plan wanted to
write down — "a token in `:root` and not in the light block is a bug" catches
omissions, not bad values. The three `color: #fff` literals were framed as a
light-mode problem, and two of them are a *dark*-mode problem: `.btn-primary` is
white on `--accent`, which is `#6ea8fe` in dark, at **2.42:1**. And
`.btn-danger:hover` is white on `--overdue` at 2.77:1 in both schemes.

Ten tokens turned out to be seven hues — `--highest`/`--blocked`/`--overdue`
are one red, `--low`/`--todo` one grey — so the design work was smaller than the
count implied. The values were chosen to a 3:1 floor against all three light
surfaces, 4.5:1 for the three that render as text, and checked for mutual
separation with ΔE2000: the closest pair in light is in-progress against
in-review at 15.1, where dark's closest is 16.6. Light is now at least as
distinguishable as dark rather than merely passing.

Two picks worth their reasoning. `--in_progress` takes `--accent`'s light value
because it holds `--accent`'s dark one — that equivalence already existed in the
dark palette, and leaving `--in_progress` behind would have dissolved it in one
scheme only. And `--low` moved despite clearing the floor on its own: `--lowest`
has to stay lighter than `--low` while still reaching 3:1 on `--bg-inset`, and
there was no room under `#7f8796`, so `--low` had to make some. `--todo` and
`--disregard` are the two left unchanged, because the warm/cool split the
`--disregard` comment reasons about is a property of the *pair*.

The three `#fff` became `--on-fill`, defined in both blocks: dark ink in the
dark scheme, where the fills are pale, and white in the light one, where they
are dark.

**The mechanism, which is the part that outlasts the values.** The plan proposed
writing a rule into this document. A rule here would not have caught
`--disregard` either — nothing did, for months. So the invariant is enforced in
`test/tokens.test.ts` instead: every colour in `:root` must appear in the light
block, neither block may introduce a colour the other lacks, every identity
token must clear 3:1 against all three grounds *in both schemes*, the ones that
render as text must clear 4.5:1 where they render, `--on-fill` must be readable
on every fill it is painted onto, and no rule outside the two token blocks may
hardcode a colour literal. The light block now restates every colour including
the three that come out identical, because one redundant line is what separates
"checked, correct against white" from "nobody looked".

It earned itself on the first run by failing on something nobody had suspected:
`--lowest` at `#5d646f` is **2.94:1** against `--bg-raised` — in the *dark*
palette, which this whole plan treated as the finished half. Nudged to `#646c78`.

Left alone deliberately: the twelve `rgb(0 0 0 / …)` values the plan wanted
moved behind tokens. Nine are `box-shadow`, and black shadows on light surfaces
are how light UIs cast shadows; the two backdrops at `0.55` are scrims, where a
heavy dim is the intent in both schemes. Also left: on a selected row the ground
becomes `--accent-dim` and the greys fall to ~2.4:1 — pre-existing, worse in
dark (`--lowest` at 1.5:1 there), and a question about `--accent-dim` as a
selected background rather than about these hues. Both are recorded in the
stylesheet rather than silently skipped.

237 tests green (6 new in `test/tokens.test.ts`), 21 e2e green, typecheck clean,
and screenshots of the board, the backlog and the command-palette scrim read in
both schemes. Not verified: nothing was checked on a real display other than
this one, so the values are right by measurement and by one pair of eyes on one
monitor.

## The board drops the columns its filters have emptied ✅ built and driven

"Hide closed" defaults on and excludes `done` and `disregard` from `filtered`,
so the board drew six columns of which two were structurally, permanently
empty — not empty right now, empty for as long as the checkbox stayed ticked,
which is nearly always. `.column`'s `min-width: 170px` comment recorded why:
six columns fit the default 1360px window with nothing to spare, so the four
that hold work were squeezed to make room for two that never would.

**The rule is "impossible", not "empty".** `visibleBoardStatuses(openOnly,
status)` in `ordering.ts` drops a status when the current filters make it
unreachable, never because nothing happens to be in it. "Hide empty columns"
was the tempting simpler rule and wrong in a way that shows up immediately: an
empty Blocked column is still where you drag a card *to* block it, and it
would flicker as you worked — dragging the last card out of a column would
make the column you just emptied disappear from under the cursor. The
impossibility rule can only change when a filter changes, a deliberate act.
Folding the status select into the same rule cost nothing and fixed the
identical complaint one control over: picking "To do" alone used to leave five
empty columns for the same reason ticking Hide closed left two.

**One function, threaded through both existing entry points rather than a new
one.** `boardColumns` and `boardLanes` gained a `statuses` parameter
defaulting to `BOARD_ORDER`, and `App.tsx` computes `boardStatuses` once via
`useMemo` and passes it to both `<Board>` and the `boardLanes` call inside
`orderedKeys` — the same arrangement `grouped` already had, for the reason
recorded when grouping was built: the keyboard cursor walks the order the eye
sees, and the only way to guarantee that is for there to be one answer to what
that order is. Threading the list into `boardColumns` mattered for a second
reason: that function's own comment already promises "nothing in `items` may
silently fail to appear," and a bucketing pass over a short status list would
have broken that promise for any card whose status wasn't in it. The property
test that promise demanded — every status an item surviving `filtered` could
carry is in `visibleBoardStatuses`' result, for every `(openOnly, status)`
pair — is in `ordering.test.ts` alongside the named cases (`openOnly` alone,
a single status, and the zero-column combination).

**`--columns` already generalised.** It was set from `BOARD_ORDER.length` for
the sticky header row and every lane grid to agree on track count; it became
`statuses.length` and nothing else about that arrangement changed, which was
the entire payoff of that number never having been a literal `6` in the
stylesheet.

**Dragging a card closed survives losing the Done column, via a fixed strip
shown only while a card is in flight.** While `dragging` is non-null, a bar
pinned to `.content` renders one drop zone per status that is both currently
hidden and legally reachable from `dragging.status` via `canTransition`
(`hiddenReachable` in `Board.tsx`). The alternative — revealing the hidden
columns while dragging — was rejected in the plan and stayed rejected: it
would move the layout under the cursor, snapping every live column's width
mid-gesture the same way the file's existing note about regrouping mid-drag
already warns against. Each zone carries `{ kind: "column", project: null,
status }`, so `onDragEnd`'s existing column branch handles it with no new
logic — `project === null` already skips the lane check, correctly, since a
transition never moves an item between projects.

**The real snag was not the one the plan flagged.** It predicted dnd-kit's
default measuring strategy might miss a droppable that mounts mid-gesture, and
said to reach for `MeasuringStrategy.Always` if drops landed nowhere. Drops
registered fine; the actual problem was stacking order. dnd-kit's collision
algorithms compare rects, not paint order, so the card visually underneath a
strip zone was just as valid a `pointerWithin` match as the zone drawn on top
of it, and on a short board the card could win the drop. Fixed with a custom
`CollisionDetection` (`boardCollisionDetection`) that checks for a
`dropstrip:`-prefixed hit first and returns it alone when present, falling
back to plain `pointerWithin` and then `rectIntersection` — the same fallback
chain dnd-kit's own docs use, kept for the reason it's there in the docs: a
fast pointer flick can end a drag between measured positions, landing outside
every droppable under the stricter test.

**The zero-column case gets an explicit empty state**, not a blank screen.
`openOnly` on plus a status of Done or Disregarded makes every column
impossible at once, and the two controls sit inches apart in the same
toolbar. `statuses.length === 0` now renders `.board-empty`: *"Hide closed and
a status of {label} cannot both be true. Untick Hide closed, or pick another
status."*

**Widths.** `.column`'s `max-width` and the grouped grid's `minmax()` ceiling
both moved from 320px to 420px in `index.css`, because `flex: 1 1 0` and
`minmax(170px, 320px)` redistribute the freed space on their own but started
binding at the old ceiling sooner than the wider columns should have had to.
420 rather than no ceiling at all, because a card is a three-line clamped
summary and four unbounded columns on a large monitor would read as a table
that lost its table; six columns don't reach the new ceiling until well past
2000px of content width, so the unfiltered board is unaffected in practice.

Verified against the real app in `e2e/board-hides-columns.e2e.mts`, ordered
subtests against one harness following `calendar-columns.e2e.mts`'s shape:
the default board draws four wide columns with Done and Disregarded absent,
unticking Hide closed brings back six, picking a status narrows to one, Done
plus Hide closed shows the empty state, and dragging a card closes it through
the strip. `ordering.test.ts` covers everything that's a pure function; the
e2e file covers the part that isn't — layout, the gesture, and the one thing
the change put at risk, that closing a card still works once its column is
gone.

## One launch, one window ✅ built and driven

`npm run shortcut` put an icon on the desktop, and with it made a second
double-click an ordinary accident rather than something you had to type. The app
never asked for the single-instance lock, so a second click opened a second
window over the same vault. IDEAS.md asked for what two instances actually do to
be established before the fix, because that decides whether the second copy
should be refused outright or allowed and merely focused.

**What two copies do, measured rather than guessed.** A scratch Playwright probe
launched two copies against one vault and one user-data directory, then drove
both. The IDEAS entry's guess was the wrong one:

- *Stale rendering is not the problem.* An edit made in one window showed up in
  the other within the watcher's debounce. Each copy runs its own `chokidar`,
  and both see every write.
- *Key allocation is.* Six creates in one project, alternating between the two
  windows and fired together, came back as `OPS-6, OPS-6, OPS-7…`. Both calls
  returned success, and only one `OPS-6` exists on disk. The first item was
  overwritten and neither window said so. `allocateKey` is a read-modify-write
  of `.counters.json`. `VaultService.serialize` makes that safe inside one
  process and does nothing across two.
- *Git contends too.* Ten concurrent updates produced eight commits and a
  `Command failed: git add -A` in one window's `gitStatus()`, from the two
  processes racing for `index.lock`. Nothing was lost, because the other copy's
  next `add -A` swept the change into a commit that was not its own. But the
  history banner went unhealthy over a failure that had already healed, and the
  commit messages no longer described their commits.
- Chromium also logged `Unable to move the cache: Access is denied` over the
  shared user-data directory. That is cosmetic, but it shows the profile was
  never meant to be shared.

Silent overwriting decided it: **refused outright**, and the existing window
restored and focused. A second copy has nothing to offer that the first does
not, and "allowed and focused" would have meant keeping a process alive whose
only safe action is to do nothing.

**`requestSingleInstanceLock()` sits at module scope in `src/main/index.ts`, not
in the launcher.** A `.vbs` cannot focus a window it did not create, which is why
the shortcut change left it out. The refused copy calls `app.quit()`, and
`whenReady` also returns early on `!isPrimaryInstance`, because `quit()` is
asynchronous and a copy on its way out could otherwise still reopen the vault
and start a watcher. The `second-instance` handler restores, shows and focuses
`mainWindow`, or creates one if there is none.

**The refusal prints a line to the terminal.** The lock is keyed on `userData`,
which `npm run dev` shares with the desktop-icon copy. A developer who runs
`dev` while the app is already open now gets the running window focused instead
of a new one. Without the line, that looks exactly like the dev build failing
to start.

**The lock does not fix the key race; it removes the common way to reach it.**
The MCP server and the CLI are separate processes over the same vault, so an
external Claude creating an item at the same moment as the app still goes
through the same unguarded `.counters.json` read-modify-write. That race needs a
lock in the core (an exclusive-create lockfile around `allocateKey`, or
`createItem` refusing to overwrite an existing key file), and it belongs in its
own change. It got one: see "Two creates never share a key" below.

Verified in `e2e/single-instance.e2e.mts`. The spec launches through the
harness, minimizes the window, and spawns a bare second Electron against the
same `--user-data-dir` (not a second `launchHarness`, which would wait for a
vault table the refused copy never draws). It then asserts that the second copy
exits 0 inside 15 seconds, that the first window came back from minimized, and
that there is still exactly one window. Minimizing first is what makes the
handler's effect observable, because a window already in front looks the same
whether the handler ran or not. Run against the pre-fix build, the spec fails
with the second copy still running at 15 seconds. Each harness run gets its own
temporary user-data directory, so the lock is per run and parallel e2e runs do
not refuse each other.

## The pile can hide work that is not for today ✅ built and driven

Promoted out of IDEAS.md's "Scheduled as a seventh status", which asked for a
new status and was answered with two filters instead. The complaint was real: a
daily item ticked an hour ago held its slot in the `todo` column exactly like one
nobody had touched all week, and a task meant to begin in November looked, in
every view, like work actionable this morning. `startDate` was stored, edited
and pushed to Jira, and filtered nothing anywhere.

**Why not a status.** The question that decided it, and will decide the next one
like it: *does the item leave the state on its own, or does a person decide it
leaves?* A start date arriving and a recurrence period turning are both the
clock. A stored status for either goes stale the morning it comes true, and the
only fixes are a sweep on load — the app rewriting `status` on files it merely
opened, which lands in history as an edit nobody made — or nothing. Derived
filters have neither problem. The one case a status could still fit, "I have
decided not to look at this yet" with no date, stays in IDEAS.md as `parked`,
to be priced once the filters have been lived with.

**One control, not two.** IDEAS.md described two filters, and the core has them
separately. The toolbar folds them into a single "Hide later" beside Hide closed,
because to the person looking at the pile they answer the same question — is
this for today? — and the toolbar was already seven controls wide. `isLater` in
`later.ts` holds the reading as a pure function, tested in `later.test.ts`.

**Only `todo` is deferred by a future start.** An item in progress, in review or
blocked has begun, whatever its start date says. Moving into `in_progress`
stamps `startDate` with today anyway, so a future start on a started item is a
hand edit, and hiding the item it was typed on would hide the evidence.

**`isTickedFor`, not `isSettledForWindow`.** IDEAS.md named `isSettledForWindow`
as the helper a filter would want. That is right for the agenda, which asks
whether anything more is owed before a *window* closes. The backlog and board
have no window; they ask about today. A window ending today makes the two
functions agree, since every period containing today ends on or after it, and
`isTickedFor` says what is meant without a window argument that is always
`today`.

**Off by default, unlike Hide closed.** Closed work is finished, so hiding it
loses nothing. Later work is real work, and a card vanishing the moment someone
types a start date would read as the edit having deleted it. This is the one
place a default of "off" is doing the job a confirmation would otherwise do.

**Backlog and board only.** The calendar is where future-start work is meant to
be seen, so the checkbox is absent there rather than present and quietly
inverting that view's purpose. The agenda already drops settled items on its
own terms and has its own toolbar branch.

**The core gets `startBefore` and `startAfter`**, mirroring `dueBefore` and
`dueAfter` exactly — inclusive, and an undated item never matches — and
`vault_list_items` exposes both, so an outside Claude can ask what is not meant
to start yet. The app does not use them: its filtering runs over the snapshot in
the renderer, as every other toolbar filter does, and "undated counts as
actionable" is a different predicate from a date range anyway.

257 tests green (128 core, 85 app, 44 scripts), typecheck clean. Driven in the
real app by `e2e/hide-later.e2e.mts`, five ordered checks: off by default with
both kinds of later item listed, ticking it hides a future-start todo and a daily
ticked today while keeping a plain one, the board honours it, the calendar has no
such control, and unticking brings both back. Not verified: the filter's
reading at midnight. `today` is computed when `filtered` recomputes, not on a
timer, so a window left open overnight keeps yesterday's reading until the next
edit or filter change. That is true of every date the app shows, and not new
here.

## A CSV export Jira's bulk create can actually load ✅ built (PR #53)

`vault jira csv` existed, but it was a spreadsheet dump with Jira-shaped column
names. Nine columns wide and untested, it lost most of what the vault knows, and
the worst of that was silent. The `Parent` column carried the local key, and
with no `Issue Id` column for it to resolve against, an import *succeeded* and
arrived with every epic and story unparented.

**It extends `toJiraCsv` rather than adding a script.** The obvious reading of
"write a script to export tickets" is `scripts/export-jira-csv.mts`, and it
would have been a second interpreter of `jira-map.yaml`, free to drift from the
API path exactly as the old CSV path already had. The same item exported by CSV
and pushed by API produced two different issues: one had `buildDescription`'s
link footer and provenance line, and the other had the raw body. Running the
export twice created everything twice, because only `buildPushPlan` skipped
items Jira already held. So the *decisions* both paths must make identically
(eligibility, priority lookup, where `category` goes, whether a start date has a
field id) became named helpers in `jira.ts` that both call. The field
*derivation* deliberately stayed separate: REST wants nested objects and CSV
wants flat cells under readable headers, and a shared shape would have needed a
translation layer harder to read than the two loops.

**What the Cloud importer wants**, each for a reason that shows up only on a
real import:
- `Issue Id` and `Parent id` link rows within one batch. An out-of-batch parent
  already in Jira goes in `Parent` by its real key. An `Epic Link` column is
  added alongside when `fields.epicLink` is set, for older company-managed
  projects.
- Labels and components use repeated columns, not one space-joined cell. That
  takes two passes, because the header's width is the widest row.
- Descriptions are converted to wiki markup by `blocksToWiki`, a serializer over
  the same closed block subset `markdownToAdf` uses, so it can flatten but never
  fail.
- The file has a BOM and CRLF endings, so Excel does not mojibake it on the way
  to being checked by eye. Jira ignores both.

**People are the real import risk.** `assignee` and `reporter` are free text
typed by hand, and Cloud resolves a person column against real accounts: it
fails the row or offers to create a user when it cannot. `Assignee` is always
emitted, because an unassigned bulk import is not much use. `Reporter` is
opt-in behind `--reporter`, because it is the field most likely to hold a name
with no account behind it and the one Jira cares least about. Either way, the
command prints the distinct names it is about to emit, so they can be checked
before the import rather than after a half-failed one.

**`vault jira record --from <csv>` closes the loop.** A bulk import leaves Jira
holding new issues and the vault knowing nothing, so the next export duplicates
everything. `record` reads the file exported back out of Jira *by column name*,
since that file's column order is not ours to assume, and stamps each key with
`markPushed`. An unknown local key is reported and skipped. So is a local key
already stamped with a *different* Jira key, since that is either a double
import or the wrong file, and both want a human. Without `record`, the export
would be a one-shot, and a one-shot bulk loader gets run twice.

**Where the build departed from the plan.** The plan said the 500-row cap should
*refuse* rather than truncate. The build *pages* instead, reading `total` from
`listItems` and looping until it has everything, with a guard that stops if the
two ever disagree. A refusal would have made every vault over 500 open items
unexportable, which is the same failure moved to a different place.

**Found on the way: `category` was missing from `pushableFields`**, although
`buildPushPlan` pushes it. Editing a category left the content hash unmoved, so
the item read as pushed-and-unchanged indefinitely. That is the same bug the
`links` comment beside it records. It was latent until `record` existed, and
stamping made it live, because the whole point of a stamp is that the next
export skips what Jira already has. Adding the field changes the hash of every
already-pushed item, so the first export afterwards produces one burst of drift
warnings. That is correct: those items genuinely have an unverified category in
Jira.

**Not doing.** Status: the importer wants status *names*, while `jira-map.yaml`
holds transition names, a different vocabulary. Deriving one from the other
would fail rows for unrelated reasons, and open-only is already the default.
Attachments: a CSV can only reference a URL Jira can fetch, and a local path is
not one. Comments: the importer's `date;author;body` column format is brittle
and lossy, and `buildDescription` omits comments on the API path too.

Covered by `test/jira-csv.test.ts` (new), which tests the silent failures: a
parent and child linked by id, a label containing a space surviving as one
label, a description holding a comma, a quote and a newline round-tripping
through a CSV parser, skip versus drift-warn, BOM and CRLF, an object-valued
default warning rather than printing `[object Object]`, and a category-only
edit moving an item out of pushed-and-unchanged. **Not verified:** no file has
been loaded into a real Jira Cloud importer. The column names come from Cloud's
documentation, and its mapping screen lets a human pair columns by hand, which
limits the damage if one is off.

## `vault-capture` splits an ask into its deliverables ✅ built (PR #54)

A one-line ask, *"create a task for the Emailgistics epic to call Renee and
check stats against the logs"*, came back as one task with two verbs in its
summary. It was filed nowhere, because the epic did not exist, and Renee ended
up either lost in prose or put in `reporter`, although she asked for nothing.
That one sentence holds two deliverables, a container, and a person who is the
object of the work rather than a party to it.

**One test for splitting:** two clauses are two items when either could be
finished while the other is not. The manner, the acceptance criterion, or the
audience of a single outcome ("send the SOW and cc Legal") stays one item. The
test is deliberately about completion rather than grammar, because "and" joins
both kinds.

**A missing container is drafted as an epic, not asked about.** An epic is
cheap to re-parent later. A project is not, because its prefix is stamped into
every child key and re-keying is the costliest operation the vault has. So the
container becomes a project only when the user says so, and the draft names
that alternative in one line.

**`assignee` and `startDate` moved from "never guessed" to guessed with
evidence.** People resolve against the roster of names already in the vault. A
bare first name counts only if exactly one name matches, and an assignee is
inferred only when every open item in the project agrees. A reporter / assignee
/ neither table is what fixes the Renee case: the object of a verb is neither.
Every item now gets a proposed due date derived from the shape of the work,
because an item with no date and no cadence never reaches the agenda.
`startDate` is proposed only as a plan, since the first move to `in_progress`
overwrites it anyway.

**Not verified:** the change is skill prose only. No capture has been run
against a live vault with the new text, so whether it produces the worked
example's draft in practice is untested.

## History turns on from a button ✅ built and driven

Setting up history used to be a manual sequence nobody should have to know:
copy in a `.gitattributes`, `git init`, add, commit, and, the step that
actually bites, have a `user.name` and `user.email` configured first. Miss the
identity and `git add` succeeds while `git commit` fails, and `commit()`
swallows that by design. Every write lands and none is committed. The banner
in `App.tsx` already diagnosed this correctly. What was missing was anything to
click.

**The work is a core method, `Vault.turnOnHistory`, not desktop code.**
Everything it does is git plus the vault root, which is what the core already
owns. It also has to clear `lastCommitError`, which is private to `Vault` for
good reason. And a method there can be reached from the CLI or MCP later
without copying the sequence. The desktop side is one IPC channel,
`vault:turn-on-history`, the first git *write* across the boundary. It runs
through `VaultService.write` like any other mutation, because its
`git add -A` would otherwise race an auto-commit for `index.lock`, the same
contention measured in "One launch, one window".

**The order is the spec, and each step is where it is for a reason:**

1. *Identity before `git init`.* Checked with `git config --get` at every
   level. If it is missing, the method returns `needs-identity` before writing
   anything, so the user is never left with a repo that has no way to commit.
   The check is strict on purpose: some git builds invent `user@host` when
   nothing is set, and a history signed that way is not one anybody chose. A
   name and email supplied by the user are written as **repo-local** config.
   Changing who the user is in every other repository on the machine is not
   this app's business.
2. *`.gitattributes` (`* text eol=lf`) before the first `git add`.* Otherwise
   Windows stages CRLF against the LF the vault writes, and every file diffs
   as wholly modified. It is written only when absent. A user's own attributes
   file is left exactly as it was.
3. *Verify by doing.* `healthy` only goes false after a commit has already
   failed, so a fresh repo looks healthy either way. The method makes a
   `Turn on history` commit and reads it back from `git log` before it
   reports `done`. `--allow-empty` is what lets the same proof cover the other
   repair: a repo that exists, has nothing new to stage, and was failing to
   commit for want of an identity.

**Explain rather than act, and the outcomes are values, not errors.**
`no-git`, `nested` and `needs-identity` come back as `ok: true` results,
because each is the user's next step rather than a failure. Only a real git
error is `ok: false`, and it is shown next to the button rather than in the
shared error banner. With no git, the banner says so and offers **Get git**
(the download page) plus a note to restart the app afterwards, since a running
process never sees a `PATH` change. There is no setup button, because there is
nothing for one to do. For a vault inside a repo that ignores it, the banner
names the outer repo and the button reads **Keep a separate history here**. The
nesting is allowed, but only as a labelled choice (`allowNested`), never as the
side effect of a button labelled "Fix".

**The identity form appears only after main has looked.** Asking every user
for a name and email up front would ask everyone who already has one
configured, which is most people. The first click either finishes or comes
back `needs-identity`, and only then do the two fields appear inline in the
banner. At the 900px minimum width the controls wrap under the sentence
(`.banner-history`) instead of squeezing it to a column one word wide. That was
caught in a screenshot, not predicted.

**The first-run offer is a checkbox on the "Create a vault here" dialog, not a
button in `Welcome.tsx`.** IDEAS.md said to offer it "at the first-run picker
once a folder is chosen". The Welcome screen never sees that moment: choosing a
folder either opens a vault, and the app replaces Welcome at once, or reaches
main's "Not a vault yet" message box. That box is the one place where someone
is deciding how a new vault gets set up, so it gained a checkbox, *Keep an undo
history with git*, ticked by default and shown only when git runs at all.
Anything short of `done` there (typically no identity) falls through to the
banner, which has room for the two fields and the explanation a message box
does not. An existing vault opened from Welcome gets the banner too. So every
first-run path ends in front of the same button, with no second implementation
of it.

Verified in `packages/core/test/vault.test.ts` (six cases) and
`e2e/turn-on-history.e2e.mts`. Both run git with `GIT_CONFIG_GLOBAL` pointed at
an empty file and `GIT_CONFIG_NOSYSTEM` set, because otherwise "no identity"
is only true on a machine that never configured one, and the suite would test
different paths on a developer's laptop and a CI runner. The core cases cover:
nothing written before the identity check; the full sequence ending healthy
with the next auto-commit landing; a failing repo repaired and its error
cleared; nesting refused and then done on request; an existing
`.gitattributes` untouched and a bad email rejected; and `no-git` with an empty
`PATH`. The e2e spec drives the banner from *not a git repository* through the
form to *history on*, then checks the repo: one `Turn on history` commit,
repo-local identity, the attributes file, a clean tree, and the next write
committed as `Update <key>`. The harness gained `git: false` and `env` options
for it. Not driven in a real window: the dialog checkbox (a native message box
Playwright cannot click), the Get git button, and the nested banner. The core
tests cover the logic under all three.

## Two creates never share a key ✅ built

Found while measuring what two app windows do to one vault (see "One launch,
one window"). Six creates fired together came back as `OPS-6, OPS-6, OPS-7…`.
Both calls reported success, and one `OPS-6` was silently overwritten. The
single-instance lock closed the easy way to reach this, but the app, the MCP
server and the CLI are still three processes over one vault, and nothing
serializes them against each other.

**The item file is the reservation.** `allocateKey` still reads
`.counters.json` and proposes a number, but the key belongs to whichever
process *creates the file*. `createItem` now writes through
`createFileExclusive`, which fails with `EEXIST` rather than replacing what is
there. The loser comes back round with `allocateKey(project, above)`, a floor
set to the key it just lost, so each retry makes progress even when neither
its own index nor the counter has caught up with the other process. Twenty
straight losses throw a `VaultError` that says so, since at that point
something is broken rather than racing.

**A hard link, not `wx`, so the atomic write survives.** `writeFileAtomic`
exists so that a reader (the watcher in another window, an external Claude)
sees the whole file or no file. `wx` would keep the exclusivity and lose that.
`createFileExclusive` writes a temp file and then `link`s it into place:
`link` refuses an existing target in one system call, and the file appears
complete. Where the filesystem has no hard links (FAT, exFAT, some shares) it
falls back to `wx`. That gives up whole-or-nothing visibility only for the
milliseconds of the write, and never gives up exclusivity.

**The same guard covers a case that was never a race.** An item file that is on
disk but will not parse is missing from the index, so `highestOnDisk` did not
count it, and the next create could be handed its key and write over the
hand-edit someone was about to fix. The exclusive create now skips it. That
case has its own test.

**`.counters.json` became a hint, and is written like one.** The first run of
the new race test failed on something else, twice over:

- `writeFileAtomic`'s temp name was `pid` plus `Date.now()`, unique across
  processes but not within one. Two writes to `.counters.json` in the same
  millisecond shared a temp file, and the second rename failed with ENOENT. A
  single core `Vault` taking concurrent calls (the MCP server can) would hit
  the same thing. The name now carries eight random hex characters too.
- On Windows, concurrent renames onto one file fail with `EPERM` while another
  holds the target, and twelve creates at once used up `writeFileAtomic`'s
  three quick retries. That was already true before this change: two processes
  could fail a create outright over a bookkeeping file. It was just hidden
  behind the duplicate keys.

Now that uniqueness comes from the item file, the counter's only job is to keep
a *deleted* item's key from being reissued. `advanceCounter` therefore re-reads
before each write and only moves the counter up, so two processes no longer
write it backwards. It retries up to eight times with jitter, and if every
attempt fails it lets the create succeed anyway. The cost is a narrow window in
which one key could be reissued after its item is deleted, and only if no other
create in that project advanced the counter first. That was judged better than
losing what the user typed.

**Not covered at first: moving an item between projects.** `moveItemsToProject`
also allocates keys, and it wrote them through `rekeyItems`, which still used
the replacing write. Giving it the same guard meant making a multi-file re-key
retryable part-way through, so it was left as a change of its own. It got one:
see "A move never overwrites a racing create" below.

Verified in `vault.test.ts`. Two `Vault` instances on one root, standing in for
two processes, fire twelve creates alternately. The test asserts twelve
distinct keys, then reads all twelve summaries back from a third, cold
instance. With the exclusive write switched off, the same test fails on
duplicate keys, so it does exercise the race. With it on, it passed 20 runs out
of 20 after the counter change; before that change it had failed 6 of 10 on
`EPERM`.

## The core talks to one Jira project through one client ✅ built (Jira push, slice A1)

The first slice of `plans/PLAN-jira-push.md`, the design for Phase 5. It adds no
UI. It gives the push, the app's connection check and `discover` a single way to
talk to Jira, and lets them read what one project will accept.

**One client, because the rules are security rules.** `createJiraClient` in
`jira-client.ts` is the only thing in the codebase that sends a request to
Jira. Each of its rules closes a specific way a token leaks, and a second fetch
path would be a second place to forget each one:
- `normaliseBaseUrl` *refuses* `http:` rather than upgrading it, because Basic
  auth over plain HTTP is the token in the clear.
- Callers pass a path, never a URL. Anything that would resolve outside the
  site (`//host`, `://`, `..`) is refused before a request is made.
- Redirects are refused rather than followed, because a redirect carrying
  `Authorization` to another host is the textbook leak.
- The Basic header is formatted inside `request` and nowhere else.
  `JiraError` carries status, path and Jira's own messages, never a header.

The slice-B session asked for the client to land first for exactly this reason.
Its Test connection button would otherwise have needed a request path of its
own in the main process.

**`redirect: "manual"`, not the `"error"` the plan named.** Both refuse to
follow. `"error"` surfaces as an opaque network failure, while `"manual"` hands
back the 3xx so the message can say a redirect was refused and why. One test
asserts a single request with no follow, and another that the token is absent
from the error, the stack and every property of every failure kind.

**A 401 is written as an expiry, not a mystery.** Atlassian API tokens now
expire (a year at most), so the most likely cause of a 401 on a credential that
used to work is time. The message says so and says where to replace it. A 429 is
retried on `Retry-After`, capped at a minute, with a callback so a UI can say
how long it is waiting.

**Scoped tokens are addressed through the gateway.** A scoped token is sent to
`https://api.atlassian.com/ex/jira/{cloudId}`, not the site. `resolveCloudId`
reads `/_edge/tenant_info`, which is unauthenticated on purpose, so it sends no
credential at all. The client keeps the site separately, for links a person
clicks.

**Project metadata, read per project and per issue type.** `jira-meta.ts` reads
the project, its issue types, and each type's create-screen fields through the
paginated `createmeta/{project}/issuetypes[/{id}]` endpoints. Everything
downstream works one issue type at a time, because a field can be required on
Story and absent from Epic:
- `requiredGaps`: the required fields with no default that nothing covers.
- `valueKindFor`: which editor a field needs, with `raw` as the escape hatch for
  Sprint, Team and app fields whose shapes vary by site.
- `searchAssignable`: people Jira will accept as an assignee here, active human
  accounts only.

The renderer can import all of it through the new `todo-vault/jira-meta`
subpath.

**The list key is read tolerantly, and only that.** Atlassian's current
reference names the lists `issueTypes` and `fields`. Older documentation and
some deployments send `values`. Both are accepted, and everything else is
parsed strictly, so a genuine API change fails at the parse and names the path.

**`discover` moved onto both.** It used to have its own fetch helper, and it
matched names against `GET /rest/api/3/field`, which lists every field on the
*site*. That could propose a field this project's create screen does not have,
which Jira then rejects at create time. It also read the deprecated
`createmeta?expand=projects.issuetypes.fields`. Now it matches against the
project's own fields, through the client. It is still a printer: writing the map
is slice A2's comment-preserving writer.

291 tests green (162 core, 85 app, 44 scripts), typecheck clean. The fake
`fetch` in `test/jira-fake-fetch.ts` records every request, so the rules above
are asserted on what was actually sent. **Not verified:** nothing here has
talked to a real Jira. Which list key a live site sends, and whether
`/_edge/tenant_info` answers for every Cloud site, are exactly what the one
hand-run check in the plan is for.

## Jira, part B1: the credential is stored once ✅ built and driven

The first piece of Settings → Jira, from `plans/PLAN-jira-push.md` (slice B,
split in two as the plan allowed). It stores the connection and nothing more.
Test connection, the project picker and the mapping need slice A's Jira client
and are part B2. This half ships on its own because it has no dependency on the
client, and because the storage rules are the part worth getting right before
anything can send.

**`secrets.ts` went from one key to named secrets, with no rule weakened.** It
now has `setSecret`, `getSecret`, `clearSecret` and `secretStatus`, each taking
`"claude" | "jira"`, one file per name in `userData`
(`claude-key.bin`, `jira-credentials.bin`). The Claude functions remain as
one-line wrappers, so the Claude layer did not change. It is one module rather
than a copy per secret because a second secret is exactly when a copied module
starts drifting from the first. The rules are still: main process only, no
plaintext fallback, and a secret that will not decrypt counts as absent.

**Site, email and token are one encrypted blob.** The plan already paired the
email with the token, so the two can never disagree: replacing one re-enters
the other, and the "right token, stale email" 401 cannot happen. Building it
added the site to the same blob, for the same reason in a different form. A
token is issued for one site, and a stored token with no record of which site
might be sent to whatever site a map later names. The map's `baseUrl` still
exists and is still what the push is configured by. The credential's site is
what slice C can check it against before sending anything. The blob is
versioned (`v: 1`), and one this code cannot read counts as no credential, the
same as one it cannot decrypt.

**The site is checked where it is stored, by the rules the client uses.**
`parseJiraSite` is a thin layer over the core's `normaliseBaseUrl`, which slice
A1 landed while this was in review. It refuses `http:` rather than upgrading
it, refuses a URL with a user or password in it, and reduces a pasted board URL
to its origin. B1 first had its own copy of those three rules. It was swapped
onto the core's before merging, so a site the panel accepts is one the client
will accept, and there is only one place the rules can change. The layer adds
two things that matter only in a settings field: a prompt for an empty field,
and `https://` for a bare host. A bad site is therefore never stored at all,
and every request checks it again.

**One way across IPC, as with the Claude key.** `jira:set-credentials` sends
the pair in once. `jira:status` and `jira:clear-credentials` answer with
`{ storageAvailable, credential?: { site, auth, email, verifiedAt? } }`, which is
`summarise()`'s output. That function builds the summary from named fields, so
the token is absent by construction rather than because someone remembered to
delete it. The panel's Replace prefills site, kind and email and asks for the
token, because the three are stored together and the token is the one thing
the panel never has.

**Two token kinds, chosen up front.** A classic token authenticates against the
site. A scoped one goes through `api.atlassian.com/ex/jira/{cloudId}`. The
header is the same and the base URL differs, so the kind is stored with the
credential and resolving `cloudId` is left to slice A's client. The radio
options were first labelled "API token" and "Scoped API token", which gave the
page two controls both named "API token". Playwright's strict locator found
that before a screen reader user could. They are now "Classic token" and
"Scoped token". The scope names the panel suggests ("read and write Jira work
items, read users") are still the unverified fact the plan flags.

**A stored credential reads as "not verified yet".** Nothing in B1 can talk to
Jira, so the panel claims nothing beyond what is on disk. `verifiedAt` already
exists in the blob and the status for B2's Test connection to set.

Verified in `test/jira-credential.test.ts` (site parsing, validation, the blob
round trip, and a summary that never contains the token) and
`e2e/jira-settings.e2e.mts`. The e2e spec drives the panel in a real window.
An `http:` site is refused and no file is written. An https board URL is
stored as its origin. The file on disk contains neither the token nor the
email in plain text, so `safeStorage` really encrypted it on this machine.
Status over IPC is exactly the summary. Replace keeps site and email and
empties the token. Remove deletes the file. Not verified: any request to
Jira. B1 makes none, by design.

## The Jira map is written by the app, and checked against the project ✅ built (Jira push, slice A2)

The second core slice of `plans/PLAN-jira-push.md`. It adds the parts of
`jira-map.yaml` that Settings → Jira fills in, a writer that can fill them in
without destroying the file, and a planner that checks every draft against what
the target project will actually accept.

**The map gains four keys, all optional:** `auth` and `cloudId` for scoped
tokens, `people`, and `extraFields`. A map written before this still loads.
The schema stays `.strict()`, and a `superRefine` refuses `auth: scoped` without
a `cloudId`.

**`writeJiraMap` keeps every comment.** `discover` refuses to write this file,
because parse-and-reserialise would destroy the explanations that make it
usable. That was right for that kind of writer. `YAML.parseDocument` instead
edits values in place with their comments still attached, so the writer takes
path-level edits and changes only those paths:
- **Paths, not objects.** Replacing the whole `fields` block would take its
  comments with it.
- **Validated before disk.** An edit that would make the map invalid is refused,
  and the file is left byte-for-byte as it was.
- **No place for a secret.** Strictness means an invented key such as `token` is
  refused at any depth.
- **Committed like other writes.** `Vault.commitChange` lets the app's save land
  in git beside every other write.

**A first write starts from the example's own text.** The example is embedded as
`JIRA_MAP_TEMPLATE`, so a packaged app, which has no repo to read the example
from, still writes a commented file. `scripts/sync-jira-map-template.ts`
regenerates it, and a test fails, naming that script, whenever the two differ.
Building this surfaced a trap in the example: `startDate: customfield_10015` and
`estimate: customfield_10016` were live values, with a comment saying not to
trust them. A person copying the file might read that comment. An app writing
from it would not, and would silently keep a guessed id that is wrong on half of
all sites. Both are now commented out. An unset start date field produces the
existing warning, which is the safe failure.

**Assignees go by account id.** Jira Cloud stopped accepting `{ name }` for
users in 2019, so the old payload was refused for every assigned item.
`people` maps the vault's spellings, case-folded as `listItems` folds them, to
`{ accountId }`. A name with no entry is left unassigned, with a warning rather
than a refusal, because the rest of the issue is still worth creating.

**Extra fields are applied first, and the item's own fields last.** An extra
field that happens to share an id with a vault field, such as `priority`, must
not override the item. `ask` fields send their prefilled value unless the push
pane passes an `askValues` override, which applies to that push only.
`issueTypes` limits a field to the types that have it.

**With `meta`, each draft is checked against its own issue type.** Never against
a union, since a field can be required on Story and absent from Epic:
- A field the screen lacks is **removed, with a warning**, because Jira would
  refuse the whole create over it and the rest is still worth sending.
- A required field with no default that nothing fills is a **blocker**, which
  the push will refuse.
- An issue type the project cannot create is a blocker, and so is one whose
  fields were never loaded. A check that cannot run must not pass by default.
- The issue type is sent **by id**, which survives a rename between setup and
  push.

A child created in the same batch counts `parent` as covered, because the child
is filled in once its parent exists.

**Warnings are grouped.** A batch of forty epics on a project whose Epic has no
labels field would otherwise print forty near-identical lines and bury the one
that matters. The same message is now said once, with the keys listed.

**Without `meta`, nothing changes.** The MCP planner and the CLI get the plan
they always got, now with an empty `blockers` list and account-id assignees.
Only the app, which holds a credential, can fetch the metadata the checks need.

314 tests green (179 core, 91 app, 44 scripts), typecheck clean.
`jira-map.test.ts` covers the template-equals-example check, the example being
valid with no live guessed ids, old maps loading, every comment surviving both a
first write and an in-place edit, refusals leaving the file untouched, and
`token` being refused at the top level and nested. `jira-push-plan.test.ts`
covers each outcome above against a hand-built `ProjectMeta`. **Not verified:**
a real project's metadata has never been fed through the screen checks. The one
hand-run push in the plan is where that happens.

## The app pushes to Jira: the pane, the send, the journal ✅ built (Jira push, slice C1)

Phase 5's remaining line from the top of this file — "`buildPushPlan` output
in a review pane, then the POST as an explicit user action" — now exists. Two
entry points open the pane: **Push to Jira…** on the backlog's bulk bar, for the
checked rows, and on an unpushed item's Jira row in the detail panel. What
reaches Jira is decided in three places, each with one job.

**The core sends; it does not decide.** `sendPushPlan` in `jira-push.ts` takes
a client, a plan and callbacks, and runs the whole send under test against the
fake `fetch`:
- **Sequential, parents first.** Jira's bulk endpoint cannot create a parent and
  its child in one call, and reports partial failure per element.
- **Each success is stamped** with `markPushed` before the next request, so a
  crash halfway leaves every created issue stamped, and the next push skips it.
- **A refused create does not orphan its children.** The children are skipped
  with the reason, and unrelated items carry on.
- **A plan with blockers is refused outright.** The pane never offers the button
  then, and this is the check that does not depend on the pane.

**The journal is for the one ambiguous failure.** When the connection drops
after a request has left, nobody knows whether Jira created the issue.
Retrying risks a duplicate in a tracker a whole team reads, and giving up risks
a lost stamp. So:
- Each attempt is written to a journal before it is sent, and settled once the
  outcome is known.
- A 4xx or 5xx is Jira saying no, so it settles. Only a request with no answer
  stays open, and so does a create whose stamp failed, because that issue does
  exist.
- An open entry holds its item back from later pushes and appears in the pane
  as *Did these reach Jira?*, with a **Check in Jira** search and two answers.
  *It exists* takes a key and stamps it. *It was not created* clears the entry.

The journal lives in `userData`, keyed by vault root. It is about this
machine's requests, and a journal that synced would have another machine asking
about pushes it never made.

**The search is opened, not run.** The person deciding whether a near-match is
the same issue is better served by Jira's own results page than by a count.
The JQL starts from the day *before* the attempt, by date only, because JQL
reads times in the user's Jira timezone, which the app cannot know. A tight UTC
window could begin hours after the attempt and miss the very issue being looked
for. Quotes in the summary are neutralised so they cannot end the phrase early.

**Main holds the credential and rebuilds the plan.** `main/jira-push.ts` is the
only place the stored credential is read for a push, and it goes no further
than the client built there. The renderer sends keys and its choices for `ask`
fields, and gets back a preview, progress events and an outcome. `runPush`
rebuilds the plan from those keys with freshly fetched metadata, rather than
trusting the preview it showed. So a field made required in Jira since the
preview becomes a blocker here instead of a refusal halfway through the batch.
A module-level flag turns a double click into one push.

**The token goes only to the site it was saved for.** This check was proposed
by the slice-B session. `pushTargetProblem` refuses unless the map's `baseUrl`
normalises to exactly the credential's site. The map is a file in a synced,
committed folder that anyone with the vault can edit; if it could point a push
somewhere else, the token would go with it. A scoped token's cloud id comes from
the credential (Settings → Jira caches it there), then from the map, then from
a fresh lookup, so a credential saved before that cache existed still works.

**The preview re-plans as `ask` values change.** It waits a moment after the
last change, so the blockers shown always match what would be sent. Project
metadata is cached in main for ten minutes, keyed by site, token kind, project
and mapped issue types, so each re-plan is not a dozen requests. Each `ask`
control is chosen by `valueKindFor`:
- selects for options, versions, components and priority, built from Jira's own
  `allowedValues` and sent by id
- checkboxes for their multi-value forms
- typed inputs for text, number and dates
- a JSON box for everything whose shape varies by site, labelled as sent exactly
  as written

**The button says what it does:** *Create 3 issues in ENG*. It is the one action
in the app that writes somewhere other than the vault.

**Deliberately left for slice C2:** a push driven end to end against the fake
HTTPS Jira the slice-B session is building (`e2e/fake-jira.mts`). One fake, not
two, because Test connection needs it as well.

322 tests green (187 core, 91 app, 44 scripts), typecheck clean.
`test/jira-push.test.ts` covers:
- order and parent keys, with a stamp before each next request
- the blocker refusal, with nothing sent
- a 400 with its field errors, whose child is skipped rather than sent unparented
- a dropped connection left journalled as uncertain
- a created-but-unstamped issue kept in the journal
- the site-match refusal in all four shapes
- the search URL's day-early window and quote handling

`e2e/jira-push-pane.e2e.mts` opens the pane from both entry points in the built
app and confirms that, with no credential saved, main's refusal is shown and
the create button is disabled. **Not verified:** no issue has been created by
this code in any Jira, fake or real. C2 covers the fake, and the plan's one
hand-run push covers the real one.

## Jira, part B2a: Connect proves the pair, and a fake Jira speaks real HTTPS ✅ built and driven

B1 stored a connection and could say nothing about it. With slice A1's client
on main, B2a makes the credential mean something. **Connect** asks Jira
`GET /rest/api/3/myself` before anything is stored, and **Test connection** asks
again later. The mapping half of Settings → Jira is B2b, built on A2's
`writeJiraMap`.

**Verify, then store, never the other way round.** A pair Jira refuses is
never written, so a stored credential is always one that worked at least once.
Storing first would have left a wrong token sitting there looking configured,
and the first push would have been the moment that showed. The cost is that a
connection cannot be saved while Jira is unreachable. That is also a moment
when nothing could be done with one, so it was accepted. Test connection on a
stored pair works the other way: a failure leaves the credential, and its last
`verifiedAt`, exactly as they were. That way an expired token reads as expired,
with the date it last worked, and does not vanish.

**Everything that talks to Jira is the core's client.** `verifyCredential` in
`jira-credential.ts` decides only what to ask and what to keep. For a scoped
token it calls `resolveCloudId` once, unauthenticated, and keeps the id in the
blob, so later checks and slice C's push go straight to the gateway. It keeps
Jira's `displayName` as `accountName` too, so the panel reads "Dan Okafor ·
me@acme.com on acme.atlassian.net" and not an email alone. An email is what
was typed, and a display name is Jira's own answer about whose token it is.
There was a suggestion to write a minimal fetch in main while the client was
still being built. It was turned down, because a second fetch path is how the
client's rules (https only, `redirect: "error"`, origin pinning, token-free
errors) would start to drift.

**One message is reworded, and only on first Connect.** The client's 401 says
"Jira rejected the *stored* token — it may have expired". That is right for
Test connection and for a push, and wrong on Connect, where nothing is stored
yet and the likelier causes are a token pasted short or an email that does not
own it. `forFirstConnect` rewrites that one case. Every other failure (network,
redirect, forbidden) already reads correctly and passes through unchanged.

**The fake Jira is real HTTPS, because the client allows nothing else.**
`e2e/fake-jira.mts` starts an HTTPS server on 127.0.0.1 with a throwaway
self-signed certificate made by `openssl` at start. The app trusts it through
`NODE_EXTRA_CA_CERTS`, passed with the harness's `env` option. That rests on
one fact, checked with a scratch launch before anything was built on it:
**Electron's main-process `fetch` honours `NODE_EXTRA_CA_CERTS`** the way any
Node process does. Without that, the only way to test against a fake would
have been an `http:` escape hatch in `normaliseBaseUrl`, which is exactly the
hole the rule exists to close, opened for tests. The fake checks Basic auth on
every request and answers a mismatch with Jira's own 401 shape. So a passing
spec is also proof the app sent the right pair. It serves `/myself` out of the
box, and `route()` lets a spec add the rest, which is how slice C's push spec
extends it rather than building a second one. Two limits: the site is
`https://localhost:<port>`, so a scoped token (addressed through
`api.atlassian.com`, a fixed host) cannot be faked and is unit-tested over a
fake `fetch` instead. And a machine without `openssl` on `PATH` skips the spec
with that reason given, rather than passing it silently. Under Git Bash the
certificate subject needs `MSYS_NO_PATHCONV=1`, or `/CN=localhost` is rewritten
into a Windows path.

Verified in `test/jira-credential.test.ts` and `e2e/jira-settings.e2e.mts`. The
unit tests cover: a classic token goes to the site with the right Basic header;
a scoped token resolves the cloud id once, without credentials, keeps it, and
uses the gateway; a 401 carries no token; the blob round-trips the new fields;
and the first-Connect rewording. The e2e spec runs against the fake. An `http:`
site is refused with no request sent at all. A wrong token draws one refused
`/myself`, the first-Connect message, and no file. The right token is verified,
then stored encrypted, and the account is named. Test connection sends one
more authorized `/myself`. Replace keeps the site and email. Remove deletes the
file. Not verified: a real Jira Cloud site, and the scoped-token scope names.
Both stay on the plan's list for the manual check before slice C is done.

## A push lands in a fake Jira, end to end ✅ built and driven (Jira push, slice C2)

C1 left one sentence standing: *no issue has been created by this code in any
Jira*. This removes it for a fake one. `e2e/jira-push.e2e.mts` drives the built
app against the real HTTPS server the slice-B session wrote
(`e2e/fake-jira.mts`), and checks four things in order:
1. **The credential goes in through Settings → Jira**, verified against the fake
   before it is stored. The spec writes the map exactly as the panel will, with
   `writeJiraMap`.
2. **An epic and its story, pushed together, are blocked on Team.** The push
   pane names Team, the button stays disabled, and the fake records no POST.
3. **Adding Team as an `ask` field clears the blocker.** Choosing *Payments* in
   the pane, then pressing *Create 2 issues in ENG*, creates the epic first.
   The story arrives with `parent: { key: <the epic's new key> }`, Team
   `{ id: "t2" }` (the pane's choice, not the map's default) and assignee
   `{ accountId }`. Every request carried the stored pair.
4. **The vault is stamped, and a second push sends nothing.** The vault's files
   read back as `pushed` with a key and an id. The next push shows *0 issues to
   create* and *Already pushed as ENG-1*, and makes no new POST.

**One fake project, shared.** `e2e/fake-jira-project.mts` serves an ENG project
on top of the fake server, so this spec and the mapping panel's spec cannot
drift into two slightly different Jiras. It is built to catch the mistakes that
matter:
- Story requires Team, with no default.
- Epic has no Start date field.
- `POST /issue` validates as Jira does, answering a missing Team, a wrong
  project or a field off the screen with Jira's own `errors` shape.

A payload the planner should have stopped therefore fails loudly here, rather
than passing because the fake accepted anything.

**`fieldsTheMapCanFill`, for the settings panel.** The slice-B session asked for
this. Settings → Jira needs to say *"Story requires Team, which nothing fills
in"* before any item is chosen. That is a question about the map, not about a
draft, and the rule for what a push fills belongs beside `buildPushPlan`, not
copied into the renderer:
- **Generous on item-dependent fields** (due date, assignee, labels, components,
  parent), so a gap it shows is certain. Gaps that depend on an item are still
  caught per draft at push time.
- **Shares `extraFieldAppliesTo`** with the planner, so issue-type matching is
  one rule.
- **Held to the planner by a test.** Every field a fully populated item's draft
  carries must be in the set. Removing `components` from the set makes that
  test fail and name the field, which was tried to prove the test can fail.

The cast `jira-push.ts` used for a cached cloud id became `stored.cloudId` once
the credential type grew the field.

329 tests green (189 core, 96 app, 44 scripts), typecheck clean, and the new
spec's four checks green against the fake. **Not verified:** a real Jira. What
the fake cannot tell us is which list key a live site sends (`issueTypes` or
`values`, both accepted), whether a real Team or Sprint field takes what the
raw-JSON box sends, and the scope names on a real scoped token. That is the
plan's one hand-run push, and it is the next step.

## A move never overwrites a racing create ✅ built

"Two creates never share a key" closed the race for `createItem` and left one
path open. `moveItemsToProject` hands out fresh keys in the target project, and
`rekeyItems` wrote them with the replacing write. So an MCP server creating in
OPS while the app moved an epic into OPS could be handed the same number, and
whichever wrote second silently replaced the other's item. A stray file that
would not parse got the same treatment. The guard is the same as the one on
create: a new key is claimed by creating its file exclusively. What changed is
the order of the work around it.

**Claim first, so a lost claim has nothing to undo.** A re-key touches many
files: the moved items' new homes, their attachment folders, every other item
whose parent or links named them, and the files left behind. The reason this
was deferred was that a race lost part-way through that would leave a
half-moved subtree. So `rekeyItems` now writes every *new* home first, before
it moves an attachment folder, rewrites a reference, or deletes anything. If
one claim finds a file already there, the only changes made so far are the
files this call just created. Those are removed, the index entries go with
them, and it throws `KeyTakenError` naming the key. The vault is exactly as it
was.

**The move comes back round; a rename does not need to.** `moveItemsToProject`
catches `KeyTakenError`, re-allocates the whole subtree from past the lost key,
and tries again, with the same twenty-attempt ceiling as `createItem`.
`renameProject` fixes its numbers (ACME-7 becomes NEW-7), so there is nothing
to retry. There the error reaches the caller as a `VaultError` that says a file
is in the way and nothing changed, instead of the old silent overwrite. A key
that another item in the same mapping is vacating is already this call's own,
and keeps the replacing write. No caller builds such a chain today, but
`rekeyItems` permits one.

**Attachment folders now move after the claims, not before.** They used to go
first, so the paths an item records would point at something real once its file
landed. Now there is a moment where a claimed file names a folder that is still
arriving. The alternative was moving folders first and renaming them back on a
lost claim. That fails in exactly the conditions where it would be needed:
a rename on Windows can fail with `EPERM` while something holds the folder open.
A brief dangling path that fixes itself was judged better than a rollback
that can strand the folder.

**Each key floors the next.** The subtree used to call `allocateKey(target)`
once per member with no floor. `allocateKey` counts on `.counters.json`
advancing between calls, and since the create fix that write is allowed to fail
quietly. If it did, two members of one subtree could be handed the same number.
Now each allocation passes the previous key as its floor, so distinct keys no
longer depend on the counter.

Verified in `vault.test.ts` by three tests. In the first, a subtree of two lands
on a broken OPS-2: OPS-1 is claimed, then given back, and the move lands as
OPS-3 and OPS-4 with the broken file untouched and no OPS-1 left behind. In
the second, a rename onto a stray NEW-2 refuses and changes nothing. The third
runs two `Vault` instances on one root: four sequential moves into OPS against
eight concurrent creates there, then a cold read that expects all twelve
summaries. With the claim switched back to the replacing write, all three
failed in 5 runs out of 5. With it on, the race test passed 15 out of 15.

## Jira, part B2b-1: the mapping is chosen in the app ✅ built and driven

B2a proved the credential. B2b-1 puts it to work. Settings → Jira gains a
**Mapping** tab that reads one project's issue types and create screens with
the stored credential, offers only what that project has, and saves the choice
into the vault's `jira-map.yaml` through A2's `writeJiraMap`, committed as
"Update Jira mapping". Extra fields and people are B2b-2.

**Tabs, not one long panel.** The first version put the mapping under the
connection in one scrolling modal. That was turned down before it landed, in
favour of Connection and Mapping tabs. The connection is set once, and the
mapping is revisited whenever the project changes, so each gets its own short
view. The modal is one width (640px) for both, so switching never resizes it.
Mapping is disabled until a credential is stored, and again while Replace is
open, because everything it does asks Jira with that pair. It stays mounted
while hidden, so a project loaded on Mapping is still there after a look at
Connection. Remove, Test connection and Replace belong to Connection and show
only there.

**The renderer says what it picked, and main decides what is written.** The
panel sends a `JiraMappingChoice`: a project key, five issue type names and
three field ids. `mappingEdits` in `main/jira-mapping.ts` turns that into map
edits, and it writes `baseUrl`, `auth` and `cloudId` from the verified
credential, never from the choice. So the push's own check, that the map's
site is the token's site, holds by construction for any map saved here, and
nothing the renderer sends can aim the token somewhere else. `cloudId` is
deleted for a classic token rather than left behind by an earlier scoped one.
The key and field ids are checked against Jira's shapes before anything is
written, so a `../` or a stray space is refused in main and not merely
avoided by the dropdowns.

**Edits are paths, never blocks.** `writeJiraMap` keeps the comments on a
block only if the block is edited key by key. Replacing `fields` whole would
have dropped its explanations, and also `epicLink`, which this panel does not
show. So each Save touches `issueTypes.<type>` and `fields.<name>` one at a
time, and leaves `priorities`, `statusTransitions`, `extraFields` and `people`
alone. A first Save writes from the commented example, so the file a person
opens later still explains itself.

**Gaps are computed in main, from metadata already fetched.** A gap is a
required field, with no default, on a mapped issue type that no item could
ever fill under this map. `mappingGaps` holds `requiredGaps` against #67's
`fieldsTheMapCanFill` for each distinct mapped type, so bug and task both on
Task is one set of gaps and not two. Main caches the last project metadata
the panel loaded, tagged with the credential's site. A load or save of the
map returns gaps whenever that cache matches, and after Replace moves to
another site the cache answers nothing rather than something wrong. The panel
re-reads the map after loading a project, so the saved mapping's gaps appear
before anything is changed. It says "Story requires Team, which nothing fills
in", which is the same blocker the push would raise, but shown at setup rather
than at send. Gaps are for the *saved* map on purpose: they answer what a
push would do now, not what unsaved picks might do.

**The panel only offers what could work.** Each vault type's dropdown lists
the project's own issue types, and subtask types appear only for the vault's
subtask. That's because Jira refuses a parentless subtask and a parented story
alike. Field dropdowns list only fields of the right kind that are on at least
one chosen type, labelled with the types they are on. A saved choice the
project no longer offers stays visible and marked, rather than silently
blanked. Loading guesses the usual names (Epic, Story, Task, Bug,
Subtask/Sub-task). A type with no match, such as Bug in a team-managed project
without one, is left blank, and Save waits until someone chooses.

Verified in `test/jira-mapping.test.ts` and `e2e/jira-mapping.e2e.mts`. The
unit tests cover:
- edits are paths, and none replaces a whole block
- the site and auth come from the credential, even when the choice tries to carry them
- `cloudId` is written for a scoped token and removed for a classic one
- a bad key, field id or category, or a missing type, is refused
- a real `writeJiraMap` round trip keeps a comment inside `fields` and leaves `epicLink` and `extraFields` alone
- gaps: named once per type, never for defaulted, always-sent or parent fields, closed by an extra field only on its own types, and undefined for another project's metadata

The e2e runs against the fake ENG from `fake-jira-project.mts`. Mapping stays
disabled until Connect succeeds. ENG loads from a typed "eng". Bug is left
blank and Save is disabled until it is chosen. The subtask dropdown offers
only Subtask. A loaded project survives a trip to Connection. The saved file
starts from the commented example, has `baseUrl` equal to the fake's site, and
does not contain the token. The last commit is "Update Jira mapping" with
nothing left uncommitted. Story's Team gap is the only one shown. Replace
disables Mapping. Reopened, the panel reads the saved map back, keeps Bug on
Task, and shows the gap again. Not verified: a real Jira Cloud site, which
stays on the list for the manual check after slice B.

**One trap for the next spec.** A `<select>` inside its `<label>` takes the
selected option into its accessible name, so the Epic select is named "Epic
Epic". An exact `getByLabel` then never matches, and the spec finds selects by
their caption instead.

## Jira, part B2b-2: extra fields and people are set in the app ✅ built and driven

B2b-1 let the app choose the project, the issue types and the vault's own
fields. It could also name a gap, "Story requires Team, which nothing fills
in", and give no way to close it short of editing `jira-map.yaml` by hand.
B2b-2 adds the two sections that close such gaps. **Extra fields** are the
Jira fields the vault has no equivalent for. **People** are the Jira accounts
behind the vault's assignees. Both sit in the Mapping tab and are saved by the
same Save, which finishes slice B.

**One value editor, drawn in two places.** The push pane already had an editor
for an `ask` field's value, chosen by `valueKindFor`: a select over Jira's own
options, checkboxes for multi-selects, a date or number input, and raw JSON
for sprint, Team and app fields. It moved out of `JiraPush.tsx` into
`JiraValueField.tsx`, and `choicesFor` moved from main to
`shared/jira-choices.ts`, so an extra field's stored value and a push's
one-off value are drawn and shaped the same way. A value chosen in Settings
is then recognised as selected in the pane, rather than being an equal-looking
object that fails a `JSON.stringify` comparison. The push e2e runs unchanged
through the moved editor.

**A new extra field is limited to the types that have it.** Adding Team in ENG
writes `issueTypes: [Epic, Story, Task]`, because ENG's Subtask screen has no
Team field. Jira answers a field sent off-screen with a 400, so an unlimited
field would be a push failure waiting for the first subtask. The limit is left
off only when every chosen type has the field. A gap line gets a **Fill it
in** button that adds the field this way, or extends an existing entry's
types to the one the gap is on. Once filled, the line says "Added above; save
to check it", because gaps are still the saved map's.

**Only fields nothing else fills are offered.** The add list skips fields the
push fills from each item: summary, description, labels, components,
assignee, due date, parent and priority. It also skips `reporter`, which the
push never sends because it is the field most likely to name someone with no
account, and the fields already chosen for the vault's own. Required fields
come first. The skip list mirrors the item-dependent half of the core's
`fieldsTheMapCanFill`. The renderer cannot import that from `todo-vault`,
which loads `fs`, so the list is written out in `JiraMappingExtras.tsx` with
a comment naming its source.

**People are linked on one match and no fewer.** Each assignee in the vault,
one spelling each through `knownPeople`, is searched with the assignable
search for the project (`jira:search-people`, via the core's
`searchAssignable`). The general user search was not used: an account Jira
would refuse as an assignee in this project is not worth mapping. A search
that returns exactly one person links it. More than one offers a choice, and
none says so. That is the same evidence floor `vault-capture` keeps. "Find
everyone" runs the searches one after another, and each link is merged
through React's functional setter, so a later answer never drops an earlier
one. Two spellings of one person are refused at Save, because the push folds
case and would otherwise have to pick between them.

**When the panel sends a set, it owns the set.** A choice carrying
`extraFields` or `people` replaces the map's, and an entry it no longer names
is removed. A choice without them, such as a B2b-1-shaped save, leaves them
alone. The panel sends them only once it has read the saved map, because
before that they are empty for want of reading, not because someone removed
everything. A removal is an edit to a key the choice no longer names, so main
needs the file as it is. `VaultService.saveJiraMap` now takes a function of
the current map and reads the file *inside* the queued write. Read outside the
queue, a removal could be worked out against a file another write was about
to change.

**Entry by entry, except into an empty block.** Existing entries are edited
one at a time, so comments between them survive, as in B2b-1. An empty block
is the one exception. The example file writes `extraFields: {}` and
`people: {}`, and entries added into a flow map stay flow, which would put a
whole Team entry on one line. So a block with no entries is set whole, which
`yaml` writes in block style. The example's commented-out sample entry,
written just below it, survives either way. The unit test checks exactly that
text.

Not done, each deliberately:
- **`defaults` is not converted to `extraFields`.** The plan had the panel
  offer this. `defaults` still loads and still counts as filled for the gaps,
  so nothing is broken by leaving it, and a conversion is its own reviewable
  change.
- **A user-typed extra field is raw JSON, not a people search.** The
  assignable search answers "who can be assigned here", which is the wrong
  question for, say, a reviewer field.
- **Linked accounts are not re-checked.** A deactivated account shows as
  linked until Jira refuses it at push time.

Verified in `test/jira-mapping.test.ts`, 19 tests with 6 new. They cover:
- a choice without the sets leaves them alone
- the sets replace entry by entry, with removals
- nothing empty is written (null value, blank name, empty type list)
- a bad field id, a mode that is neither `always` nor `ask`, two spellings of
  one person, or a person with no account is refused
- a first Save into the example file writes both blocks in block style and
  keeps the commented sample
- `mapState` hands both back

`e2e/jira-mapping.e2e.mts` grew to 11 steps against the fake ENG:
- **Fill it in** adds Team on Epic, Story and Task, and Payments is chosen from
  Jira's options.
- Dan is linked from his only match, through an authorized assignable search.
- Save writes both exactly, the gap disappears, and the commit is made.
- Removing Team and saving again removes it from the file, brings the gap
  back, and leaves Dan linked.

`jira-push`, `jira-push-pane` and `jira-settings` still pass. Not verified: a
real Jira Cloud site, where the assignable search's results and Team's schema
may differ from the fake's. That check is next, now that slice B is done.

## A click beside the open item closes it, unless something would be lost ✅ built and driven

The detail panel is fixed to the right with no backdrop, and the only ways out
were its ✕ and Escape. Someone reading a card and wanting the board back had to
travel to the ✕, or know about Escape. Every side panel people already use
closes on a click in the empty space beside it, and now this one does too. The
ask came with a condition, and it was the important half: only when nothing on
the item is still outstanding.

**Almost nothing in the panel is outstanding, so the rule is short.** Every
field commits on blur, by design, so a click that blurs a field saves it rather
than losing it. That leaves three cases. A field with focus: the first click
leaves it, which commits, and the panel stays long enough to show that it did.
The second click closes. That is the same rung Escape already climbs. An unsent
comment: the click is refused, and a notice by the comment box says *post it or
clear it, or close with ✕*. The ✕ stays the deliberate way out. A write in
flight: the click does nothing, so an error from that write still has a panel
to show in.

**Only empty space closes. Everything else keeps its meaning.** A toolbar
filter, the sidebar or the bulk bar does what it does, and the panel stays open.
Someone narrowing the board while reading a card should not lose the card.
Another item's card or row switches the panel, as it always has. The one change
is that with a comment unsent it does not switch either, because switching
loses the text as surely as closing. `ItemDetail` is mounted without a `key`,
so the text would in fact have followed the person onto the next item, where
posting it would comment on the wrong one.

**The rules are one pure function, and App only wires it.**
`outside-click.ts` decides `close`, `leave-field`, `stay` or `ignore` from
plain facts: where the press and release landed, what was under them, whether
a panel field had focus, whether a comment is unsent, and whether a write is
busy. That is the part with tests (`test/outside-click.test.ts`). App holds three
listeners on `document`, in the capture phase:

- **Capture, because the card has to lose.** React's handlers sit on the root,
  below `document`, so a capture listener runs first. That is the only way
  "stay" can stop a card's `onClick` before it switches the panel. The e2e
  shows it: with `stopPropagation` taken out, the unsent-comment check fails
  because the panel moves to OPS-1.
- **Focus is read at the press, not the click.** Pressing on empty space moves
  focus off the field as its default action. By the time `click` fires, the
  field has already let go, and "leave the field first" would never trigger.
- **Both ends are classified, and the busier one wins.** A press in the panel
  that ends on the board is a text selection, not a click. A card dragged to
  another column fires `click` on the board, the nearest ancestor of both ends,
  and would otherwise look like empty space.
- **What changes mid-click is read through refs.** A blur that commits a field
  flips `busy` between the press and the click. Re-registering the listeners
  then would forget where the press landed.

**Where the build moved off the plan.**

- **Items are marked, not recognised by class.** The plan listed `.card, tr,
  .cal-chip` among the controls. Each view's clickable item now carries
  `data-item-key` instead: the board card, the backlog row, the agenda row, the
  calendar chip and the history row. Matching one attribute means a restyled
  view cannot quietly drop out, and it separates "another item" from "a
  control". The rules need that distinction, because the calendar chip and the
  agenda row are buttons too.
- **Overlays are recognised by their backdrop too, not only by `overlaid`.**
  The Jira push pane is a modal that App's `overlaid` flag does not include. A
  click on `.modal-backdrop` or `.palette-backdrop` counts as the overlay's
  whatever the flag says.
- **No portals.** The plan asked to check whether the panel's menus render
  outside `aside.detail`. None do, since nothing in the renderer uses
  `createPortal`, so containment in the panel is the whole check.

The plan's three questions went to the user, and each got the recommended
answer. With a comment unsent, clicking another card stays rather than
switches. The rule applies in all five views, not the board alone. A warning
on ✕ for an unsent comment is a separate follow-up, now in IDEAS.md.

**A finding the e2e forced.** At the harness's default window size, the panel
covers the right-hand board columns and the right of the toolbar, including
Hide closed. A card or a filter under it cannot be clicked by anyone. The spec
widens the window to 1600×1000 and finds a card and a filter the panel leaves
uncovered, rather than naming ones that may be hidden. That is how the panel
has always behaved, and it is worth knowing when people ask why a filter will
not respond.

Verified: 12 unit tests; `e2e/detail-outside-click.e2e.mts` 7/7 on the board,
and the full e2e suite 62/62. **Not verified:** the other four views were not
driven. They share the listener, and all that differs between them is the
`data-item-key` markup. Nobody has yet spent the plan's ten minutes of real use
deciding whether "empty space" feels right on a busy board.

## Jira values are typed as a person means them, and shaped by the core ✅ built (core half)

The first real use of the push, against a production Jira, showed what the
design got wrong. Every extra field without a control of its own fell to a
JSON box labelled *sent exactly as written*. On a real project that was most of
them. The ones that hit were paragraph fields (*Project objective / goal*,
*Proposed solution at onset*), people fields other than the assignee,
cascading selects, and custom text and multi-select fields. A person was
expected to write ADF by hand to say one sentence. The ask that came back was
plain: accept a valid value and build the JSON.

**Shaping moved from the editor to the planner.** `plans/PLAN-jira-push.md` had
every value stored *already in Jira's shape*, so the push never translates. The
consequence was that the editor had to emit Jira's JSON, so any field without a
bespoke editor dumped that JSON on the person. Now `shapeFieldValue` in
`jira-meta.ts` takes what was typed and the field's create-screen metadata, and
returns Jira's shape:
- an option's name becomes `{ id }`, matched against Jira's own list
- a paragraph becomes ADF
- a person's name becomes `{ accountId }`, through the map's `people`
- `Parent / Child` becomes a cascading value
- `a, b` becomes a list
- a browser's `2026-10-01T09:30` becomes Jira's full datetime with the local zone

It runs in `buildPushPlan`, inside the screen check, so each value is shaped
against the field on that draft's own issue type. That's where the metadata
already was, and where a field's options can differ between types.

**Idempotent, so nothing already written breaks.** A value that is already
Jira-shaped (`{ id }`, an ADF document, `{ accountId }`) comes back unchanged.
Every map written before this, by hand or by Settings → Jira, pushes exactly as
it did. `defaults`, the older hand-written form, is not shaped at all.

**A value that cannot be shaped is a blocker, with Jira's options named.**
"Valid" means valid against this project's screen: *Team has no option
"Paymnts". Jira offers: Payments, Platform.* That is the same line Jira's own
400 would have drawn, but drawn before anything is sent, with the fix in the
message. A stored `{ id }` whose option has since been deleted is refused the
same way, which the plan wanted from sending ids rather than names. Where a
field lists no values, an option goes as `{ value }` and a version as
`{ name }`. Jira accepts both and checks them itself.

**New kinds, each with a reason.**
- `managed` covers Rank, which Jira keeps for the board's order. It was offered
  as an extra field and showed a JSON box. It is now never sent, with a
  grouped warning.
- `sprint` takes the sprint's number.
- `team` takes the team's id as a string. Whether every site takes the bare id
  or `{ id }` is still unverified, so an object is left as written.
- `strings` covers array-of-string custom fields. They used to be `raw`, and
  are now a comma list. A custom *labels* field is `labels`, with spaces
  hyphenated as Jira requires.
- `group`, `groups` and `project` are small, but no longer JSON.
- `raw` remains for app fields whose schema says nothing. If Jira lists values
  for one, it is treated as a select over them. Otherwise text goes as text, and
  JSON still parses for the rare app field that wants an object.

**The ADF converter got its own module, and an inverse.** `markdownToAdf` lived
in `jira.ts`, which imports `fs`, so `jira-meta.ts` (imported by the renderer)
could not use it. It is now `jira-adf.ts`, beside `adfToMarkdown`, which
the settings panel needs to show a stored paragraph as editable text.
`adfToMarkdown` builds the description grammar's blocks and hands them to
`serializeDescription`, so the grammar still has one home. Whatever
`markdownToAdf` writes reads back byte for byte, which a test holds. ADF
written in Jira with more than the grammar knows (mentions, panels) arrives as
its words rather than vanishing.

**The category's custom field is shaped too.** Category could only be mapped to
a text field, and still can. Shaping it means the panel could later offer a
select there and the push would send `{ id }`, not a bare string Jira refuses.

**Drifted items are held back from the app's push.** Reviewing the build
against the plan found that an item edited after its push was drafted as a
*new* issue, with a warning. The plan said it should be listed as *update not
supported yet* and never re-created. A duplicate in a tracker a whole team
reads is the expensive mistake, so `buildPushPlan` takes `holdDrifted`. The
app's push sets it, and such an item is listed as not sent, naming the Jira key
to update by hand. The CSV export and the MCP planner keep the warning, because
a person reads their output before anything reaches Jira.

**Blank is blank.** An extra field holding `""` or `[]` used to be sent as
that, and counted as filling a required field. Now it sends nothing and fills
nothing, so a required field left blank in Settings is still a gap.

Also added: `searchUsers`, the general user search, for people fields that are
not the assignee. The assignable search answers "who may be assigned here",
which is the wrong question for a reviewer.

**Split between the two sessions.** This is the core half. The editors are the
Project Lead session's half: a paragraph box, two selects for cascading, a
people picker, comma lists, and *Edit as JSON* only as an explicit toggle on
`raw`. That half also covers no Rank in the add list, `holdDrifted` wired in
main, and three gaps the review found: the 429 wait shown in the pane, Jira's
field errors named rather than given as ids, and *Push to Jira…* in the command
palette.

18 new tests (14 in `jira-shape.test.ts`, 4 in `jira-push-plan.test.ts`), and
the kind table updated: Team and Sprint are no longer `raw`. Two mutations were tried to prove the planner tests
can fail: skipping the shaped assignment, and ignoring `holdDrifted`. Each
failed its test. 381 unit tests green, root typecheck clean, and the
`jira-push`, `jira-mapping` and `jira-push-pane` e2e specs pass unchanged
against the fake Jira. **Not verified:** the shapes for Team and Sprint on a
real site, and whether `user/search` answers for a scoped token's scopes.

## Jira values are typed as a person means them: the editors ✅ built and driven (app half)

The app half of the section above. With `shapeFieldValue` doing the shaping at
push time, the editor no longer has to produce Jira's JSON. So it stops asking
for it.

**Every kind has a control, and none of them is a JSON box.** `JiraValueField`
is still the one editor for both an extra field in Settings → Jira → Mapping
and an `ask` field in the push pane. Each control stores what a person means:
- options, priorities, versions and components are the selects and checkboxes
  they were, storing `{ id }`
- a paragraph (`richText`) is a textarea of markdown, noted *Formatted like a
  description*. A paragraph value already stored as ADF opens as its markdown
  through `adfToMarkdown`, so editing it round-trips
- a cascading select is two selects, the second listing the children Jira
  gives under the chosen parent, storing `{ id, child: { id } }`. A hand-typed
  `Parent / Child` in the map still shows as selected
- a user or users field is a picker. The map's linked people come first, and
  anyone else is found through a new `jira:search-users` IPC over the core's
  `searchUsers`, the site-wide search. It stores `{ accountId }`
  - A name written by hand in the map is resolved through People the way
    `shapeUser` resolves it. One that names nobody linked stays text, shown
    as a dashed chip, and is never wrapped as `{ accountId: "Renee" }`,
    which Jira would refuse. That keeps the push's lookup and its blocker in
    play. A comma string reads as several people. OverSeer's review found
    this.
- labels, string lists and groups are a comma input
- sprint is a number input explaining where the id is found, and team is a
  text input for the team's id
- a datetime opens an older full-ISO value as the local time it stands for,
  since a `datetime-local` input shows nothing else
- `raw` is a plain text input. *Edit as JSON* is the only JSON path in the app,
  and only that box keeps the *sent exactly as written* note. An object already
  stored opens in it

**Mistakes show under the field in Settings.** The Mapping tab passes the
field's create-screen metadata and the map's people, and the editor runs
`shapeFieldValue` on each change. *Team has no option "Paymnts". Jira offers:
Payments, Platform.* appears before Save, not only as a push blocker. The push
pane doesn't repeat it, because its blockers list is already the same check.

**Rank is never offered.** The add list skips `managed` fields. One already in
a map, written by hand or before this, shows *Jira sets this itself; it is not
sent* with Remove and no send-mode select.

**The review gaps, closed.**
- `planFor` passes `holdDrifted: true`, so the app's push lists a drifted item
  as not sent and never creates it a second time.
- A 429 is shown. `loadContext` hands the client an `onRateLimit` that becomes
  a `slowedDown` progress event with no item key. The pane counts it down:
  *Jira asked us to slow down — resuming in 12s*.
- Field errors come back named. `namedFieldErrors` (`main/jira-names.ts`, apart
  from `jira-push.ts` so a test can import it without Electron) rekeys the
  outcome's `fieldErrors` from ids to the names on that draft's issue type, and
  renames the same `id: error` lines in the message.
- *Push to Jira…* is in the command palette, the third entry point the plan
  named. The palette grew an *Actions* group above its results, matched by the
  same words. An action acts on what the window already holds: the checked
  rows, else the open item. With neither, the action isn't offered, so the
  palette never asks which items.

`main/jira-push.ts`'s private `adfText` is gone in favour of the core's
`adfToMarkdown`.

**Tests.** 8 unit tests in `test/jira-choices.test.ts` cover the choice
helpers (cascading lookup by id and by label, people choices, comma lists, the
datetime reading, hand-written names in a people field) and the error naming. The fake ENG now has, on Story, a
textarea *Proposed Solution at Onset*, a cascading *Region*, a *Reviewer*
user field, and *Rank*. It serves the site-wide `user/search`, with an app
account mixed in that must not be offered. Its `POST /issue` refuses non-ADF
in the paragraph, unknown ids in the cascade, and any Rank, as Jira does. New
e2e:
- Mapping never offers Rank, and stores a typed paragraph as markdown and two
  selects as `{ id, child }`
- the Reviewer picker offers Dan, who is linked, then finds Priya through the
  site search, leaves the app account out, and stores her `{ accountId }`
- a Rank already in the map shows as not sent, and the paragraph reads back as
  typed
- a push of a hand-written map arrives in Jira's shape: `payments` as
  `{ id: "t2" }`, markdown as ADF with its bold, `Europe / Berlin` as ids, and
  no Rank
- the palette opens the pane for the checked rows

A screenshot of the Mapping tab found every note under a value editor
uppercased like a caption. `.modal-field > span` styled every span in the
field, which is how the old JSON box's note looked too. It is now
`:first-child`, the caption only.

The `jira-mapping`, `jira-push` and `jira-push-pane` specs pass. **Not
verified:** the countdown, which no e2e drives because the fake Jira never
answers 429.

## Older `defaults` convert to extra fields in the app ✅ built and driven

`defaults` is the map's older form of extra fields. It is always sent, holds
no names, and has no per-type limit, so a field there goes to issue types whose
screen lacks it. The panel never showed it, so a map started by hand kept it
forever. The Mapping tab now offers to move it.

**Offered, and written only on Save.** When the loaded map's `defaults` isn't
empty, Extra fields shows *N fields use the older `defaults` form.* with
Convert. Convert adds each entry to the draft's extra fields, the way a newly
added field is added:
- `always`
- named from the project
- limited to the chosen types whose screen has it, with no limit when all do
- its value unchanged. It was written in Jira's shape, which `shapeFieldValue`
  passes through.

The file isn't touched until Save, like every other edit on the tab. The Save
then carries `convertDefaults`, the ids to remove from `defaults`.

**A value is never just deleted.** `mappingEdits` refuses a converted id that
isn't among the extra fields on the same Save. The renderer sends only the ids
still in its draft. So a converted row removed again before Save stays in
`defaults`, and the notice offers it again.

**Edge cases.**
- An id already among the extra fields keeps that entry and drops the
  default. The extra field was already the one being sent over it.
- A default whose field is on none of the chosen types converts without a
  limit, as it was sent before, and its row says *on none of the chosen
  types*. The push's screen check then drops it per type.
  `newExtraField` gained the same rule: it used to write `issueTypes: []`,
  which the map can't hold and which saved as unlimited without saying so.

**Comments survive.** The removals are path edits, so the block's comments
stay. When every entry goes, the block is set to `{}` rather than deleted,
which is how the example file writes an empty block.

**Tests.** Two unit tests in `jira-mapping.test.ts`, against a real file:
- a partial conversion keeps the other entry and the comment, and a full one
  leaves `defaults: {}`
- a conversion without the matching extra field is refused

One e2e case: a hand-written `defaults.customfield_10001: { id: t1 }` shows the
notice. Convert gives a Team row on Epic, Story and Task with Platform
selected, and the file is unchanged until Save. After Save, the file has the
extra field, `defaults: {}`, and a clean commit. **Not driven:** the *on none of
the chosen types* note.
## An issue changed since its push is updated, field by field ✅ built (core half; Jira push, slice D1)

Slice D's first item, re-planned after the push had been used against a real
project, as `plans/PLAN-jira-push.md` asked. Until now an item edited after its
push was either created a second time (the old behaviour) or held back with
*update it in Jira by hand* (`holdDrifted`, earlier today). The issue in Jira
went stale, and the item read as `drifted` forever.

**Read Jira first, because the vault does not know what it sent.** The push
stamps a content hash, not the values, so the vault can say *something
changed* but not *what Jira holds*. Jira may also have been edited since,
by anyone. So an update reads the issue
(`GET /issue/{key}?fields=…`), sets it beside what the vault would send, and
offers only the fields that differ. Nothing is sent that was not shown. Storing
a snapshot of every pushed payload in the item would have avoided the read, but
it would still be wrong the moment someone edited the issue in Jira, and that
is exactly the case worth seeing.

**Four pieces, so the pane can stand between them.**
- `buildUpdatePlan` (in `jira.ts`, beside `buildPushPlan`): pure. It builds the
  vault's side for each item changed since its push. `itemFields` was pulled out
  of `buildPushPlan` for this, so a create and an update cannot disagree about
  what an item sends. `changedSincePush` is likewise the one test both paths
  use.
- `readIssueState`: the issue's current values, and its **edit** screen
  (`/editmeta`), which is its own list. A field can be settable at create and
  locked afterwards.
- `diffIssue`: pure. One `JiraFieldChange` per differing field, with Jira's
  value and the vault's as a person reads them, whether Jira will take the
  change, and why not when it will not.
- `sendUpdates`: one `PUT` per issue with only the chosen fields, then a
  restamp.

**What counts as the same.** Jira hands values back fuller than it takes them,
so the comparison is driven by the vault's side:
- `{ name: "High" }` matches `{ id: "2", name: "high", iconUrl: … }`
- labels match in any order
- rich text is compared as the markdown it reads as (`adfToMarkdown`), because
  Jira adds ids and attributes to stored ADF

A test feeds Jira's fuller shapes for every vault field and expects no changes.
Making the comparison a plain `===` fails three tests.

**What the item no longer has is cleared, with two exceptions.** A due date
removed in the vault is sent as `null`, so it is removed in Jira, and a list
emptied is sent as `[]`. The exceptions:
- Priority, which Jira never leaves empty.
- An assignee whose name has no account in `people`. That is left as Jira has
  it, because "the map does not know this person" is not an instruction to
  unassign.

Removing a parent is shown but cannot be chosen. That is done in Jira. A
changed issue type is a warning, since an update cannot move an issue.

**Extra fields are not updated.** They are the map's, set once at create, and
an update is about what changed in the item. Updating them would also re-send a
Team or a Sprint someone deliberately changed in Jira.

**The restamp follows the person's choice, not the field count.** After an
update lands, the item is stamped as pushed, even if some differing fields were
left unticked. Keeping Jira's value for a field is a decision. Without the
stamp the item would read as changed forever, and the same field would be
offered at every push. An item whose diff is empty, because someone already
made the change in Jira, is restamped with no request at all. That is how a
`drifted` label finally heals.

**Except a difference nobody decided about.** Reviewing the pane's PR found
the gap in that rule. The push re-reads Jira, so its diff can hold a field that
changed after the person looked, or a ticked field that Jira has since stopped
accepting. Stamping then would bury that field until the next edit. So
`UpdateChoice` takes `restamp: false`. The chosen fields are still sent, the
item keeps reading as changed, and the rest is offered at the next push.

**No journal.** The create journals each attempt because a dropped connection
leaves a duplicate possible. A `PUT` repeated leaves the issue as one would, so
a dropped update says sending it again is safe, and nothing is held back.

**The other half is the pane's.** The Project Lead session will add a *Changed
since pushed* section to the push pane, with a row per field reading *Jira now
→ vault*, a checkbox each, and *Create N and update M*.

11 tests in `jira-update.test.ts`:
- planning: only changed items, carrying `jiraId`, no extra fields, and the
  clearing rules
- the diff: Jira's fuller shapes, readable rows, non-editable reasons, a typed
  category shaped against the edit screen, a type change
- the read, against the fake `fetch`
- the send: only chosen fields, empty means restamp only, a refused update is
  not stamped, a dropped one says a retry is safe
- a round trip through a real `Vault`, after which nothing is offered

400 unit tests green (221 core), root typecheck clean. The `jira-push`, `jira-push-pane`
and `jira-mapping` e2e specs pass. **Not verified:** a real site's `editmeta`
and the shapes it hands back, notably whether `parent` appears on a
team-managed project's edit screen.

## The push pane updates changed issues ✅ built and driven (app half; Jira push, slice D1)

The app half of the section above. An item changed since its push no longer
sits in *not sent* with "update not supported yet". The pane shows it beside
its Jira issue, field by field, and the same button sends what was ticked.

**The pane.** *Changed since pushed* sits above the creates. Each item has its
key, summary, and a link to the issue, then one row per differing field:
- name, Jira's value now, →, the vault's value, with "empty" for nothing
- a tick, on by default
- a field the edit screen won't take is shown, unticked and disabled, with
  Jira's reason, so no difference is hidden

An item Jira already matches says so and offers *Mark as in sync*. The button
counts both halves and leaves out an empty one:
- *Create 2 issues in ENG*
- *Update 1 issue in ENG*
- *Create 2 and update 1 in ENG*

*0 issues to create* is left out when the push only updates. The outcome gains
an *Updated* list naming the fields sent. Progress shows *updating…* and the key.

**What crosses IPC.** The preview sends only texts and tick state, never values.
The push sends `updateFields`, the ticked field ids per item. Main then:
- runs the creates first, so a parent made a moment ago is in Jira before its
  child's parent field is compared
- rebuilds the update plan and reads each issue again
- takes every value from that fresh diff
- drops a ticked field that no longer differs without a word
- skips, with its reason, a ticked field that has become uneditable

**Stamped only for what was seen.** OverSeer's review found this. The fresh
diff at push time can hold a difference nobody saw: someone edits the issue in
Jira while the pane is open, or a ticked field stops being editable. The pane
therefore sends, per item, the ids it showed (`seen`) beside those ticked. When
the fresh diff has a change outside `seen`, or a ticked field Jira will no
longer take, main sets `restamp: false` (#78). The ticked fields still go, but
the item keeps reading as changed. The outcome says which, for example *ENG-7:
Due date changed in Jira since you looked, so ACME-3 still reads as changed*,
and the next look offers that row.

**Nothing ticked means "not now".** Unticking every field is the only way to
hold one item back from a push. Such an item is left out of the push: not sent,
not stamped, and not counted in the button. Its block says *Nothing ticked:
left for a later push*. With some fields ticked, the unticked ones keep Jira's
values and the item is restamped, since that is a decision per field. Every
changed item the push doesn't update is listed once as *not updated this time*.
`updateFieldChoices` (`shared/jira-push-label.ts`) builds the `{ ticked, seen }`
per item.

**Mark as in sync** is its own IPC, `jira:mark-in-sync`. It reads Jira again,
restamps only if the diff is still empty, and sends nothing to Jira. If the
issue has changed meanwhile, it refuses and names the fields that now differ.

**An unreadable issue is that item's problem only.** A 404 reads *ENG-7 no
longer exists in Jira, so ACME-3 is not updated*, and that item is left out.
Any other read failure says the same with Jira's message. The preview drops
items listed as updates or problems from *not sent*, so none appears twice.

**Field errors from a refused update** are named from the issue's edit screen,
not the create screen. To allow that, `namedFieldErrors` now takes a name
lookup instead of a project and issue type.

**Fake Jira.** Each created issue gets three routes:
- `GET /issue/{key}`, with its type named
- `/editmeta`: the create screen less project, issue type and reporter
- `PUT`, which is checked like the create (no field off the edit screen, no
  non-ADF rich text, no Rank) and applies `null` as a clear

`updated` records exactly what each PUT carried.

**Tests.** 3 unit tests, in `jira-push-label.test.ts` and the updated naming
test. Three e2e cases:
- **Update:** push a story, then change its summary and clear its due date in
  the vault. The pane shows exactly those two rows, ticked; the item isn't
  under *not sent*. Unticking the due date and pressing *Update 1 issue in ENG*
  sends one PUT carrying only `summary`. Jira keeps its due date, the item
  reads pushed, and a third look offers nothing.
- **A change in Jira after the pane was read:** the pane shows only the
  summary. The fake then moves the due date before *Update* is pressed. The
  PUT carries only `summary`, the outcome names the due date, and the item
  isn't stamped. The next look offers *Due date* (Jira's new date → the
  vault's), and unticking it leaves the item for a later push, with no button
  to press.
- **Mark as in sync, and a deleted issue:** one issue edited the same way on
  both sides, and another deleted in Jira (its GET answers 404). The pane
  offers *Mark as in sync* for the first, which stamps it with no PUT, and
  names the second as no longer in Jira.

A screenshot of the pane was checked by eye. **Not verified:** a refused PUT's
named field errors through the app, and the "became uneditable between preview
and push" path. The unseen-change path is driven, but the fake's edit screen
never changes.

## The scratch pad: dump first, decide later ✅ built and driven (#85–#96)

Ideas, pasted snippets and half-formed to-dos had nowhere to land short of a
real item, which demands a project, a type and a summary the person does not
have yet. The scratch pad is a staging area for them: notes go in with nothing
decided, the keepers are promoted into items one motion at a time, and the rest
are removed. It was built in nine slices over one day by two sessions,
OverSeer on the core and the Project Lead on the app, against a plan reviewed
twice before any code was written. Most of what follows is what those reviews
changed.

**One file per note, not one list.** The first draft kept the pad in a single
`scratch.json`. The app and the MCP server are separate processes writing the
same vault, and a shared list is read-modify-write: Claude adding a note while
the app removes one would lose one of the two writes. A note is therefore
`scratch/<id>.md`, with `id` and `created` as frontmatter and the text as the
body, the answer the vault already gives for items. Every add, remove and
restore touches exactly one file. A test drives two `Vault` instances over one
folder with interleaved adds and removes and checks that nothing is lost. JSON
would also have escaped newlines, turning a pasted SQL query into an unreadable
one-line diff in history.

**Nothing is cached, and `load()` does not read the folder.** Every MCP tool
call reloads the vault anyway, and the desktop re-reads on a watcher event, so
an index would only be one more thing to go stale. `listScratch()` reads the
folder on each call, newest first, and returns a note that will not parse in
`errors` rather than throwing, so one hand-edited file cannot hide the rest. A
file whose `id` disagrees with its filename counts as broken, because removing
it by the listed id would name a file that does not exist. The schema is
passthrough rather than strict, unlike items: an MCP server a version behind
the app is a normal state, and strict would make it drop every note carrying a
field it has not heard of.

**The text is kept as written.** `serializeFrontmatter` trims the body, which
would strip the indentation from a pasted YAML or Python snippet's first line,
so notes are written after the frontmatter rather than through it. Only leading
blank lines and trailing whitespace go.

**Removing trashes.** Notes go to `.trash/scratch/`, like items, so the Undo
toast and Claude's remove are both recoverable, the Trash panel lists them, and
its count includes them. History covers `scratch/` and `.trash/scratch`, with a
`scratch` subject titled by the note's first line.

**Promote is one commit, and the order is the guarantee.** Building promote on
`createItem` as it stood would have made two commits, since `createItem`
committed itself, and an interruption between them would strand a duplicate
with nothing tying the two together. `createItem` was split into
`writeNewItem`, which keeps the key-collision retry around the write alone, and
a thin commit. `promoteScratch(id, input, { keep })` writes the item first,
trashes the note second, and commits once as `Promote scratch note to <KEY>`. A
failure between the two steps leaves a duplicate, never a lost note. If the
note cannot be trashed, the item is still committed and the error begins
*Created <KEY>, but the note stayed on the scratch pad*. Both the app and
Claude's tool description treat that message as "the item exists", because a
caller that read it as "nothing happened" and retried would create the item
twice.

**Provenance is the commit subject, never the description.** The first draft
appended *Promoted from scratch* to the item's description. The description is
what a Jira push sends as the issue body, so that line would have reached every
ticket, read by people who never saw the pad, and sat in the rich editor as
text to delete. History keeps the subject; nothing visible changes.

**Claude gets five tools, not three.** With only add, list and remove, "turn my
scratch notes into tickets" would have Claude call `vault_create_item` and then
`vault_scratch_remove`: the two-commit strand the core promote exists to
prevent. `vault_scratch_promote` takes exactly `vault_create_item`'s arguments,
now one shared object so the two cannot drift, and its description says the
note's text is not copied for Claude, which writes the summary itself.
`vault_scratch_restore` is the fifth, because the server's own instructions say
deletes are recoverable and a remove with no way back would contradict them.

**In the sidebar, under the app's name.** Scratch was planned as a sixth tab,
then as a single row above Projects. A tab implied the project filter applies,
as it does on the other five. The single row, at the top of the sidebar, read
as the app's title and showed nothing of the pad. The sidebar is now the
**ToDo Vault** title with the version beside it, then a Scratch section built
like Projects (count, *+ new*, the five newest notes, *More…*), then Projects.
*+ new* and Shift+N add a note inline from any view without leaving it. The
notes therefore ride on every snapshot, not just the page's, and the watcher
covers `scratch/` so a note Claude adds appears without a click.

**The page shares keys with the item views without inheriting them.** `j` and
`k` move between notes, `x` removes the selected one, `c` returns to the
capture box, and every other item key is swallowed on Scratch so it cannot act
on an item selected before the page was opened. The capture box takes focus on
arrival and never after an add or a remove, because a focused box disables
every bare key. The selected note is derived from the snapshot rather than
pruned by an effect; the effect raced the move to the neighbour after `x`. `/`
does nothing there, and opening an item from Scratch goes to Backlog, since the
item's panel and the promote panel would want the same side of the window.

**The promote panel reuses the New item form.** `CreateDialog` was a modal that
owned its fields. They were extracted first, as `ItemFormFields` and
`useItemForm`, with no change in behaviour and an e2e of the dialog written
against the old code before the extraction. The panel then fills the form from
the note:
- the summary is the first line, cut near a word boundary at 255 characters
  with the rest moved into the description, never dropped
- a note that opens with a code fence keeps its whole text as the description,
  since splitting off a line would unbalance the fence
- the type is `bug` only on strong words and `task` otherwise, never a story
  on a guess

After Create the next note is selected and `reseed()` refills type, summary and
description while project, parent and category stay, so triaging ten notes into
one epic is ten Ctrl+Enters. Ctrl+Enter works from the description too, through
a new `onSubmit` on the rich editor, which otherwise keeps that chord to itself.
Promote never sets `lastCreated`, which would open the new item over the panel;
the toast's *Open* is the way to it.

**Claude drafts only on request.** The plan once had the panel ask Claude for
every note it showed. That defeats the batch rhythm, costs money per note, and
sends a pasted query or token to the API without anyone choosing to. *Draft
with Claude* is a button, labelled as sending the note, off with a pointer when
no key is stored, and a reply that arrives after the selection moved is
dropped. Its e2e answers from a local fake through `ANTHROPIC_BASE_URL`, and
checks in the main process, before the dummy key is stored and before each
click, that the app really is pointed at it.

**A pasted list asks once.** Several plain lines pasted into either box offer
*Add as N notes* or *Keep as 1 note*. A fenced block or wholly indented text is
one note with no question. Nothing is guessed from punctuation: the mockups'
test for `;{}()=` would have called prose with brackets code. Blank lines are
never notes, and past 50 lines no split is offered, since each note is its own
file and commit. A split that fails part-way shrinks the offer to the lines not
yet saved, so a retry cannot duplicate them. The sidebar's box became a
textarea for this: as an input it silently turned a pasted newline into a space
and would have merged the list.

**Left out on purpose.** Bulk promote, along with the planned modes that made
one note an epic and the others its stories, which would need
dependency-ordered creates in one commit; "separate items" waits until someone
asks. The per-note monospace toggle, since fences already render as code.
Capture from outside the app (`vault scratch add`, a global hotkey) and an age
nudge in Agenda are the next steps worth taking, and are not built.

**The e2e suite and load.** Running the suite while both sessions were building
on one machine timed out `detail-outside-click` twice. The test, not the app,
was wrong: a click during a write is ignored on purpose, and the commit that
finishes a rename can still be running after the file has changed, so the
closing click now repeats while the panel is open (#93). A cap on how many spec
files run at once was measured, four at a time taking a full run from 47 s to
75 s, and closed unmerged (#94): no run failed either way, so the cost bought
nothing demonstrable. The paste spec restores the clipboard's text afterwards,
because the clipboard is machine-wide and `--user-data-dir` does not isolate it.

The version moved to 0.9.0 the same day (#83, #84). The number is read from
`package.json` by the MCP handshake and `vault --version`, and by the app
through `app.getVersion()`; the title row is where it shows.

**Tests.** 246 core tests (20 over the store and promote, and one stdio MCP
session over every scratch tool) and 185 desktop tests, typecheck clean, and
the full e2e suite at 120/120, with new specs for the plumbing, the page,
promote, the Claude draft and pasting. **Not verified:** the scratch tools from
a live Claude Desktop or Claude Code session, Claude's drafts against the real
API, the dark theme and a small window for the new panels, and a real process
crash between promote's two writes, which the ordering argues for and no test
reproduces.

## The scratch pad after a day of use: a box that empties, notes that edit ✅ built and driven (#98–#101)

Two complaints came out of the first day of real use, both on 2026-10-01. A note
added from the sidebar seemed not to be saved, so it was added again. A note,
once saved, could not be changed, and fixing a typo meant removing it and
typing it out again. They were written up in IDEAS.md (#98) and built the same
day, the core by OverSeer (#99) and the app by the Project Lead (#100, #101).

**The box empties as the note is sent, not once it lands.** The report said
Ctrl+Enter added a note and left the text in the box, and the write-up guessed
that some window-level handler was saving it without going through `submit`.
Driving the built app showed otherwise. Ctrl+Enter did nothing in either box;
plain Enter was what saved. Both boxes did empty, but only after main had
answered, which is after the git commit. On a vault where a commit takes a
moment, the text sat in the box long enough to read as "not saved", and nothing
stopped a second press. So `submit` in both `ScratchSection` and `ScratchPage`
now clears the box in the keypress that sends the note. A second press finds
nothing to send, while a new note typed during the save still goes. A refused
save puts the text back, but only if the box is still empty, so it never
overwrites what was typed since. A busy flag was tried first and dropped: it
swallowed the Enter of a note typed while the previous commit was running, and
the paste spec caught it. Ctrl+Enter now adds too, since it is what saves
everywhere else. The confirmation reads *Note added to Scratch*, or *N notes
added to Scratch* for a split paste, and shows only away from the Scratch page,
where the new card is confirmation enough. Whether the user's own vault commits
slowly enough to explain the report is not verified.

**An edit is a commit, though the ask was for none.** The request was that
edits need not be kept in history. Skipping the commit does not achieve that:
`commit()` stages with `git add -A`, so an uncommitted edit would be swept into
the next unrelated commit under that commit's subject, which is worse than a
commit of its own. Keeping notes out of git altogether, by ignoring `scratch/`
in the vault, would have untracked every existing note and broken the server's
promise that every write is committed. So `updateScratch(id, text)` makes one
`Edit scratch note` commit per save, and the app saves when the person is done,
not per keystroke. Unchanged text writes and commits nothing, which is what
makes saving on blur free. It shares an add's cleaning and limit through
`checkScratchText`. Only the body is rewritten, and the frontmatter is copied
as written, so a field from a newer version survives an edit from an older one.
The note keeps its id and `created`, and with them its place in the list; an
`updated` field would have been a schema change for no visible gain. There is
no MCP tool for it, since Claude can remove and re-add.

**Editing happens on the card.** Double-click a card, or press `e` on the
selected note, and its rendered Markdown becomes a box. `e` was already
swallowed on Scratch and already meant "edit" on the other views, so it was
free to take. Ctrl+Enter or leaving the box saves; Escape cancels, and stops
the event, because App's own Escape blurs the field and a blur saves. The edit
lives on the page, keyed by the note's id, not inside the card: each save
refreshes the list, and a note promoted or removed elsewhere mid-edit takes its
card with it. When that happens the text moves into a box above the list with
*Save as a new note* and *Discard*, and Escape there only leaves the box, so a
slip of the key cannot lose it. One edge is left. Text typed while a save is
still running, followed by a blur, is not saved by that blur, so the box stays
open with the text until the next one.

**The promote panel follows an edit.** The write-up called `PromotePanel` safe
because it prefills only when the note changes. Review found the gap: selecting
a note to edit it opens the panel, which prefills from the text before the
edit, so a typo fixed on the card came back in Summary. The panel now refills
Type, Summary and Description when the same note's text changes, but only the
fields still equal to what the old text put there. Anything typed over, or
filled by a Claude draft, is kept. It patches those fields through
`useItemForm.patchText` rather than reseeding, which would also have cleared
the priority and due date chosen since. If the rich editor normalizes the
Markdown, the description counts as touched and is left alone; whether it does
is not verified.

**Tests.** 250 core tests (4 new over the edit) and 185 desktop tests, typecheck
clean. New e2e specs drive Ctrl+Enter twice in the sidebar box (one note on
disk, an empty box, the toast, focus kept), editing (counting `Edit scratch
note` commits in the vault's log: one per save, none for a cancel or an
unchanged blur), the rescue of a note removed mid-edit, and Summary following a
fix made on the card. #100 and #101 both changed `ScratchPage` and were each
tested alone, so the scratch, edit and paste specs were run again on the merged
main, 27/27. One flake is open: *More… opens the page* failed once in a full
run and passed on three reruns, and has not been traced.

## A field from a newer build survives an older one ✅ built

SCHEMA.md promised that unknown fields on disk were kept when an item was
rewritten. They never got that far. `ItemFrontmatterSchema` and
`ProjectSchema` were strict, so an older build rejected any file carrying a
field it did not know, recorded `Unrecognized key(s) in object` in
`load().errors`, and left it out of the index. The file was safe, because
nothing can write an item it cannot load, but it was invisible in every view
and refused every write. Project-wide writes passed over it: a rename left it
under the old key, pointing at a project that no longer existed, and a
project whose only item was the hidden one could be trashed without
`cascade`. The desktop app, the in-app assistant and several MCP servers
routinely run different builds against one vault, and the next item fields
(`dependsOn`, `claimedBy`) were about to land, so the first test recorded the
failure as it stood before anything was changed.

**Keep, rather than document the strictness.** The other option was to leave
both schemas strict, correct SCHEMA.md, and ship every new field only after
every build was upgraded together. That costs nothing now and something every
time a field is added, and the app and the MCP servers are not upgraded
together in practice. Keeping was also nearly free, because the write side was
already there: every write path spreads the stored item (`mergeUpdate`, tick,
comment, link, rank, `rekeyItems`), and `serializeFrontmatter` already wrote
keys outside `FRONTMATTER_ORDER` after the known ones. Only the strict parse
was in the way. The user chose this option and asked for projects to be
included.

**Passthrough on the schema, strict on the type.** `.passthrough()` adds
`[k: string]: unknown` to the inferred type, and then `item.dueDtae` would
compile in core and desktop alike. So the field list is declared once as a
plain object (`ItemFrontmatterShape`, `ProjectShape`), the exported schemas
are that list with `.passthrough()`, and `ItemFrontmatter` and
`ProjectFrontmatter` are inferred from the list, not from the schemas. A
misspelled field in code still fails to compile, which was checked with a
throwaway `@ts-expect-error` probe.

**A typo in a file is now a notice.** Keeping unknown fields means a
hand-edited `dueDtae:` is kept and ignored, not rejected. `load()` now returns
`notices` beside `errors`, one line per file naming the keys this build does
not know, and `vault doctor` lists them under their own heading without
setting a failing exit code, because the same line is correct when a newer
build wrote it.

**Except `description`.** The first cut let a `description:` key in
frontmatter load like any other unknown key. The loader then overwrote it with
the body, and the next save dropped it, so its text was lost without anyone
having seen it: the desktop snapshot ignores `notices`, and the MCP tools
project known fields only. No build writes that key; it arrives from hand
edits, often copied from tools that keep a description in frontmatter. Review
caught it, and both schemas now carry a `superRefine` issue for it, so the
file lands in `load().errors` as it did before this change and is never
rewritten. `unknownFrontmatterKeys` skips it. The write paths are unaffected,
because `writeAndIndex` strips `description` before it parses.

**What the write-side parse no longer catches.** `writeAndIndex` parses with
the passthrough schemas, so a stray key that code casts onto an `Item` or
`Project` is now written to disk instead of rejected. The exposure is small:
`CreateItemInput`, `UpdateItemInput`, `BulkUpdateInput` and
`UpdateProjectInput` are still strict, and the exported types still refuse a
misspelled field, so a key can only get there through a cast.

**What it does not cover.** Builds older than this change still reject unknown
fields, so a new field is safe only once every app and MCP server opening the
vault has been rebuilt past it. The nested link, attachment, comment and sync
schemas stay strict. A field added inside one link still drops the whole item
in an older build, and making them passthrough means also checking the writes
that build those objects fresh (`markPushed`, `addLink`). That is TV-11 in the
agent vault, and a test in `unknown-fields.test.ts` records the gap. An older
build also carries a newer field without acting on it: it will not rewrite
item keys held in one during a re-key, and it will not enforce a rule one
implies. SCHEMA.md's "Extending it" now says so.

**Tests.** `unknown-fields.test.ts` has 14 tests. The item loads, is listed
and searchable, and keeps its unknown key through update, bulk update,
transition, comment, link, clearing a known field, project rename, move to
another project, and trash and restore. `deleteProject` now counts it. A
pushed item does not read as drifted. A project keeps its unknown key through
update and rename. `notices` names a misspelled field, and a nested link field
still drops its item. An item file and a project file with a `description:`
key are in `errors`, missing from every read, refuse writes, and are byte for
byte unchanged afterwards, while the write paths still save a body. `vault
doctor` is run from source: a misspelled field is one notice with exit code 0,
and a `description:` key is a problem with exit code 1. Not verified: the
desktop app and an MCP server were not run against such a vault. Both go
through the same `load()` and write paths, and nothing in the app shows
notices.
