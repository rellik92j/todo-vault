---
name: vault-update
description: Change something that already exists in the todo-vault — due date, priority, status, labels, parent, project — or remove a link, or delete it. Applies small named edits straight away and confirms first for anything that re-keys, deletes, retires a recurring item, or was inferred rather than asked for. Use whenever the user says "mark X done", "push it to Friday", "that's blocked", "bump the priority", "I did my daily…", "move it to OPS", "we're not doing that", "wrong link", "delete", or names an existing item key like ACME-4.
---

# Update work in the vault

Every write tool looks identical from the outside — `vault_update_item`
changing a due date and `vault_move_item_to_project` re-keying a subtree are
both one call. This skill is what tells them apart, and what decides whether
to just do it or to ask first.

## 1. Read before you write

Call `vault_get_item` before any edit that depends on current state: every
`labels` change (see trap 1 below), every status move (to know what's legal
from here), and anything touching an item that might carry a `cadence` or a
`jiraKey`.

## 2. Two axes decide whether to confirm

Not a list of fields to memorize — a list drifts the moment someone asks for
a case it doesn't cover. Two questions generate the same answer every time:

**Who chose it?** A named change is an instruction — *"mark ACME-4 done"* has
already been decided, and asking "shall I mark it done?" is theatre. An
inferred change is a guess — *"I think we're finished with the SOW"* → `done`
is you proposing something, and a proposal gets confirmed.

**What does it cost to be wrong?** Some writes can't be walked back through
this server at all, and some reach further than the item that was named.

|  | Named by the user | Inferred by you |
|---|---|---|
| **Cheap to undo** | Do it. Report in one line. | Confirm. |
| **Hard to undo, or wider than the named item** | Confirm. | Confirm, and say what it touches. |

`references/significance.md` has the full ladder applying these two axes to
every write tool, plus the twelve traps — cases where the obvious call is
wrong — with what each one costs if missed. Read it before an edit that isn't
a straightforward named field change.

## 3. The traps, in one line each

Full detail and citations are in `references/significance.md`. The one-line
version, because recognizing the moment matters more than the rule:

1. "Add a label" is never one call — `labels` replaces the whole list.
2. Comments and copied attachments (`copy: true`) have no undo anywhere in
   the core. Links and `copy: false` attachments do (`vault_unlink_item`).
3. `todo → in_review` is illegal on purpose — route through `in_progress`
   instead of surfacing the error.
4. `in_progress` stamps `startDate` unless the item already has one, or
   today is past `dueDate` — report whatever date actually comes back.
5. "I did my daily check" is `vault_tick_item`, not `done` — `done` retires
   a recurring item permanently.
6. `done` and `disregard` are not interchangeable — one claims the work
   happened, the other says it won't. Pick the one the user actually said.
7. `vault_move_item_to_project` re-keys the whole subtree; keys are never
   reissued.
8. `vault_rename_project` re-keys every item in the project.
9. Editing an item carrying a `jiraKey` doesn't get refused — it gets
   reported as drift.
10. `components` is in the schema but not exposed by any MCP tool — say so
    if asked, don't smuggle the value into `labels`.
11. A path under a synced cloud folder (OneDrive, SharePoint, Google Drive,
    Dropbox) gets `copy: false`, not `copy: true`.
12. `dueDate` cannot precede `startDate`, and the hierarchy rules
    (`SCHEMA.md`) are absolute — enforced in code, not just advised here.

## 4. Report at the right size

**Trivial** — a named, cheap-to-undo change. One line, after the fact, no
question:

```
ACME-4 due 2026-07-25 → 2026-08-07
```

**Significant** — anything that earns a confirm. Say what it touches, what
it costs, then ask:

```
Move ACME-4 to OPS

  Re-keys ACME-4 and its subtask ACME-5 → OPS-6, OPS-7.
  The old keys are never reissued.
  Parent ACME-1 stays in ACME, so the epic link drops. Pass a
  parent in OPS to keep one.

Go ahead?
```

**Batch** — anything touching more than one item. The full list, because a
misparse multiplies across it:

```
Close 4 items as done:
  ACME-8  Choose the replacement warehouse
  LEG-1   Agree what happens to the archived dashboards
  OPS-3   Reconcile cloud spend against the forecast
  OPS-5   Chase the unanswered DPA question

OPS-3 and OPS-5 are still in_progress; the other two are already done
and will be no-ops. Confirm?
```
