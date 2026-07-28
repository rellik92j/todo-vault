# Future ideas

Unscheduled ideas that haven't earned a PLAN.md phase or a PLAN-*.md design doc
yet. When one is ready to build, promote it: either a new phase in PLAN.md, or
its own `PLAN-<name>.md` if it needs real design work first (see PLAN-LINKS.md
for the shape of one of those).

Newest at the top. No status tracking here — once something's picked up, its
entry moves out to wherever it's being built.

## Collapsing a subtree in the backlog

`backlogOrder()` already does the hard half. It walks parents depth-first into a
flat `Array<{ item, depth }>`, which `BacklogTable` renders one row each from,
indenting by `"　".repeat(depth)`. Collapsing is not walking into a subtree —
a few lines inside `walk()`, given a set of collapsed keys.

What needs deciding is where that set lives, and the answer is not
`BacklogTable`. `App.tsx` calls `backlogOrder(filtered)` a second time to build
`orderedKeys`, the list `j`/`k` step through, and the comment above it already
states the rule: a cursor that steps through a different order than the eye sees
is worse than no cursor at all. A table that hid rows privately would turn every
collapsed subtree into a stretch of the keyboard walk where the highlight is off
screen. So the collapsed set is view state in `App.tsx` beside the filters,
passed into both calls — the same shape as `status` or `openOnly`. Hold keys,
not row indices, since the array is re-derived from a new snapshot on every
write.

One rule worth writing down before it gets improvised: collapse hides the
children of a *visible* parent, and only that. `backlogOrder` already promotes a
child to a root when its parent is not in the filtered set, precisely so nothing
disappears silently, and a collapsed key that is itself filtered out must not
reach through and hide its children anyway — that is the exact failure the
nesting rule exists to prevent. Recursing only from items already emitted gives
this for free, which is the argument for the check living in `walk()` rather
than filtering the finished array afterwards.

Two smaller calls. Offer a twisty only where there is something to collapse —
the `childrenOf` map already answers that, so it is a lookup the walk is doing
regardless. And decide what happens to a cursor inside a subtree that just
collapsed: moving it up to the parent keeps the selection on screen, leaving it
means the next `j` resumes from somewhere invisible.

## A type filter, on the backlog and the board

The toolbar filters on project, status, cadence, reporter and text; type is the
obvious gap. On the board it is one line in `filtered` and a select — and unlike
the project and reporter filters, this one is drawn from `ITEM_TYPES` rather
than from the items, so it can never dangle and none of the recovery in the
effect above `filtered` applies to it. The constant is already imported into the
renderer by `CreateDialog` and `ItemDetail`.

The cost is toolbar width. The comment on the reporter select already notes the
toolbar is five wide, and that is why that menu is absent rather than empty in a
vault where nobody fills the field; a sixth control has to earn its place. Which
raises one select or several checkboxes. There are five types, not two, and the
two things worth asking for are "epics only", which reads as a roadmap, and
"everything except subtasks", which is noise reduction. A single select gives
the first and cannot express the second.

The backlog is where this stops being mechanical. Filter to `task` and every
epic leaves the set, so `backlogOrder` finds those parents absent, promotes
their children to roots, and the tree flattens completely — nothing is lost, but
the hierarchy vanishes at exactly the moment someone narrowed the view to look
at structure. Filter to `epic` and the children are gone because the filter
dropped them, which on screen is indistinguishable from someone having collapsed
them.

So the decision this is really about: does the filter mean "show only these
types", or "show these types plus whatever ancestors place them"? The second
keeps the backlog a tree and costs a pass to pull in the parents of matches, but
then the view contains items that do not match the filter, which no other filter
here does. Worth settling first, because the board wants the first reading and
the backlog probably wants the second — and "the same control behaves
differently per view" is defensible only when it was chosen rather than
discovered.

## "Turn on history" — a button that sets git up for the chosen vault

Setting up history today is a manual sequence nobody should have to know: copy a
`.gitattributes` in, `git init`, `git add -A`, `git commit`, and — the step that
actually bites — have a `user.name` and `user.email` configured first. Miss the
identity and `git add` still succeeds while `git commit` fails, and `commit()`
swallows that by design, so every write lands, none is committed, and nothing
says so. That is the one failure mode in the whole design that loses work, and
it is currently prevented only by the user knowing to prevent it.

The diagnosis half is already built and already right. The banner in `App.tsx`
distinguishes the three shapes — not a repo, sitting inside a repo that ignores
it, or a repo whose last commit errored — and the sidebar dot shows healthy or
not. What is missing is anything to click. Everything the button needs to decide
is already in the `GitStatus` the snapshot carries; what is absent is a
write-side action, since git is read-only across IPC today.

Offer it in two places: on that banner, and at the first-run picker once a folder
is chosen, since that is when the user is thinking about setup at all.

The order matters and is the reason this wants writing down rather than
improvising. `.gitattributes` (`* text eol=lf`) has to exist **before** the first
`git add`, or Windows stages CRLF while the app writes LF and every file reads as
wholly modified — which defeats the stable frontmatter ordering the diffs depend
on. Identity gets checked before `git init`, not after, and if it is missing the
button asks for a name and email rather than failing: that is two fields and the
difference between history working and silently not.

Then it must verify by *doing*, not by looking. `healthy` is false only once
`lastCommitError` has been set, and that is only ever set by a commit that
already failed, so a freshly initialized repo reports healthy whether or not
commits can actually land. Making the initial commit and confirming it is both
the setup and the proof.

Two cases where the button should explain instead of act. If git is not on PATH
there is nothing to initialize — say so and point at the download, do not offer a
button that cannot work. And if the vault sits inside a repo that ignores it,
`git init` would nest a second repo inside the first; that may well be what the
user wants, but it is a choice they should make knowingly rather than a side
effect of clicking Fix.

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
