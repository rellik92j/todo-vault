# Future ideas

Unscheduled ideas that haven't earned a PLAN.md phase or a PLAN-*.md design doc
yet. When one is ready to build, promote it: either a new phase in PLAN.md, or
its own `PLAN-<name>.md` if it needs real design work first (see PLAN-LINKS.md
for the shape of one of those).

Newest at the top. No status tracking here — once something's picked up, its
entry moves out to wherever it's being built.

## A UI style guide, so the next screen matches the last one

`index.css` is one 1,683-line file in twenty sections, and it is two different
things stacked on top of each other. The colour layer is a real system: `:root`
tokens for surfaces, text, priorities and statuses, several carrying the reason
they are what they are — `--disregard` is warm on purpose, because at a 7px dot
hue is most of what separates it from `--todo`'s cool grey. That thinking is
worth writing down where someone designing the next screen will find it, rather
than leaving it discoverable only by reading the stylesheet top to bottom.

The spacing and type layer is not a system at all. Padding and gap values run
5px, 6px, 7px, 8px, 9px, 10px, 11px, 12px, 14px with no rule for picking one, so
every new component is a fresh guess and near-misses accumulate — the kind of
drift nobody notices in isolation and everybody feels in aggregate. A short
scale, even four or five steps, would make the choice mechanical. About a dozen
hex values also sit outside `:root`; each is defensible alone, but they are
where a future theme change would silently miss.

Which raises the decision this doc would have to settle: `color-scheme: dark` is
hardcoded and every token is a literal colour, so there is currently no light
mode and no seam to add one. Deciding *no* is fine and cheap. Deciding *yes*
later is much more expensive than deciding it now, because it determines whether
tokens want semantic names rather than literal ones.

Probably its own `PLAN-STYLE.md` rather than a phase — it is design work with a
decision in it, not a task list.

## `doctor` should check that attachments resolve

`doctor` validates dangling parents, item links, and absolute `file` links
(`cli.ts`), but never checks that an item's `attachments` entries exist on disk.
A missing attachment is silent — the item still lists `attachments/ACME-2/spec.pdf`
in frontmatter and nothing reports that the file is gone.

Today git makes that mostly theoretical, since `attachments/` is tracked along
with everything else. It stops being theoretical the moment a vault is copied
without hidden files, restored from a partial backup, or opened on a machine
where auto-commit was never healthy — all cases `gitStatus()` already exists to
warn about. The check is a few lines next to the existing `link.type === "file"`
branch, using `resolveAttachment()` to get the native path.

Came up while deciding whether to gitignore `attachments/`. Decided not to — the
whole point of `copy: true` is that the file is versioned with the item, and
`copy: false` is already the escape hatch for anything large. But that ruling
leans on git being healthy, and this check is what makes the failure visible
instead of silent.
