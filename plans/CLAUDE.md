# Everything in this folder is a plan, not a description

Files here are work in progress: designs that have been thought through and
approved, but not yet built. They are staging between an idea and the
implementation.

**Where a plan and the code disagree, the code is right.** A plan may describe
something that was never built, or was built differently once contact with the
real files changed the design. Read these for intent and reasoning; read the
source for what is true.

## Labelling

Every file here carries a status line directly under its `#` heading:

```markdown
> **Status: plan — not yet implemented.**
```

It goes in the file rather than being implied by the folder because a plan gets
read out of context — pasted into a chat, opened on its own, quoted back later —
and the folder name does not travel with the text.

## Lifecycle

A plan here has exactly one ending. When it is implemented:

1. **Write the substance into the root `PLAN.md`** — the decisions made, what
   was actually built, and where reality diverged from what was planned. Match
   that document's voice: prose explaining *why* a call was made, not a
   changelog of *what* changed. `PLAN.md` opens by describing itself as "the log
   of what was built and why each call was made", and that is the standard to
   meet.
2. **Then delete the file from this folder.**

In that order. Deleting first loses the reasoning, which is the part worth
keeping — the diff already records what changed, and only the prose records why.

## This folder is gitignored

Nothing here survives a fresh clone or reaches another machine. That is
deliberate: an in-flight plan is local scratch, and the repo root should not
accumulate documents that read as if they describe the codebase.

The consequence is that `PLAN.md` is the durable record and this is not. A plan
that is finished but never folded into `PLAN.md` is simply lost.

## Where the other documents fit

| Document | Holds |
|---|---|
| `IDEAS.md` | Not yet scheduled. Ideas are promoted out of it. |
| `plans/PLAN-*.md` | Approved, in flight. This folder. |
| `PLAN.md` | Built, with the reasoning. The durable record. |
| `PLAN-LINKS.md` | A design large enough to have its own document. |
