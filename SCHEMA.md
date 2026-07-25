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
├── .trash/                  deleted items, recoverable
│   └── ACME-9-2026-07-25T13-06-03-925Z.md
├── jira-map.yaml            how this vault maps onto a Jira instance
└── .counters.json           highest key issued per project
```

`load()` reads `items/` and `projects/` and nothing else, so anything in
`.trash/` is invisible to every query without needing a flag to exclude it.

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
| `status` | enum | `todo` `in_progress` `in_review` `blocked` `done` |
| `priority` | enum | `highest` `high` `medium` `low` `lowest` |
| `parent` | key | Epic link, or parent task for a subtask. |
| `category` | string | Your grouping. Becomes a label or custom field on push. |
| `labels` | string[] | Passes straight through to Jira. |
| `components` | string[] | Passes straight through to Jira. |
| `assignee` / `reporter` | string | |
| `startDate` / `dueDate` | `YYYY-MM-DD` | `dueDate` is standard in Jira; `startDate` is a custom field. |
| `estimate` | number | Story points or hours — `jira-map.yaml` decides which. |
| `cadence` | enum | `daily` `weekly` `monthly` `quarterly` `none`. **Local only.** |
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
| `url` | a web address | Passed through to Jira as a real link |
| `file` | absolute path | File stays where it is; the vault stores a pointer |
| `folder` | absolute path | Same, for directories |
| `item` | another item key | Validated; produces a backlink on the other item |
| `outlook` | deep link or entry id | Preserved as text; Jira gets it in the description |
| `note` | free text | Escape hatch |

`file` links versus attachments is a real decision, not a duplicate feature.
Attaching with `copy: true` brings the file into `attachments/<key>/` so it is
versioned with the item; `copy: false` records a `file` link instead. Copy small
documents you want kept alongside the task. Point at anything large or anything
living on a network share.

Attachment paths are stored POSIX-style — `attachments/ACME-2/spec.pdf` — even
when written on Windows, so a vault stays readable wherever it is opened. Use
`Vault.resolveAttachment()` to turn one back into a native absolute path; it
accepts either separator, so vaults written by older builds still resolve.

### Ordering

There are two orders, and they answer different questions.

**Work order** is derived — unfinished first, then due date, then priority, then
key. It answers "what should I look at next", so it is right for a backlog and is
the default for `listItems`.

**Rank order** is manual: whatever you dragged. `rank` is a sparse integer, gaps
of ~1000, so moving one card rewrites one file. Items without a rank sort after
ranked ones in work order, which puts a newly created item at the end of its
column rather than in the middle. Pass `sort: "rank"` to get it.

Ranks are per project. Set them with `Vault.moveItem(key, { after, before })`
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
Changing the summary will.

## Rules the vault enforces

**Hierarchy.** Epics take no parent. Stories, tasks, and bugs may only be
parented to an epic. Subtasks must have a parent, and it must be a story, task,
or bug. Cycles are rejected on re-parenting.

**Transitions.**

| From | Can move to |
|---|---|
| `todo` | `in_progress` `blocked` `done` |
| `in_progress` | `in_review` `blocked` `done` `todo` |
| `in_review` | `in_progress` `done` `blocked` |
| `blocked` | `todo` `in_progress` |
| `done` | `todo` `in_progress` |

`todo → in_review` is rejected on purpose: something that was never in progress
should not appear in a "what got worked on this week" rollup. Loosen this in
`TRANSITIONS` if it annoys you.

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
