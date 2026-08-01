# todo-vault

A local, Jira-shaped task tracker that lives in plain markdown files, so the
desktop app, an in-app assistant, and any Claude on the outside can all read and
write the same data without a server.

The schema, vault core, CLI, and MCP server are done, and so is the desktop app:
it reads and writes the vault without holding any state of its own, with global
search, keyboard shortcuts, and an optional in-app assistant. The Jira push UI
is what remains; `PLAN.md` has the detail.

## Layout

An npm workspace with two packages:

| | |
|---|---|
| `packages/core` | The vault: schema, read/write, CLI, MCP server, Jira planner |
| `apps/desktop` | The Electron app over it |

The core has no idea the app exists. The app holds no state the vault does not.

## Quick start

```bash
npm install
npm run build
npm run seed -- ./vault
npm run dev
```

`npm run dev` builds the core and launches the desktop app. The CLI runs from the
repo root, so paths like `./vault` mean what they look like:

```bash
npm run vault -- agenda week --vault ./vault
```

Set `VAULT_DIR` to skip `--vault` everywhere. Add `--git` to auto-commit every
write, which gives you undo and a full audit trail for free. The desktop app
always passes it.

## The desktop app

Backlog table, board, agenda, and an item detail panel, over a project sidebar in
manual rank order. **+ new** in the sidebar head creates a project: the key is
proposed from the name — `ACME` from "Acme rollout" — and stays editable, and one
that is already in the list is refused before the write rather than after.
Renaming and deleting stay CLI- and MCP-only, since one re-keys every item in the
project and the other can take them all to the trash.

Editing is in place, with no save button: every field commits straight to the
file, because the markdown is the document and there is no draft state worth
keeping. Status dropdowns and board columns are gated on the core's own
`TRANSITIONS` table, so an illegal move is *prevented* rather than attempted and
reported — a card that springs back with an error reads as a bug even when the
message is right. The parent field is gated the same way: clicking it opens a
picker holding only what the hierarchy allows — an epic for a story, task, or
bug; a story, task, or bug for a subtask — which is the list the create form
offers too, so neither route can propose a pairing the core would refuse.
Deleting offers an undo backed by `.trash`, and refuses to orphan children until
you confirm the cascade.

Recurring items get a **✓** rather than a status change. A cadence is a schedule,
not a deadline, so marking the daily check "done" would retire it permanently —
right when you drop a habit, wrong when you perform one. The ✓ records the date
in the item's own `completions` list, leaves the status alone, and drops the item
off the agenda until its cadence comes round again: tick today's daily task and
it disappears from **today** but stays on **this week**, because it is due again
tomorrow. Press it again to undo. The cadence pill shows a ✓ wherever it appears,
so a board card says whether this week's report is handled even though the acting
happens in the agenda and the detail panel.

The description renders as markdown rather than as one collapsed line, and edits
as formatting rather than as syntax: Ctrl+B bolds, the toolbar makes headings,
bullet and numbered lists, quotes, fenced code and links, and nothing shows its
markers. The file on disk is still plain markdown — nothing here is stored as
anything else. The grammar is `packages/core/src/description.ts`, shared with
the Jira converter and with the editor's schema, so the panel cannot show, and
the toolbar cannot produce, formatting the push would drop.

Which editor you get is a fact about the text, not a preference.
`isLosslessDescription` asks whether a description survives a parse and a write
byte for byte; only then is the rich editor offered. A description using `_em_`,
`+` bullets or a run of blank lines would come back reformatted, so it opens in
a plain markdown box instead, saying why. That matters because the CLI, the MCP
server and Notepad write these files too, and `--git` commits every write: a
normalising editor would fill the history with commits nobody typed. **source**
beside the heading switches to the raw markdown by hand at any time.

One deliberate departure from strict markdown: a newline inside a paragraph is a
break rather than a soft wrap, in the app and in the ADF alike — people type
descriptions in a box and mean the line breaks they put there. Links in a
description are opened by the main process against the same scheme allowlist the
Links section uses, since a description can be written by anything with a text
editor, and the link form refuses a scheme off that list while you are still
looking at it rather than writing one that could never be followed.

Board columns are grouped by project and then by manual rank, since ranks are per
project — comparing two projects' rank numbers directly is meaningless, and doing
so made a single drag look like it reshuffled everything.

**Group by project** (`g`, or the checkbox beside Hide closed) makes that grouping
visible: the board splits into one band per project in sidebar order, separated by a
labelled bar, with the status headers drawn once at the top. Each band and the header
are separate CSS grids sharing one track definition, which is what keeps them lined
up — and keeps the header sticky, since a sticky grid item cannot escape its own grid
area and one big grid gave it nowhere to travel.

Grouping also makes the reorder rule above redundant inside a band, which is the
strongest reason to reach for it: every card in a band shares a project, so a drop
attaches to the card you actually dropped on rather than to the nearest same-project
neighbour. Ungrouped, a drop onto a foreign-project card reorders against a different
card than the one under the cursor — an honest compromise, but a compromise. Grouped
is the mode where drag-to-reorder stops lying. It is the same walk either way; inside
a band it just finds the target on its first step.

Another project's band refuses the drop and dims, the way an illegal status
transition already does. Moving an item between projects re-keys it — `WEB-4` becomes
`API-12`, and anything linking to the old key dangles — which is not something a
stray drag should be able to do. Use the detail panel for that.

The keyboard cursor changes with the grouping, because it walks the order the eye
sees: ungrouped it crosses every project's To do before reaching any project's In
progress, and grouped it finishes one band before starting the next.

The backlog nests children under their parents, and a subtree folds shut from the
twisty or with `h`/`←`. Collapse is view state — it lives in the window, never in
the file, so nothing on disk learns an item was folded. The keyboard cursor walks
the order the eye sees rather than the unfiltered array, which is why the
collapsed set is held once at the top and passed into both, and why the cursor
comes up to the parent when the subtree it was in closes.

Five type chips filter the backlog and the board together. Empty means every
type, so the unfiltered state is both the default and where turning the last chip
off returns to. They are toggles rather than a select because "everything except
subtasks" is one of the two things worth asking for and a select cannot say it.
Filtering to a middle type flattens the tree — a matched task whose epic is
filtered out is promoted to a root rather than hidden — which is the behaviour the
backlog has had since Phase 1 for every other filter, and is now covered by a test
so it reads as a decision rather than as a bug.

**Reporter** — who asked for it — sits beside Assignee in the detail panel, on the
create form, and as a filter. The suggestion menu is derived from the snapshot
the renderer already holds, never stored: there is no second list on disk to fall
out of sync with the items that are the actual source of truth. Typing draws on every item, hidden projects included,
because hiding a project should not make a colleague un-nameable; filtering draws
only on what this window shows, since a name used only inside a hidden project
could return nothing but an empty view. Spellings that differ only in case are
folded together for display and never rewritten on disk.

The same field is set and read through `vault --reporter` and through the MCP
server, which takes it on create, on update, and as a list filter, and returns it
on every full record. The fold holds there too: `listItems` matches reporter
case-insensitively, so the menu's claim that two spellings are one person stays
true when an agent acts on it. Every tool description names "requested by" as a
synonym, because a model handed prose has to land that phrase on this field rather
than bury the name in the description body, where nothing can query it.

Every relationship on the detail panel carries the status colour every other view
uses — children, links, and backlinks alike. Statuses for item links are resolved
in the main process against the whole vault rather than in the renderer, which
only knows about visible projects; a target the window does not admit exists gets
a `not shown here` note, and a deleted one reads `missing` rather than leaving a
pill-shaped hole.

`?` lists every shortcut, generated from the same registry the handler reads, so
the cheatsheet cannot drift from the keys. Ctrl+`+`/`−`/`0` size the text and are
claimed in the main process before the key reaches the page, which is what lets
them work mid-sentence in a text field.

The renderer imports runtime values from `todo-vault/constants`, never from the
package root: the root pulls in `vault.ts` and with it `node:fs`, which cannot be
bundled for a browser context. Types are erased, so those come from the root.

The shape that matters: `Vault` imports `node:fs` and `node:child_process`, so it
lives in the **main** process and the renderer reaches it only through a
`contextBridge` preload — `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`. Every call returns `{ ok, value }` or `{ ok, message }` rather
than throwing, because structured clone strips the `VaultError` class on the way
across and the core's messages are worth showing verbatim. Mutations will return
a whole fresh snapshot rather than a delta; at a few hundred items, reconciling
would be a bug farm for no gain.

`items/` and `projects/` are watched, so an edit from anything else — an external
Claude, or Notepad — shows up in about a second without a refresh. Files that fail
to parse get a banner naming them; otherwise they would simply vanish from every
view, which is the one failure mode that looks like data loss.

The create dialog has an optional drafting box: a sentence in, the form filled
out for you to read before anything is written. The key is entered under
**Claude** in the sidebar and encrypted at rest with `safeStorage`; it is used in
the main process and there is deliberately no getter on the IPC surface, so the
renderer can learn that a key exists but never read it back. The model is named
in one constant, `CLAUDE_MODEL` — `claude-sonnet-5`, because drafting one task
from one sentence is structured extraction rather than reasoning. Drafting is off
until a key is added, and the box says so rather than disappearing. Every draft
is validated against `CreateItemInput` before it reaches the form, and it fills
the form rather than writing: the confirmation step is the feature. The path is
proven against the live API — a real key has been entered and a draft requested
and returned — as a smoke test only; `PLAN.md` lists the specific behaviours
(date resolution, project inference, what a vague prompt does) that a surprising
draft is worth checking against.

```bash
npm run dev            # build core, launch the app
npm run build          # both workspaces
npm test               # 80 tests: 60 in the core, 20 over the app's board ordering
npm run typecheck      # both workspaces
```

A worked example vault is included at `./vault` — three projects and fifteen
items: an epic with stories, tasks, a subtask and a bug, recurring
daily/weekly/monthly items, examples of every link type, both ways an item can
close, a hidden project, and one item already pushed to Jira. Rebuild it from
scratch at any time:

```bash
npm run seed -- ./vault --force
```

It is also the fixture the desktop UI is developed against. `--force` clears the
vault's contents but leaves its `.git` alone, so history survives a reset.

## Commands

```
init [dir]                        Create a vault
doctor                            Validate every file, find dangling links
projects                          List projects with open counts
project new KEY "Name"            Create a project
project set KEY --name "..."      Update project fields
project rename OLD NEW            Change the key, re-keying every item
project reorder KEY --before K    Reorder the project list by hand
project move ITEM TARGET          Move an item + subtree to another project
project hide KEY                  Drop it from the desktop app's sidebar
project unhide KEY                Put it back
project delete KEY [--cascade]    Trash a project
project restore FILE              Restore a trashed project
new --project KEY --summary "..." Create an item
list [--project --status --open]  List items
show KEY                          Full item, children, backlinks, comments
set KEY --status done --due DATE  Update fields
done KEY                          Shorthand
disregard KEY                     Close it as "not doing this"
tick KEY [--on DATE] [--undo]     Recurring work: done for this period
comment KEY "text"                Append to the running log
link KEY --url|--item|--file X    Link arbitrary content
attach KEY <path> [--no-copy]     Attach a file
agenda [today|week|nextWeek|month] What needs attention
move KEY --after K --before K     Reorder by hand
delete KEY [--cascade]            Move to .trash, recoverable
trash [--projects]                List what is in .trash
restore FILE                      Bring one back
git-status                        Whether writes are being committed
jira plan [--out plan.json]       Reviewable push payload
jira csv  [--out issues.csv]      For Jira's CSV importer
```

`list --sort rank` gives the manual order; the default `--sort work` gives the
derived one (overdue, due date, priority). `link` takes any of six kinds —
`--url`, `--item`, `--file`, `--folder`, `--outlook`, `--note`. Deletes go to
`.trash/` rather than being unlinked, so recovery does not depend on git being
set up — run `git-status` to see whether it actually is.

## Wiring up Claude

The MCP server exposes the vault over stdio. Add it to Claude Desktop's config
(`claude_desktop_config.json`) or your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "todo-vault": {
      "command": "node",
      "args": ["/absolute/path/to/todo-vault/dist/mcp-server.js"],
      "env": {
        "VAULT_DIR": "/absolute/path/to/your/vault",
        "VAULT_GIT": "1"
      }
    }
  }
}
```

Then, from any Claude session: *"what's due this week"*, *"add a task to chase
the vendor SOW, due Friday, under the migration epic"*, *"mark ACME-12 done and
note that legal signed off"*.

Twenty-six tools are registered:

| Tool | |
|---|---|
| `vault_list_items` | Filtered list, compact projection |
| `vault_get_item` | Full record plus children and backlinks |
| `vault_get_agenda` | Overdue, due, and recurring, kept separate |
| `vault_list_projects` | Portfolio view, in manual order |
| `vault_create_item` | Create, with hierarchy validation |
| `vault_update_item` | Patch fields |
| `vault_transition_item` | Move through the workflow |
| `vault_tick_item` | Log recurring work as done for this period |
| `vault_move_item` | Reorder by hand within a project |
| `vault_add_comment` | Append to the log |
| `vault_link_item` | Link a URL, file, item, or Outlook message |
| `vault_attach_file` | Copy in, or point at in place |
| `vault_delete_item` | To `.trash/`, recoverable |
| `vault_restore_item` | Back out of `.trash/` |
| `vault_list_trash` | What is recoverable |
| `vault_create_project` | New project |
| `vault_update_project` | Patch project fields |
| `vault_rename_project` | Change the key, re-keying every item |
| `vault_reorder_project` | Reorder the project list |
| `vault_hide_project` | Drop it from the desktop sidebar. Deletes nothing. |
| `vault_unhide_project` | Put it back |
| `vault_move_item_to_project` | Move an item and its subtree across |
| `vault_delete_project` | To `.trash/projects/`, recoverable |
| `vault_restore_project` | Back out of `.trash/projects/` |
| `vault_plan_jira_push` | Build a reviewable payload. Sends nothing. |
| `vault_mark_pushed` | Record a completed push |

The destructive ones are marked `destructiveHint` and refuse rather than guess:
deleting something with children, or a project with items, returns an error
listing what is in the way instead of taking it along.

Because the vault is plain markdown, a Claude with only filesystem access can
already read and edit it. The MCP server adds schema validation, key allocation,
and hierarchy rules on top — worth having, but not a hard dependency.

The MCP surface, the CLI, and `Vault` all cover the same operations, so nothing
is reachable from one and not the others.

## Pushing to Jira

Push only. The vault is upstream of Jira, never a mirror of it.

```bash
cp jira-map.example.yaml vault/jira-map.yaml
# fill in your instance's custom field ids — see the comments in the file
npm run vault -- jira plan --vault ./vault --out plan.json
```

`plan.json` contains ordered issue drafts with descriptions already converted to
Atlassian Document Format. Parents are sequenced before their children. Items
already pushed and unchanged are skipped. Review it, POST it, then call
`vault_mark_pushed` (or `Vault.markPushed`) so drift detection has a baseline.

Nothing in this repo makes a network call. The actual POST is deliberately left
to you, so an offline vault stays offline until you decide otherwise.

The part that always bites: **every Jira instance names its fields
differently**. Start date is a custom field with a different id on every site.
Run this against your instance and search the output before filling in the map:

```
GET /rest/api/3/field
GET /rest/api/3/issue/createmeta?projectKeys=ENG&expand=projects.issuetypes.fields
```

If `fields.startDate` is missing from your map, the plan warns rather than
silently dropping your dates.

## Tests

```bash
npm test
```

Fifty-three tests over the core: key allocation, disk round-trips, frontmatter
stability, hierarchy rules, transition validation, both ways an item can close,
ticking recurring work and the period it counts for, backlinks, attachments,
agenda sectioning, the description grammar in both directions — including that
parsing survives a write unchanged, and that every description in the example
vault is one the rich editor may touch — ADF conversion, push ordering, drift
detection, manual reordering of both items and projects, trash and restore,
hiding and unhiding a project, project rename and cross-project moves, path
portability, git health reporting, atomic writes, and which Windows rename
failures are worth retrying.

Nine more over the desktop app, on `ordering.ts` — the pure function behind the
backlog's nesting, collapse, and type filtering. It gets tests because it is the
one piece of renderer logic where a wrong answer is invisible: rows would simply
not be where you expected, and the keyboard cursor would walk an order the eye
never sees. `npm test` from the root runs both workspaces.

## What is not here yet

- **OneDrive-aware attachments.** `file` and `folder` links and attachments open
  on click, which was the first half of `PLAN-LINKS.md`; the second half — a
  OneDrive file linked as OneDrive rather than copied into `attachments/` — is
  designed and not built.
- **`vault jira discover`.** Referenced by this file and by a warning inside
  `jira.ts`, but not implemented.
- **Renaming and deleting projects in the app.** They can be created from the
  sidebar, reordered by drag, and hidden and unhidden; the other two are CLI-
  and MCP-only.
- **The actual Jira POST.** By design.

## Files

```
packages/core/src/
├── schema.ts       zod schema — the source of truth
├── constants.ts    the pure enums and TRANSITIONS, importable by a browser
├── markdown.ts     frontmatter with stable key ordering
├── description.ts  the description grammar, both ways, shared with the app
├── recurrence.ts   which period a tick covers, and when the next one is due
├── util.ts         dates, hashing, atomic writes, rank arithmetic
├── vault.ts        core: load, validate, index, write atomically
├── jira.ts         field mapping, markdown→ADF, push plans
├── cli.ts          proves the core without a UI
├── mcp-server.ts   stdio MCP server
└── index.ts        public API for the desktop app

packages/core/scripts/
└── seed-vault.ts   builds the worked example vault

apps/desktop/src/
├── shared/api.ts   the IPC contract, imported by both sides
├── main/           Vault instance, chokidar watcher, IPC handlers, key storage
├── preload/        contextBridge — the renderer's only way in
└── renderer/       React: backlog, board, agenda, detail

apps/desktop/test/
└── ordering.test.ts  nesting, collapse, and type filtering
```

Read `SCHEMA.md` before changing anything in `packages/core/src/schema.ts`.

## The other documents

| | |
|---|---|
| `SCHEMA.md` | The data model and the rules that hold it together |
| `PLAN.md` | What was built, phase by phase, and why each call was made |
| `IDEAS.md` | Unscheduled ideas, newest first — promoted into `PLAN.md` when built |
| `PLAN-LINKS.md` | The design for OneDrive-aware links; first half built |
| `PACKAGING.md` | Moving a working copy, and the plan for a real `.exe` |
| `GETTING-STARTED.md` | Running it on a machine that has never seen it |
