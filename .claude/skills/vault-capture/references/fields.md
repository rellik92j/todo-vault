# Field-by-field reference

Three classes of field. Which class a field falls in matters more than any
single rule about it — it's the difference between drafting confidently and
stalling on a question the user didn't need asked.

## Inferred — assume, mark it in the draft, don't ask

| Field | How |
|---|---|
| `type` | "broken", "fails", "wrong", "regression" → `bug`. "part of", "step in" → `subtask`. Something that contains other work → `epic`. Otherwise `task`. |
| `priority` | "blocking", "urgent", "asap" → `highest`/`high`. "when there's time", "nice to have" → `low`/`lowest`. Default `medium`. |
| `category` | **Reuse.** List what's already in use in this project first (from `vault_list_items`); coin a new one only when nothing fits, and say so explicitly in the draft — a new category is a decision, not a detail. |
| `labels` | Same rule, same vocabulary — reuse before inventing. |
| `parent` | When the note names it, or the project has exactly one open epic the work plainly belongs to. |
| `dueDate` | Resolve relative phrases ("Friday", "next week") against today's date. Never land in the past. |
| `cadence` | "every morning", "each week", "quarterly" → `daily`/`weekly`/`monthly`/`quarterly`. |
| `reporter` | Only when a person is named **as the asker** — "Priya asked for", "requested by Sam". Not for a person merely mentioned. |
| `description` | Only from what the note actually said — no invented detail, no padding to look thorough. |

## Left to the vault — don't set these yourself

- **`startDate`.** `vault_update_item` / `vault_transition_item` stamp it
  automatically on the first move into `in_progress`, and that's the only
  moment it's reliably true. Set it by hand only when the note states when
  work actually *started*, as a fact separate from creation.
- **`status`.** Everything starts `todo` unless the note says the work is
  already underway.
- **`rank`.** That's for deliberate reordering via `vault_move_item`, not
  something to guess at on creation.

## Never guessed — ask, or leave empty and say so

- **`assignee`.** An invented name assigns work to someone who never agreed to
  it, and it's the field Jira actually receives — a guess travels.
- **`reporter` when no one is named.** Work the user raised themselves has no
  reporter. That's the ordinary case, not a gap to fill.
- **`estimate`.** Rarely used in this vault (3 of 15 items carry one at time of
  writing). Asking for a number the user doesn't think in is friction — leave
  it off unless one was given.
- **A new project.** Never create one to hold a single item without asking —
  it's a container that outlives whatever prompted it.

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

Two rules that fire on the *content* of a note rather than on a single field,
easy to miss because nothing forces you to look for them:

- **A person named is a `reporter`**, never a sentence buried in the
  description — the description can't be filtered on.
- **A URL, file path, or email thread mentioned becomes a link**, via
  `vault_link_item`, not prose in the body.
