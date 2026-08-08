---
name: vault-capture
description: Create work in the todo-vault — a task, bug, story, epic, subtask, or a new project — from a sentence, a note, an email, or a brain dump of several things at once. Fills in the fields that make an item findable later (project, type, category, labels, parent, due date, reporter) instead of leaving a bare summary, reuses the vault's existing category and label vocabulary, and shows the draft for confirmation before writing. Use whenever the user says "add a task", "I need to…", "remind me to…", "log a bug", "new project", "capture this", or pastes something that should become work.
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

## 2. Ask first, but only when the draft truly can't be built

Three cases, and only these three:

- **No project exists at all, or none plausibly fits.** Don't invent one — see
  `references/fields.md` on new projects.
- **Two projects fit equally well.** A coin-flip lands the item on the wrong
  board and it stays there; ask which.
- **The hierarchy the note implies is illegal** — e.g. it sounds like a
  subtask of an epic, which `SCHEMA.md`'s hierarchy rules don't allow. Ask
  which legal reading is meant.

Everything else — type, priority, category, labels, parent, dates, reporter —
goes into the draft, not into a question. See `references/fields.md` for how
each field gets inferred, left alone, or deliberately never guessed, and for
the completeness bar per item type.

## 3. Watch for two things a summary alone will miss

- **A person named in the note is a `reporter`**, not a clause in the
  description — a name left in prose can't be filtered or read back.
- **A URL, file path, or email thread mentioned becomes a link** via
  `vault_link_item`, not prose. Only a link reaches the detail panel's link
  rows and the Jira push's link handling. Nothing else prompts you to look for
  one at the moment you're drafting a summary, so make it a habit here.

If a path being linked or attached sits under OneDrive, SharePoint, Google
Drive, or Dropbox, attach with `copy: false` — the server instructions cover
why; this is just the reminder to apply it at capture time.

## 4. Several things at once

A brain dump isn't one task with run-on sentences. Split it when the note
contains genuinely separate deliverables — propose the split, the user
collapses it in one word if it's wrong. At four or more related items,
**propose an epic to hold them**, as a suggestion, not a default: an epic
invented over three tasks is bureaucracy. Write the whole batch after one
confirmation, not one question per item.

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
