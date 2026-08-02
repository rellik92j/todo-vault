# Vault schema

This is the contract. The desktop app, the MCP server, the CLI, and any Claude
with filesystem access all rely on it. `src/schema.ts` is the executable version
and wins any disagreement with this document.

## Layout

```
vault/
├── projects/
│   ├── ACME.md              one file per project
│   └── OPS.md
├── items/
│   ├── ACME-1.md            one file per item, flat
│   └── ACME-2.md
├── attachments/
│   └── ACME-2/              files copied into the vault
│       └── target-schema.md
├── .trash/                  deleted, recoverable
│   ├── items/
│   │   └── ACME-9-2026-07-25T13-06-03-925Z.md
│   └── projects/
│       └── OLD-2026-07-25T13-06-03-925Z.md
├── jira-map.yaml            how this vault maps onto a Jira instance
└── .counters.json           highest key issued per project
```

`load()` reads `items/` and `projects/` and nothing else, so anything in
`.trash/` is invisible to every query without needing a flag to exclude it.

Items and projects are trashed into separate folders because a project trashed
alongside items would produce `.trash/ACME-2026-07-25T…md`, which reads as item
key "ACME-2026" to anything parsing those names.

Items are flat rather than nested under their epics, because in Jira everything
is an issue and `type` is what distinguishes them. A flat folder means
re-parenting a task is a one-line frontmatter edit rather than a file move, which
matters when two processes might be writing at once.

## Item file

YAML frontmatter, then the markdown body. The body **is** the description — no
separate `description` key.

```markdown
---
id: 45ef97de-f280-4500-a5eb-406c75f37d5c
key: ACME-3
project: ACME
type: task
summary: Send the vendor SOW for legal review
status: in_progress
priority: medium
parent: ACME-1
category: Procurement
labels:
  - vendor
  - legal
dueDate: 2026-07-31
cadence: none
links:
  - type: outlook
    target: outlook:AAMkAGI2NDQyZjc5
    label: Vendor kickoff thread
sync:
  state: never
created: 2026-07-24T09:12:03.104Z
updated: 2026-07-24T11:40:55.812Z
---

Legal needs to review sections 4 and 7 before this goes out.
```

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | Stable identity. Survives everything. |
| `key` | `PROJ-42` | Human-facing. Issued once, never reused. |
| `project` | `PROJ` | Must match the key prefix. |
| `type` | enum | `epic` `story` `task` `bug` `subtask` |
| `summary` | string ≤255 | Jira's name for the title. |
| `status` | enum | `todo` `in_progress` `in_review` `blocked` `done` `disregard` |
| `priority` | enum | `highest` `high` `medium` `low` `lowest` |
| `parent` | key | Epic link, or parent task for a subtask. |
| `category` | string | Your grouping. Becomes a label or custom field on push. |
| `labels` | string[] | Passes straight through to Jira. |
| `components` | string[] | Passes straight through to Jira. |
| `assignee` | string | Who is doing it. Pushed to Jira's `assignee`. |
| `reporter` | string | Who asked for it. Filtered case-insensitively, unlike `assignee` — spellings of one person fold together, so the app's reporter menu and `listItems` agree. **Not pushed** — `buildPushPlan` maps `assignee` only, and `pushableFields` ignores this, so editing it does not count as drift. |
| `startDate` / `dueDate` | `YYYY-MM-DD` | `dueDate` is standard in Jira; `startDate` is a custom field. **`startDate` is written by the app** when an item enters `in_progress` — see below. |
| `estimate` | number | Story points or hours — `jira-map.yaml` decides which. |
| `cadence` | enum | `daily` `weekly` `monthly` `quarterly` `none`. **Local only.** |
| `completions` | `YYYY-MM-DD`[] | Dates this recurring item was ticked off, sorted. **Local only.** See below. |
| `rank` | int | Manual sort position within the project. **Local only.** See below. |
| `links` | Link[] | See below. |
| `attachments` | Attachment[] | Paths relative to the vault root, always with forward slashes. |
| `comments` | Comment[] | Append-only running log. |
| `sync` | Sync | Jira relationship. See below. |
| `created` / `updated` | ISO 8601 | UTC with offset. |

Empty optional fields are omitted from the file entirely rather than written as
`null`, which keeps the files readable and the diffs small.

### Links

The mechanism for associating arbitrary content with an item.

| `type` | `target` is | Behaviour |
|---|---|---|
| `url` | a web address; also the right type for a cloud share link (OneDrive, SharePoint, Google Drive, Dropbox) | Passed through to Jira as a real link |
| `file` | absolute path | File stays where it is; the vault stores a pointer |
| `folder` | absolute path | Same, for directories |
| `item` | another item key | Validated; produces a backlink on the other item |
| `outlook` | deep link or entry id | Preserved as text; Jira gets it in the description |
| `note` | free text | Escape hatch |

`file` links versus attachments is a real decision, not a duplicate feature.
Attaching with `copy: true` brings the file into `attachments/<key>/` so it is
versioned with the item; `copy: false` records a `file` link instead. Copy small
documents you want kept alongside the task. Point at anything large, anything
living on a network share, or anything inside a synced cloud folder (OneDrive,
Dropbox, Google Drive) — copying a synced file makes a second copy that
immediately begins diverging from the one other people are editing.

Attachment paths are stored POSIX-style — `attachments/ACME-2/spec.pdf` — even
when written on Windows, so a vault stays readable wherever it is opened. Use
`Vault.resolveAttachment()` to turn one back into a native absolute path; it
accepts either separator, so vaults written by older builds still resolve.

Share URLs with `?e=`, `?d=`, or `guestaccess.aspx` are capability URLs —
possession is permission, subject to the share's audience — and a vault with
`--git` on and a remote commits them. Worth knowing before recording one, not a
reason to avoid `url` links.

### Ordering

There are two orders, and they answer different questions.

**Work order** is derived — unfinished first, then due date, then priority, then
key. It answers "what should I look at next", so it is right for a backlog and is
the default for `listItems`.

**Rank order** is manual: whatever you dragged. `rank` is a sparse integer, gaps
of ~1000, so moving one card rewrites one file. Items without a rank sort after
ranked ones in work order, which puts a newly created item at the end of its
column rather than in the middle. Pass `sort: "rank"` to get it.

Projects carry a `rank` of their own, for the order the project list is shown
in. `listProjects()` returns manual order where one has been set and
alphabetical by key otherwise, so a vault where nothing has been dragged reads
exactly as it did before ranks existed, and a newly created project appears at
the end rather than in the middle of a hand-arranged list. Set it with
`Vault.moveProject(key, { after, before })`.

Three operations sound similar and are not:

| | |
|---|---|
| `moveItem` | Reorder an item within its project |
| `moveProject` | Reorder the project list itself |
| `moveItemsToProject` | Move work from one project into another, re-keying it |

Item ranks are per project. Set them with `Vault.moveItem(key, { after, before })`
rather than by patching `rank` directly — it derives whichever neighbour you
leave out, so `{ before: "ACME-7" }` means *immediately* before ACME-7, and it
respaces the project when a gap closes. Sparse integers rather than fractional
string keys: a respace is a few hundred instant writes, and the numbers stay
hand-editable.

## Deletion

`deleteItem` moves the file to `.trash/<key>-<timestamp>.md`, taking any
`attachments/<key>/` folder with it. It does not unlink anything.

This is deliberately independent of git. `commit()` is non-fatal by design, so a
vault that was never `git init`ed accepts every write and keeps no history at
all — recovery that depends on it would be recovery that quietly is not there.
A trashed file is on disk either way, and `restoreItem` puts it back. Use
`gitStatus()` to check whether history is actually accruing; it reports the repo
the vault commits into and whether that repo ignores the vault, because being
*inside* a repo is not the same as being tracked by it.

Deleting refuses to orphan children unless `cascade` is passed — a dangling
parent is invisible in every view and only surfaces when `doctor` runs. Items
that linked to the deleted one come back in `danglingBacklinks` rather than
being edited behind your back.

Keys are never recycled: `.counters.json` holds the high-water mark, so trashing
`ACME-7` does not free the number even while `items/` no longer contains it.

`deleteProject` refuses while the project still holds items. With `cascade` it
trashes them alongside, but as separate entries, so a project can be restored
without everything that was once in it.

## Hiding a project

`hideProject(key)` / `unhideProject(key)` are the not-deleting option: a project
that is finished with, out of the desktop app's sidebar, with nothing moved and
nothing removed. It is stored as `status: "archived"` — the fourth value in the
project status enum, which nothing else reads — so there is no extra field and
the state round-trips through `vault project set` and the MCP project tools like
any other.

Two things follow from that, both deliberate:

- **`listProjects()` stays unfiltered.** Filtering there would take hidden
  projects out of the CLI and the MCP server too, and hiding is a decision about
  one window, not about what the vault will admit exists. The desktop app drops
  them from its sidebar, and from the items, agenda, palette, and create dialog
  along with them. `vault projects` marks them `[hidden]` instead.
- **`updateProject` refuses to set `archived`.** Hiding refuses while the
  project still holds items outside `DONE_STATUSES`, and naming those items is
  the whole value of the refusal. Left reachable from the generic setter, the
  rule would hold on one path and be bypassable from the other two.

Unhiding restores `active`. A project that was `on_hold` or `complete` before
being hidden does not come back as either, because `status` is the only field
that held that and hiding overwrote it.

## Re-keying

Two operations change item keys, and both go through the same primitive because
both have to fix the same five things: the item's own `key` and `project`, its
filename, its attachment folder plus the paths recorded inside it, and every
`parent` and `item` link elsewhere in the vault — including from other projects.

**`renameProject(old, new)`** re-keys the whole project, preserving numbers:
`ACME-42` becomes `NEW-42`. The counter moves across, so numbers are not
reissued under the new key either.

**`moveItemsToProject(key, target)`** moves an item and its subtree into another
project, issuing fresh keys there, the way Jira's Move does — a key belongs to a
project, so `ACME-5` cannot stay `ACME-5` in `OPS`. If the moved item's parent
stays behind, the link is dropped and reported rather than left pointing across
projects. A subtask cannot lose its parent, so moving one requires naming a new
parent in the target.

Both preserve every `id`, which is the point of having one: identity survives
even though the human-facing key does not. `sync.jiraKey` is left alone, because
that key is Jira's. Nothing outside the vault gets updated — an email or a Jira
issue that quoted the old key still quotes it, so both operations are explicit
rather than a side effect of an edit.

## The agenda

`agenda(scope)` returns up to three sections, each tagged with `kind`:

| `kind` | |
|---|---|
| `overdue` | Past its due date and still open. First when present. |
| `due` | Has a due date inside the window. |
| `recurring` | No due date in the window, but its cadence comes round inside it. |

`due` and `recurring` are separate because recurring work has no deadline;
merging them reads as though the recurring items were also due. Every item lands
in exactly one section — something due last Tuesday is both inside this week's
window and overdue, and `overdue` claims it — so the sections can be totalled
without double-counting.

`recurring` leaves out anything already ticked for the period in question, so it
lists what is still owed rather than everything carrying a cadence. See below.

## Recurring work

A cadence is a schedule, not a deadline, and completing one turn of it is not the
same as finishing the item. `done` and `disregard` retire an item permanently —
right when you drop a habit, wrong when you perform one — so recurring work is
completed with a **tick** instead:

```yaml
cadence: daily
completions:
  - 2026-07-26
  - 2026-07-27
  - 2026-07-28
```

`tickItem(key, on)` appends a date and `untickItem(key, on)` removes one. Neither
touches `status`: a daily task sits in `todo` forever and accumulates
completions. Ticking the same date twice is a no-op rather than an error.

The record lives in the item file because git here is optional and non-fatal by
design (see **Deletion** above) — a vault that was never `git init`ed still keeps
a full completion history. When git *is* on, the commit
message names the completion (`Complete OPS-1 (daily 2026-07-28)`) rather than
the generic `Update OPS-1`, so the history is greppable too.

### When a tick hides an item

Each cadence has a **period** containing the reference date — a day, a
Monday-to-Sunday week, a calendar month, a calendar quarter. An item drops out of
an agenda window when it is ticked for its current period *and* that period runs
to the end of the window, i.e. nothing more is owed before the window closes:

| Item | `today` | `week` |
|---|---|---|
| `daily`, ticked today | hidden | **shown** — it comes round again tomorrow |
| `weekly`, ticked Monday | hidden | hidden |
| `monthly`, ticked | hidden | hidden |

The simpler rule — "ticked means hide it" — is wrong in a way that is easy to
miss: doing today's daily task would empty the weekly agenda of it too.

`completions` is not in `pushableFields`, so a tick never marks a pushed item as
drifted against Jira.

The period arithmetic lives in `recurrence.ts`, which imports nothing, so the
desktop renderer shares it rather than reimplementing it — the same reason
`constants.ts` and `description.ts` are structured that way.

### Sync

```yaml
sync:
  jiraKey: ENG-1043
  jiraId: "10234"
  lastPushedAt: 2026-07-20T14:02:11.000Z
  contentHash: 4f2a91b0c7d3e815
  state: pushed        # never | pending | pushed | drifted
```

`key` and `sync.jiraKey` are deliberately separate fields. An item can live in
the vault forever without a Jira counterpart, and the local key never changes
because Jira assigned a different one.

`contentHash` covers only the fields that actually get pushed. Changing
`cadence` — which Jira never sees — will not flip an item to `drifted`.
Changing the summary will. So will moving an item into `in_progress` for the
first time, because that writes `startDate`, which is pushed — a status change
on its own is not drift, but the date it stamps is.

## Rules the vault enforces

**Hierarchy.** Epics take no parent. Stories, tasks, and bugs may only be
parented to an epic. Subtasks must have a parent, and it must be a story, task,
or bug. Cycles are rejected on re-parenting.

**Transitions.**

| From | Can move to |
|---|---|
| `todo` | `in_progress` `blocked` `done` `disregard` |
| `in_progress` | `in_review` `blocked` `done` `todo` `disregard` |
| `in_review` | `in_progress` `done` `blocked` `disregard` |
| `blocked` | `todo` `in_progress` `disregard` |
| `done` | `todo` `in_progress` `disregard` |
| `disregard` | `todo` `in_progress` `done` |

`todo → in_review` is rejected on purpose: something that was never in progress
should not appear in a "what got worked on this week" rollup. Loosen this in
`TRANSITIONS` if it annoys you.

**Starting something dates it.** Any move into `in_progress` sets `startDate` to
today, unless the item already has one. Nobody types that date on the day it
happens, so without this the field is empty on exactly the items being worked.
It applies to every route into the status — the board, the detail panel,
`vault set --status`, both MCP write tools — because the rule lives in
`updateItem`, which all of them go through; an item created directly into
`in_progress` gets it too. Three things it deliberately does not do. It never
overwrites an existing date. It is skipped, not clamped, when today would fall
after `dueDate`, since `dueDate` cannot precede `startDate` and a convenience
must never be why a drag fails — so an item already overdue when you start it
gets nothing. And it cannot tell a field you cleared from one that was never
set, so clearing `startDate` and later passing back through `in_progress`
refills it.

**The two closed states.** `done` and `disregard` are both endings, and
`DONE_STATUSES` holds both — so the `open` filter, the agenda, and the work-order
sort treat them identically. They differ in what they claim: `done` says the work
happened, `disregard` says it was decided against. Keeping them apart is what
lets a rollup say what was achieved without counting what was dropped, and it is
why they get separate board columns and separate Jira transitions.

`disregard` is reachable from every other status, including `blocked` and `done`.
That is looser than `done`'s own row on purpose: the rule those refusals protect
is that nothing may claim work it did not do, and deciding *not* to do something
makes no such claim. Blocked work is the likeliest candidate for it, so routing
it back through `todo` first would be friction with nothing behind it.

**Keys.** Allocated as `max(stored counter, highest key on disk) + 1`. Deleting
`ACME-2` does not free up the number, because by then it may have been quoted in
an email or a Jira issue.

**Dates.** `dueDate` cannot precede `startDate`.

## Concurrency

Three things may write to this vault: the app, the in-app assistant, and an
external Claude. The defences are deliberately simple:

- **Atomic writes.** Every write goes to a temp file in the same directory and
  is then renamed. A reader sees the old file or the new one, never a partial.
- **Reload before write.** The MCP server reloads the vault before every
  mutation, so it never writes back stale state it read minutes ago.
- **Git.** With `--git`, every write is committed. Last-write-wins is fine when
  every previous version is one `git revert` away.

Deliberately absent: lockfiles. For a single-user tracker they cost more in
stale-lock recovery than they save.

## Extending it

Add the field to `ItemFrontmatterSchema` and to `FRONTMATTER_ORDER` in
`src/schema.ts`. Unknown fields already on disk are preserved on write, so an
older build of the app will not destroy data written by a newer one.
