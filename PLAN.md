# Plan: the Electron desktop shell

Stack is decided: **Electron**. This started as the plan for the desktop shell
and has become the log of what was built and why each call was made.

**Phases 0 through 4 are complete**, plus the run of smaller features recorded
below them. The suite is at 204 green tests — 111 in the core, 49 over the app
(ordering, selection, navigation, links, history formatting) and 44 over the
scripts in `scripts/`. The counts in this paragraph have drifted before; CI now
runs the suite on every push, so a stale number here is a documentation lapse
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

**Still outstanding, and known.** Two checks need eyes rather than assertions,
by this codebase's own standard that "a check that reads the DOM cannot verify a
native control": the date picker's popup and indicator following into Light, and
the Windows window frame following into Dark. And Part 2 of the plan is not
done — the light block redefines twelve surface tokens and leaves every status
and priority hue at values chosen against `#0f1115`, `--disregard` included.
That is design work rather than typing, it does not block the button, and until
it lands light mode is offered rather than supported. `plans/PLAN-theme-toggle.md`
keeps the argument for it.
