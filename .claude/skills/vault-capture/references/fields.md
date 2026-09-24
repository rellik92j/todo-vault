# Field-by-field reference

Four classes of field. Which class a field falls in matters more than any
single rule about it — it's the difference between drafting confidently and
stalling on a question the user didn't need asked.

The middle class is the one to read closely. `assignee` and `startDate` are
neither free guesses nor forbidden: they're real fields this vault uses, and
both carry a specific cost when wrong, so each has an **evidence floor** —
draft it when the floor is met, leave it off and say so when it isn't.

## Inferred — assume, mark it in the draft, don't ask

| Field | How |
|---|---|
| `type` | "broken", "fails", "wrong", "regression" → `bug`. "part of", "step in" → `subtask`. Something that contains other work → `epic`. Otherwise `task`. |
| `priority` | "blocking", "urgent", "asap" → `highest`/`high`. "when there's time", "nice to have" → `low`/`lowest`. Default `medium`. |
| `category` | **Reuse.** List what's already in use in this project first (from `vault_list_items`); coin a new one only when nothing fits, and say so explicitly in the draft — a new category is a decision, not a detail. |
| `labels` | Same rule, same vocabulary — reuse before inventing. |
| `parent` | When the note names it, or the project has exactly one open epic the work plainly belongs to. |
| `dueDate` | Always propose one — see *Dates* below. Resolve relative phrases ("Friday", "next week") against today's date. Never land in the past. |
| `cadence` | "every morning", "each week", "quarterly" → `daily`/`weekly`/`monthly`/`quarterly`. |
| `reporter` | Only when a person is named **as the asker** — "Priya asked for", "requested by Sam". Not for a person merely mentioned. See *People*. |
| `description` | Only from what the note actually said — no invented detail, no padding to look thorough. |

`assignee` and `startDate` are drafted too, but only against the floors in the
next section — they are not free inferences.

## Held to an evidence floor — draft it when the floor is met, say so when not

### People

Every distinct `assignee` and `reporter` already in the vault is a roster, and
`vault_list_items` is how you get it. Both fields are matched
case-insensitively (`SCHEMA.md`), so spellings of one person fold together —
which is exactly why a *new* spelling doesn't fold and quietly becomes a
second person.

A name in a note is one of four things, and only two of them are fields:

| The note says | Field |
|---|---|
| "Priya asked for", "per Dan", "Mei flagged" | `reporter` |
| "Ravi's picking this up", "assign to Ravi" | `assignee` |
| "call Renee", "chase Legal", "ask Sam whether" | **neither** — object of the task, stays in the summary |
| the user's own request, no one named | **neither** — `reporter` empty is the ordinary case, not a gap |

Resolving a half-given name: a bare first name that matches **exactly one**
roster entry resolves to that entry, marked in the draft ("Renee →
Renee Fitzgerald ← the only Renee in the vault"). Two matches, or none, and
the name goes in as written only if it's a `reporter`; for `assignee` it does
not go in at all. An invented `assignee` assigns work to someone who never
agreed to it, and it's the one of the two that Jira actually receives — a
guess travels, a wrong reporter merely misfiles.

**Assignee with no name in the note.** Propose one only when the project's own
history is unambiguous — every open item in it carries the same assignee.
Then draft that value marked as convention ("← every open OPS item"), which is
a suggestion the user rejects with one word. A project with mixed assignees,
or fewer than three items to judge from, gives no signal: leave it empty and
say the draft left it empty. Never spread an assignee across a batch on the
strength of one item elsewhere in the vault.

### Dates

**Propose a `dueDate` on every item.** "No deadline" is a legitimate answer but
a poor default — an item with no date and no cadence never reaches the agenda,
which is the whole failure this skill exists to prevent. When the note gives no
date, derive one from the shape of the work and mark it as yours:

| Shape | Reasonable proposal |
|---|---|
| A call, a reply, a single message | next working day |
| Desk work of an hour or two | end of the current week |
| Something waiting on another item in the batch | the day after that item's due date |
| An epic | the end of the period the work plainly belongs to — quarter end, month end |
| Genuinely open-ended | none, stated in the draft as "no deadline" so it's a visible decision |

**`startDate` is a suggestion, not a stamp.** The app writes it automatically
on the first transition into `in_progress` (`vault_update_item` /
`vault_transition_item`), so anything you set will be overwritten the moment
work actually begins — which makes a drafted `startDate` a plan, and a cheap
one to be wrong about. Propose it when:

- the note says when work starts ("not before the 20th", "after the audit");
- the item is second in a chain within the batch, where the start is what
  records the dependency the split just created; or
- the due date is far enough out that the item would otherwise sit invisible
  until it's late.

Skip it when the project's existing items don't use `startDate` at all, and
never set one later than the due date.

## Left to the vault — don't set these yourself

- **`status`.** Everything starts `todo` unless the note says the work is
  already underway.
- **`rank`.** That's for deliberate reordering via `vault_move_item`, not
  something to guess at on creation.

## Never guessed — ask, or leave empty and say so

- **`estimate`.** Rarely used in this vault (3 of 15 items carry one at time of
  writing). Asking for a number the user doesn't think in is friction — leave
  it off unless one was given.
- **A new project.** Never create one to hold a single item without asking —
  it's a container that outlives whatever prompted it, and its prefix is
  stamped into every child key permanently. A missing **epic**, by contrast,
  is proposed rather than asked about: see `SKILL.md` §4.

## The completeness bar

**Every item needs:** project, type, a summary in the imperative naming the
outcome (not the activity), priority, category, and one of {`dueDate`,
`cadence`, an explicit "no deadline" noted in the draft}.

| Type | Also needs |
|---|---|
| `epic` | A description saying what *done* means — not a task list, a finish line. A `dueDate`. Never a parent (`SCHEMA.md` hierarchy rules). |
| `story` / `task` / `bug` | A parent, when an epic covers the area. A `dueDate` or a `cadence`. |
| `bug` | A description with what is actually wrong, not just the symptom repeated from the title. |
| `subtask` | A parent — required, and must be a story, task, or bug (`SCHEMA.md`). Category is optional; it inherits context from the parent. |
| recurring (any `cadence` ≠ `none`) | `cadence` set and `dueDate` usually **absent** — the agenda reports `due` and `recurring` as separate sections precisely because recurring work has no deadline, and a due date on one makes it read as though it does. A cadence item that also has a genuine hard deadline (a weekly rollup with a fixed Friday) is a real exception, not a mistake — just don't default to it. |

Three rules that fire on the *content* of a note rather than on a single field,
easy to miss because nothing forces you to look for them:

- **A person named goes in a field, not in the description** — which field is
  the *People* table above, and "neither" is one of its answers. A name left
  in prose can't be filtered on.
- **A URL, file path, or email thread mentioned becomes a link**, via
  `vault_link_item`, not prose in the body.
- **A conjunction joining two outcomes is two items.** The test and the
  counter-examples are in `SKILL.md` §4; the reason it belongs here too is
  that the completeness bar is per item, and a summary carrying two verbs
  can't satisfy it — one of the two outcomes ends up with no date, no
  category, and no way to be marked done on its own.
