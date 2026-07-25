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
├── jira-map.yaml            how this vault maps onto a Jira instance
└── .counters.json           highest key issued per project
```

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
| `links` | Link[] | See below. |
| `attachments` | Attachment[] | Paths relative to the vault root. |
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
