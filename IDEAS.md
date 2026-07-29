# Future ideas

Unscheduled ideas that haven't earned a PLAN.md phase or a PLAN-*.md design doc
yet. When one is ready to build, promote it: either a new phase in PLAN.md, or
its own `PLAN-<name>.md` if it needs real design work first (see PLAN-LINKS.md
for the shape of one of those).

Newest at the top. No status tracking here — once something's picked up, its
entry moves out to wherever it's being built.

## The detail panel's related items should carry the status colour

`StatusPill` puts a dot in `var(--<status>)` beside the label, and the backlog,
the agenda and the palette all use it. `ItemDetail` is the one place that does
not. Its Children rows render `<span className="pill">{STATUS_LABELS[child.status]}</span>`
— the lozenge without the `.dot` — so status arrives as grey text in a grey
capsule, and the one screen devoted to a single item's relationships is the one
screen where the colour is absent. The Links section's `item` rows and the
"Linked from" rows carry no status at all, just a key and a summary.

Two of the three are already free. `getRelated` hands back full `Item`s, so
`child.status` and `source.status` are both in hand: Children wants `StatusPill`
swapped in for the bare pill, and the backlink row wants the same element added.
`pieces.tsx` exports it and `ItemDetail` already imports from there.

The Links section is where the decision is. `item.links` are `{type, target,
label}` records — a key, not an item — so a status has to be resolved from
somewhere. The `items` prop looks like that somewhere and is the wrong answer:
`App` passes `visibleItems`, which drops hidden projects, so a link pointing
into one resolves to nothing and the absent pill reads as "no status" rather
than "not shown here". The parent field hit this exact wall and settled it with
`offProject` — render the key it could not place rather than go blank.

Resolving in `getRelated` avoids it, since `vault-service` holds the whole vault
unfiltered, and it matches what backlinks already do: `vault.backlinks()` does
not filter hidden projects, so "Linked from" can already name an item the rest
of the window says is not there. That is the precedent worth following, but it
means deciding out loud that this panel shows relationships across a boundary
every other view honours. And whatever resolves the key has to survive a target
that has since gone: `addLink` validates the target exists, `doctor` checks for
dangling item links because they happen anyway, and a link whose item is deleted
should say so rather than leave a pill-shaped hole.

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
