# Future ideas

Unscheduled ideas that haven't earned a PLAN.md phase or a PLAN-*.md design doc
yet. When one is ready to build, promote it: either a new phase in PLAN.md, or
its own `PLAN-<name>.md` if it needs real design work first (see PLAN-LINKS.md
for the shape of one of those).

Newest at the top. No status tracking here — once something's picked up, its
entry moves out to wherever it's being built.

## Three more agenda scopes, and they are not the same shape of work

The four existing scopes — `today`, `week`, `nextWeek`, `month` — are one
`Record<AgendaScope, {from, to, cadences}>` in `Vault.agenda()`
(`packages/core/src/vault.ts`). Adding a scope value there is the only edit
that carries meaning; everything else it touches is cosmetic repetition, and
there is a lot of it, because `AgendaScope` is not one type with importers —
it is written out independently in at least four places with nothing forcing
them to agree: the union in `shared/api.ts`, the zod enum in
`vault_get_agenda` (`mcp-server.ts`), and, inside `cli.ts` alone, both an
inline cast on the parsed argument and a separate `scopePhrase` record. The
UI adds two more: `SCOPE_PHRASE`/`HEADINGS` in `Agenda.tsx` and the `<select>`
options in `App.tsx`. Three new scopes at six-plus touch points apiece is the
tax for this ask regardless of which get built — but the three don't cost the
same, because they aren't the same *kind* of range.

**Next 30 days** is the cheap one. It is a rolling window, not a calendar
period: `from: reference, to: addDays(reference, 30)`. That puts `reference`
(today) at the start of its own window, same as `today`/`week`/`month`
already do — the boring, already-proven case.

**This week + next week** is almost free but has one real trap. The range
itself is just the union of two ranges that already exist and are contiguous
— `from: startOfWeek(reference), to: addDays(startOfWeek(reference), 13)`,
same `["daily", "weekly"]` cadences its two halves already use. The trap is
building it by calling `agenda("week")` and `agenda("nextWeek")` separately
and stacking the results in the UI instead of adding a real third range. Both
calls compute `overdue` the same way — `open.filter(dueDate < reference)`,
which does not depend on `to` at all — so a naive two-call union shows every
overdue item twice. The existing dedup (`alreadyListed`, and overdue winning
the "which section claims this item" tie) only works inside a single
`agenda()` call. This one has to be a genuine fourteenth-to-twentieth-day
entry in the `ranges` record, not a UI-side merge of two calls.

**Next month** is the one worth being careful with, for a reason that will
not show up in testing until someone ticks a monthly item at the wrong time.
`reference` in that window is neither inside it (like the two above) nor at
its start — it falls entirely *before* `from`. `nextWeek` already has this
property today, and it already works, but for a reason that is easy to
mistake for having been designed in: `cadencePeriod` (`recurrence.ts`) always
computes the period *containing `reference`* — this week, this month — never
the window being displayed. For `nextWeek`, `isSettledForWindow` checks this
week's `period.to` against next week's `windowEnd`, and this week's end is
never `>=` next week's end, so a weekly item always reads as unsettled and
correctly keeps showing up under "Recurring next week" — right answer, but
because of which direction that inequality happens to point, not because the
period was shifted forward to match the window. `nextMonth` would inherit
the identical accident: this month's `period.to` is never `>=` next month's
end, so a monthly item always shows there too, which is again the right
answer. Safe to build the same way `nextWeek` was — but it deserves a comment
saying so where the range is added, since the obvious "fix" — computing
`cadencePeriod` from the window's own `from` instead of from `reference` — is
the thing that would actually break it for every scope that isn't this one.
On the range itself, no new date-math helper is needed even though
`recurrence.ts` has no month-shift arithmetic today (only `startOfMonth`,
`endOfMonth`, `startOfQuarter`, all reference-relative): `endOfMonth` already
composes into it — `addDays(endOfMonth(reference), 1)` is next month's start,
and `endOfMonth` of that is next month's end.

## A drifted item still cannot be pushed as an update

Fixing the planner's eligibility check left the harder half standing: nothing in
the repo updates an existing Jira issue. `buildPushPlan` only ever creates, so a
drifted item's choices are a duplicate issue or a hand edit. The plan now says so
in a warning, which is honest, but the remedy is still manual — edit Jira, then
call `vault_mark_pushed` again to re-stamp the baseline. That call rebuilds
`sync` from scratch (`Vault.markPushed`), so it wants `jiraKey` re-supplied and
`jiraId` re-supplied too, or the id is silently dropped. No SCHEMA.md entry or
tool description says any of this. There is also no CLI `mark-pushed` at all;
`README.md` used to paper over that with a blanket claim of parity and now names
it as a gap instead, which is honest but is not the same as closing it.

A smaller thing worth folding in whenever this is picked up: drift is one-way —
`markDriftIfChanged` moves `pushed → drifted` and never back — so an item edited
and then reverted keeps the `drifted` pill in the detail panel forever. The push
planner no longer cares, since it compares hashes rather than trusting the
label, but the UI still misreports it. Healing the label needs a rule about what
`pushed` means when nothing was pushed, which is why it sits here rather than
having been fixed alongside the hash.

One caution for whoever picks this up, kept because getting it wrong once is
instructive: this entry used to warn that `PLAN-LINKS.md` was wrong to say
adding a link flips a pushed item to `drifted`. The observation was right —
`links` was absent from `pushableFields` and `addLink` persisted without
recomputing anything — and the conclusion was backwards. Links *are* pushed, in
the description footer, so the doc described correct behaviour that had never
been built. Both halves are fixed now (see PLAN.md, "Links count as drift"): the
field list gained `links`, and the recomputation moved into `persist`, where the
writers that skip `updateItem` go through it too.

So the standing advice survives in a sharper form. Check the field list rather
than the prose — and when the two disagree, ask which one Jira would agree with
before assuming the prose is the stale half.

## "Scheduled" as a seventh status — and the two clogs it would paper over

The complaint is real and `SCHEMA.md` already concedes it in as many words: a
daily task "sits in `todo` forever and accumulates completions". Nothing about
that is a bug, and it is exactly what makes the `todo` pile stop being a list of
what to do next. But the ask bundles two failures with different shapes, and they
want separating before a mechanism gets picked, because neither one obviously
needs a status.

**The recurring half is not an information problem.** `isSettledForWindow` and
`isTickedFor` already exist in `recurrence.ts` and import nothing. `isTickedFor`
is already imported by `Board.tsx` and `BacklogTable.tsx` — both render
`<Cadence ticked>` on the card — while `isSettledForWindow`, which is the one a
filter would actually want, is so far used only by `agenda()` in the core. It is
exported on the same `todo-vault/recurrence` subpath, so reaching it is an
import, not a plumbing job. So the board already knows this period's turn is done and already
says so. What it does not do is *act*: a daily item ticked an hour ago holds the
same slot in the `todo` column, and counts the same in the sidebar, as one nobody
has touched all week. The agenda got this right and is the precedent — it drops
settled items rather than retiring them. The board and table want the same
reading, as a filter beside the existing cadence dropdown in `App.tsx`, not as a
status.

**The scheduled half is a genuine gap, in a different field.** `startDate` is
stored, editable in `ItemDetail`, in `pushableFields`, and now written by the app
when work starts — and it filters nothing, anywhere. `ItemFilter` has `dueBefore`
and `dueAfter` with no start equivalent, so work that begins in September is
indistinguishable, in every view, from work actionable this morning. That is the clog described, and the missing piece is the
neighbour `dueBefore` never got, not a new value in an enum.

Which is the distinction worth writing down, because it decides this and will
decide the next one like it: **does the item leave the state on its own, or does a
person decide it leaves?** A start date arriving is the clock, so it should be
derived — a status for it goes stale the morning it comes true, and the only fixes
are a sweep on load or nothing. A sweep means the app rewrites `status` on files
it merely opened, which lands in git history as an edit nobody made, and the
frontmatter ordering exists precisely so diffs mean something.

That leaves one case a status genuinely fits, and it is worth asking whether it is
the real ask: *"I have decided not to look at this until later, and I will not
invent a start date to say so."* That is a decision, not a date, and nothing in
the schema records it — `blocked` is close but claims something external is in the
way. If that is what is wanted it should be named for the decision, `parked` or
`deferred`, not `scheduled`, which promises a date it does not have.

One point genuinely on the status side, since it cuts against deriving: `status`
is not in `pushableFields` but `startDate` is. Expressing "later" by typing a date
flips a pushed item to `drifted` against Jira; a status change does that only on
the one move that now writes a date — into `in_progress` — and never on a move
that means "not yet".

If it does turn out to be `parked`, the cost is not distributed the way the
`disregard` phase would suggest. Jira is free — `statusTransitions` is a
defaulted record that nothing reads yet, so an unmapped status is a doc edit.
`TRANSITIONS` is where the work actually is: a new row plus a decision in each of
six existing rows, every one the same rollup-integrity question that makes
`todo → in_review` a refusal. `DONE_STATUSES` is the trap — its comment reads "no
longer needs attention", which a parked item satisfies, but `open` must still
find it or this is `disregard` with a friendlier label; reuse silently retires the
item, and a second set means every existing caller has to say which of the two it
meant. `BOARD_ORDER` forces the choice the disregard column dodged, since
`pieces.tsx` already records that six columns overflow the default window and
that a status missing from the list makes cards vanish rather than merge — and
the grouped board now derives its grid's `--columns` from that same length, so a
seventh status widens every lane at once rather than misaligning one of them. And the
dot has to pass `--disregard`'s test — seventh hue distinguishable from six others
at 7px — while wanting to read as *quiet*, which is what `--todo`'s grey already
is.

Cheapest first step is the same either way, and it is neither: the two filters.
Both are additive, both use helpers that already exist, and together they make
the pile mean "actionable now" without committing the schema to anything. If it
still feels clogged afterwards, what is left is the parked decision — visible on
its own, which is the only honest way to price a seventh status.

## OneDrive links through the MCP server, not pasted into the description

The OneDrive design is already written — `PLAN-LINKS.md` ask 2, gotchas 1–3 and
9–11, build steps 3–4, none of it built. This entry is not that design restated.
It is the one surface that design deliberately leaves out, and the reason that
exclusion is worth reopening.

**Done:** the cheapest first step, the two tool descriptions. `vault_link_item`'s
`url` line and `vault_attach_file`'s `copy` line now both name synced cloud
storage (OneDrive, SharePoint, Google Drive, Dropbox), and `SCHEMA.md`'s Links
section carries matching wording plus the capability-URL note from gotcha 11.
Text only, inside gotcha 3's ruling not to add a link type. Do not redo this —
what is left below is guidance, not a guard, and `vault_attach_file` still
defaults to `copy: true` with no guard behind the new wording.

What remains is the local-path half. Gotcha 2 rules that sync-root detection is
Windows-shaped and machine-local, so the roots get passed into the core as
`VaultOptions.syncedRoots` and the desktop main process is the thing that
discovers them. The proposed shape then says the option is "empty by default,
so CLI/MCP behaviour is unchanged", and calls that the honest outcome. It was
the right call for a doc scoped to the app. But the MCP server is arguably the
*likeliest* surface to be handed a OneDrive path — nobody drags a file into a
chat, they paste
`C:\Users\bisch\OneDrive - Contoso\Docs\plan.xlsx` as text — and with
`syncedRoots` empty, `vault_attach_file` defaults to `copy: true` and makes the
diverging second copy that ask 2 exists to prevent. The desktop app would refuse.
The agent won't, and now it has been told not to, but nothing stops it either.

Only the local-path rule needs to be told where the sync roots are, and a
headless server has no main process to ask. That is the open question this
entry is really holding: an env var, a config key, or accepting that the local
half stays app-only.

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

`index.css` is one file of nearly two thousand lines in twenty sections, and it
is two different things stacked on top of each other. The colour layer is a real system: `:root`
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
