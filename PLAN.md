# Plan: the Electron desktop shell

Stack is decided: **Electron**. This started as the plan for the desktop shell
and has become the log of what was built and why each call was made.

**Phases 0 through 4 are complete**, plus the run of smaller features recorded
below them. The suite is at 84 green tests — 64 in the core, 20 over the app's
`ordering.ts`. **Phase 5, the Jira push UI, is the only phase left**, and it
carries `vault jira discover` with it.

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

## Phase 5 — Jira push from the UI

`buildPushPlan` output in a review pane, then the POST as an explicit user
action. Also implement `vault jira discover`: both the README and a warning
string inside `jira.ts` instruct you to run it, and `cli.ts` has no such
subcommand — the only two `jira` subcommands are `csv` and the default plan.

## `reporter` — who asked for it, surfaced in the app

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

**`vault jira discover` still does not exist.** Both the README and a warning
string inside `jira.ts` tell you to run it. Phase 5.

**The OneDrive half of `PLAN-LINKS.md` is designed and not built.** Links and
attachments open, which was steps 1–2; a synced document can still be copied into
`attachments/` and fork from the original, which is what steps 3–4 exist to
prevent.

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

## The `npm audit` finding that is not reachable

`npm audit --omit=dev` reports GHSA-frvp-7c67-39w9 — path traversal in
`@hono/node-server`'s `serve-static` on Windows via an encoded backslash
(`%5C`), fixed in 2.0.5. It arrives transitively: `@modelcontextprotocol/sdk`
1.29.0 depends on `@hono/node-server` `^1.19.9`, which resolves to 1.19.15.

**It is not reachable from this codebase, on two independent counts.** The SDK
never imports `serve-static` at all — that is a separate subpath export
(`@hono/node-server/serve-static`), and the SDK's only use of the package is
`getRequestListener` from the package root. And that single import lives in
`server/streamableHttp.js`, which is not in the transitive import closure of
`server/mcp.js` plus `server/stdio.js` — the 16-file closure `mcp-server.ts`
actually pulls in reaches nothing outside `ajv` and `zod`. The server speaks
stdio; no HTTP listener is ever constructed, let alone a static file handler.

**So it is recorded rather than fixed.** The upgrade was tried and does work —
SDK 1.30.0 widens the range to `^1.19.9 || ^2.0.5`, and with
`@hono/node-server` then pulled up to 2.0.12 the audit is clean, typecheck
passes, the suite is unchanged, and a stdio smoke test still lists all 26 tools
and returns real data. It is left undone because a major bump of an unused
transport's unused dependency buys nothing but a quieter audit line, and the
same bump is free to take later on its own merits.

**What would invalidate this.** The reachability argument is contingent on the
transport staying stdio. If `mcp-server.ts` ever imports
`StreamableHTTPServerTransport`, `@hono/node-server` enters the running code and
this section stops being true — see the note at that file's imports.
