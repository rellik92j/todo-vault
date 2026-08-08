# The confirmation ladder, in full

Applying the two axes from `SKILL.md` — who chose it, what it costs to be
wrong — to every write tool.

| Change | Default |
|---|---|
| `dueDate`, `startDate`, `priority`, `estimate`, `category`, `assignee`, `cadence` | Apply |
| `summary` reworded in the user's own words | Apply |
| `summary` rewritten by you | Confirm — show both |
| `description` added to | Apply |
| `description` replaced, where one already exists | Confirm — the old text isn't recoverable from here |
| `labels` | Apply — **after** a read-modify-write (trap 1) |
| `status` → `todo` / `in_progress` / `in_review` / `blocked` | Apply |
| `status` → `done` / `disregard` | Apply when named; confirm when inferred |
| `status` → `done` on an item **with a cadence** | Always confirm, and offer `vault_tick_item` instead (trap 5) |
| `tick` / untick | Apply |
| Link, or an attachment with `copy: false` | Apply — say what was added; `vault_unlink_item` takes it back |
| Comment, or an attachment with `copy: true` | Apply — say what was added, and mean it: neither has an inverse anywhere in the core (trap 2) |
| Reparent | Confirm |
| Move to another project | Confirm — re-keys the subtree (trap 7) |
| Rename a project key | Confirm — re-keys every item in it (trap 8) |
| Delete an item | Confirm. `cascade` always confirms and lists the children by name |
| Delete or hide a project | Confirm |
| Anything touching more than one item | Confirm as a batch, with the full list |
| Any edit to an item carrying a `jiraKey` | Apply, and report the drift (trap 9) |

## The twelve traps

Each one is a case where the rule is stated somewhere — in the tool's own
description, or in `SCHEMA.md` — but stating it doesn't help an agent that
has already chosen the call. What this skill adds is recognizing the moment
*before* the tool is reached for, not the rule itself.

1. **`labels` replaces the whole list.** `vault_update_item`'s own
   description says so in four words, easy to skim past, and the failure is
   silent: the item keeps the new label and quietly loses the old ones. "Add
   a label" is `vault_get_item` → append → `vault_update_item`, always, never
   one call.

2. **Comments and copied attachments cannot be removed through this server.**
   `vault_unlink_item` handles links, and a `copy: false` attachment degrades
   to a `file` link, so both of those are covered. What has no inverse
   anywhere in the core is a comment and a copied attachment's bytes
   (re-attaching the same filename overwrites them). Say what was added; the
   server's own reversibility bullet is the authority on how much care that
   deserves.

3. **`todo → in_review` is rejected on purpose** (`SCHEMA.md`, "Rules the
   vault enforces" — nothing jumps to `in_review` without having been worked
   on, so the "what got worked on this week" rollup stays honest). Route
   through `in_progress` rather than surfacing the error: two calls, one
   reported outcome.

4. **`in_progress` stamps `startDate` — except when it doesn't.** Skipped
   when the item already has one, and skipped when today is past `dueDate`,
   since `dueDate` cannot precede `startDate`. So an already-overdue item
   started today gets nothing. Report the date that actually came back in
   the response, never the one you assumed.

5. **`done` retires a recurring item permanently.** `vault_tick_item`'s own
   description says this plainly; it still needs catching at the moment the
   user says "I did my daily check", because that sentence sounds exactly
   like completion. The clearest case of the pattern above — the rule is
   stated, and it arrives one call too late if you haven't already recognized
   the sentence.

6. **`done` and `disregard` are not interchangeable.** One claims the work
   happened; the other says it was decided against. Keeping them apart is
   what lets a rollup report achievement without counting what was dropped.
   Pick the one the user actually said; don't disregard something on their
   behalf, and don't mark something done that was actually dropped.

7. **`vault_move_item_to_project` re-keys the whole subtree**, and keys are
   never reissued — by the time one is trashed it may already be quoted in
   an email or a Jira issue (`SCHEMA.md`, "Re-keying"). A subtask can't lose
   its parent, so moving one requires naming a new parent in the target. If
   the moved item's own parent stays behind, the epic link drops — say so.

8. **`vault_rename_project` re-keys every item in the project**, preserving
   item numbers (`ACME-42` → `NEW-42`) but not the prefix. Same reasoning as
   #7, larger blast radius.

9. **Editing an item with a `jiraKey` marks it drifted**, not refused.
   `contentHash` covers only the fields that get pushed, so not every edit
   drifts it — but summary, description, and a first move into
   `in_progress` (which stamps `startDate`, which is pushed) all do. Not a
   reason to refuse the edit; a reason to mention it, since someone
   downstream is reading the Jira copy.

10. **`components` exists in the schema but is not exposed by any MCP tool.**
    Say so if asked, rather than writing the value into `labels` and calling
    it done — that would silently misrepresent the field on any future Jira
    push.

11. **Attaching from a synced folder gets `copy: false`.** A path under
    OneDrive, `OneDrive - <Company>`, SharePoint, Dropbox, or a Google Drive
    letter, and the same for anything large or on a network share. Copying
    makes a second copy that immediately starts diverging from the one
    other people (or the sync client) keep editing. The server enforces
    this for OneDrive/SharePoint roots it can detect; apply it by hand for
    the rest, since detection is best-effort.

12. **`dueDate` cannot precede `startDate`**, and the hierarchy rules are
    absolute: epics take no parent; stories, tasks, and bugs parent only to
    an epic; a subtask's parent must be a story, task, or bug. Cycles are
    rejected on re-parenting. All enforced in code (`SCHEMA.md`, "Rules the
    vault enforces") — the tool call fails rather than corrupting state, but
    a confirmed plan that then fails reads as broken, so check the shape
    before proposing a reparent.
