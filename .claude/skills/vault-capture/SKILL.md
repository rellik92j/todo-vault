---
name: vault-capture
description: Create work in the todo-vault — a task, bug, story, epic, subtask, or a new project — from a sentence, a note, an email, or a brain dump of several things at once. Splits a request that names more than one deliverable into one item each, proposes the epic or project it was filed under when that container does not exist yet, fills in the fields that make an item findable later (project, type, category, labels, parent, start and due dates, reporter, assignee) instead of leaving a bare summary, reuses the vault's existing category, label, and people vocabulary, and shows the draft for confirmation before writing. Use whenever the user says "add a task", "I need to…", "remind me to…", "log a bug", "new project", "capture this", gives a half-specified ask like "task for epic X to do A and B", or pastes something that should become work.
---

# Capture work in the vault

An item with a summary and nothing else is technically valid and practically
useless: it never reaches the agenda (no due date, no cadence), never groups
into a board column (no category), and reads a week later as a note-to-self
whose context is gone. This skill exists to fill in the fields that make an
item findable later, without turning "add a task" into an interrogation.

The server's own instructions already cover the ground rules — read before you
write, what can be taken back, the synced-folder rule. This skill does not
repeat those. It owns one thing: turning a sentence into a complete draft.

## 1. Read before drafting

Call `vault_list_projects` once, and `vault_list_items` scoped to the project
you think this belongs to. That's the same context the in-app assistant
(`apps/desktop/src/main/claude.ts`) assembles before it drafts — the live
category and label vocabulary, and the candidate parent epic. Guessing at
either without this call is how a vault ends up with a second spelling of a
category that already exists.

Read four things out of that call, not one:

- the **category and label vocabulary** actually in use;
- the **open epics**, as candidate parents;
- the **people** — every distinct `assignee` and `reporter` value. This is the
  roster a half-given name gets resolved against, and the only source of names
  you may put in either field. `references/fields.md` sets the evidence floor.
- the **shape of the project's dates** — whether items here carry `startDate`,
  and how far out due dates usually sit. A vault that never uses `startDate`
  shouldn't start because you drafted one.

## 2. Ask first, but only when the draft truly can't be built

Three cases, and only these three:

- **No project exists at all, or none plausibly fits.** Don't invent one — see
  `references/fields.md` on new projects.
- **Two projects fit equally well.** A coin-flip lands the item on the wrong
  board and it stays there; ask which.
- **The hierarchy the note implies is illegal** — e.g. it sounds like a
  subtask of an epic, which `SCHEMA.md`'s hierarchy rules don't allow. Ask
  which legal reading is meant.

Everything else — type, priority, category, labels, parent, dates, reporter,
assignee — goes into the draft, not into a question. See
`references/fields.md` for how each field gets inferred, held to an evidence
floor, or deliberately never guessed, and for the completeness bar per item
type.

Note what is *not* on that list: a container the note names that doesn't exist
yet. "The epic for Emailgistics" is an instruction to file the work under a
container the user believes in, so the gap is a missing epic, not a missing
answer. Propose creating it in the same draft — see §4.

## 3. Watch for two things a summary alone will miss

- **A person named in the note belongs in a field**, not in a clause of the
  description — a name left in prose can't be filtered or read back. Which
  field depends on the grammar, and getting it backwards is the commonest way
  a capture goes wrong: the person who *asked* is the `reporter`, the person
  who will *do it* is the `assignee`, and the person the work is *aimed at* —
  "call Renee", "chase Legal" — is neither. That last one stays in the summary
  where it belongs, because it is the object of the task, not a party to it.
- **A URL, file path, or email thread mentioned becomes a link** via
  `vault_link_item`, not prose. Only a link reaches the detail panel's link
  rows and the Jira push's link handling. Nothing else prompts you to look for
  one at the moment you're drafting a summary, so make it a habit here.

If a path being linked or attached sits under OneDrive, SharePoint, Google
Drive, or Dropbox, attach with `copy: false` — the server instructions cover
why; this is just the reminder to apply it at capture time.

## 4. One ask is often more than one item

Splitting is not only for pasted brain dumps. It fires just as often on a
single sentence, because people compress a plan into one line and expect the
listener to unpack it: *"create a task for the Emailgistics epic to call Renee
and check stats against the logs"* is two deliverables, one container, and one
grammatical sentence.

### The test

Two clauses are two items when **either could be finished while the other is
not**. That usually shows up as a difference in one of:

| Signal | "Call Renee **and** check stats against the logs" |
|---|---|
| Different actor or counterparty | Renee vs. nobody — one is a conversation, one is desk work |
| Different artefact or evidence of done | a call happened vs. a discrepancy list exists |
| Different day, or one gates the other | the call may well need doing first |

One item, not two, when the second clause is the *manner*, the *acceptance
criterion*, or the *audience* of the first — "send the SOW **and** cc Legal",
"fix the import **so** it stops dropping rows". Those describe one finish
line. When it's genuinely borderline, split: two items merge back with a
sentence, whereas one item hiding two jobs is only discovered when half of it
is done and there's nowhere to record that.

The user's phrasing ("*a* task") is not evidence against splitting. It's how
the request was compressed, not a count.

### The container the note names

When the note files the work under an epic or project that doesn't exist —
"for the Emailgistics epic", "under the Q3 audit" — treat the gap as work to
propose, not a question to ask back. Draft the container **and** its children
together and confirm the whole thing once:

- **An epic** when it holds work inside a project that already exists. This is
  the usual reading and the cheap one — an epic is one item and re-parenting
  is a frontmatter edit.
- **A project** when the name is a whole workstream, client, or system that
  nothing in the vault covers, and you'd expect it to accumulate work for
  months. This one gets asked about rather than assumed: a project is a
  container that outlives whatever prompted it, and its key prefix is stamped
  into every child key forever.

If both readings are live, draft the epic and name the alternative in one
line — "say the word and I'll make Emailgistics a project instead". That costs
the user a word; guessing project costs them a re-key.

### Volume

At four or more related items with no container named, **propose an epic to
hold them**, as a suggestion, not a default: an epic invented over three tasks
is bureaucracy. Write the whole batch after one confirmation, never one
question per item.

## 5. Show the draft, then write

Resolve everything into a complete draft, mark what was inferred, and let one
reply correct all of it — inverting the usual "ask per missing field" pattern,
which produces an interrogation before a single task exists.

```
ACME · task · high                              ← "urgent"
Send the revised SOW to Legal

  category  Procurement                         ← matches ACME-4
  labels    vendor, legal                       ← both already in use
  parent    ACME-1 · Migrate reporting off…     ← the only epic in ACME
  due       2026-08-07 (Friday)                 ← "by Friday"
  reporter  Priya Raman                         ← "Priya asked for"

  Legal need sections 4 and 7 before it goes out.

Create it? Correct anything in the same breath and I'll redo it.
```

The `←` column carries the same honesty as `claude.ts`'s `notes` field, laid
out per field so a wrong guess is obvious at a glance rather than buried in a
sentence. Once confirmed, write it with `vault_create_item` (and
`vault_create_project`, `vault_link_item`, `vault_attach_file` as needed) and
report back the key(s) the vault assigned.

A batch keeps the same shape. Fields shared by every item are stated once at
the top so the per-item blocks stay readable, and a container being created
sits above the things it will hold — here, from *"create task for epic
emailgistics to call renee and check stats against logs"*, with today being
Wednesday 2026-08-12:

```
OPS · 1 new epic + 2 tasks               ← "and" joins two separate outcomes
shared: category Reporting · priority medium · assignee (none)
        ↑ matches OPS-2        ↑ nothing urgent said   ↑ OPS is split between
                                                         me and Ravi — no
                                                         convention to follow

NEW EPIC   Cut over Emailgistics reporting to verified figures
  due      2026-09-30                    ← quarter end; no date was given
  done when  the dashboard and the logs agree and the gap is explained
  ⚠ no epic or project called Emailgistics exists — this creates one epic in
    OPS. If it's really its own workstream, say so and it becomes a project.

  1  task   Call Renee about the Emailgistics figures
     start  2026-08-12 (today)  due 2026-08-13 (Thu)   ← a call, next slot
     ⚠ Renee is the person to call, so no assignee or reporter was set from
       her name, and she is not on the vault's roster.

  2  task   Reconcile Emailgistics stats against the logs
     start  2026-08-13  due 2026-08-14 (Fri)  ← after the call, which may move it
     labels  emailgistics                     ← new label, reused across both

Create all three? Correct anything in the same breath and I'll redo it.
```

Four things that example is doing deliberately, all of which a single-item
draft never has to face:

- the split is **justified in the header**, so disagreeing with it is one word
  ("just one task") rather than a re-read of the whole draft;
- an evidence floor that isn't met is shown as `(none)` **with the reason**,
  not silently omitted — "no convention to follow" is the one line that tells
  the user they can settle it now by naming someone;
- anything invented — the epic, a new label, a date nobody gave — is flagged
  with `⚠` rather than only `←`, because those are the ones worth the user's
  attention if they skim;
- the items are numbered, so a correction can name one ("2 is next week").

Write the batch in dependency order — container first, so children can carry
`parent` on creation rather than needing a follow-up `vault_update_item` — and
report the assigned keys together at the end.
