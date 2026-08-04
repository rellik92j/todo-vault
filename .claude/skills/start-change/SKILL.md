---
name: start-change
description: Open a branch before touching anything in the todo-vault repo — sync main, pick a name in the house style, and carry over work already begun. Use this whenever a change to code, docs, or config is about to start and the current branch is main, and whenever the user says "let's start on X", "I want to add/fix/change Y", "new branch", or describes a bug to go fix. Also use it when editing has already started on main by mistake and the work needs moving onto a branch. Every change in this repo gets a branch — including one-line README fixes — so trigger this even when the change feels too small to be worth a branch.
---

# Start a change

Every change in this repo goes onto a branch and through a pull request. There is
no size threshold — a typo fix in `IDEAS.md` gets the same treatment as a feature.

That sounds like ceremony, and for a solo repo the review value is admittedly
thin. The reason it holds anyway is that a uniform history is worth more than the
15 seconds it costs. When every entry on `main` is a merge commit, `git log
--first-parent` is a clean list of finished changes, any one of them reverts with
a single command, and there is never a moment spent deciding whether *this*
change is big enough to deserve a branch. Mixed history loses all three.

## 1. Find out where you are

```bash
git fetch origin
git status -sb
```

Read the result before doing anything:

| What you see | What it means |
|---|---|
| `## main...origin/main`, clean | The easy case. Go to step 3. |
| `## main...origin/main` with modified files | Work already started on main. Step 2 first. |
| Already on a feature branch | Ask whether this is the same piece of work. See below. |
| `[behind N]` | Local main is stale — step 3 fixes it. |
| `[ahead N]` on main | Commits landed on main directly. That is `git-recover` territory. |

**If you are already on a feature branch:** decide whether the new work belongs to
it. Related work riding along on an existing branch is normal here — PR #12
carried five commits under a name taken from the first of them. Unrelated work is
different: ship the current branch first (`ship-change`), or the PR ends up
arguing two separate cases at once.

## 2. Uncommitted changes that are not yours

This tree regularly carries work in progress from an earlier session. Look at it
before you carry it anywhere:

```bash
git status --short
git diff --stat
```

Changes you did not make will follow you onto the new branch, and that is
harmless — they stay uncommitted and belong to no branch in particular. The real
risk arrives later, at commit time, when `git add -A` would sweep them into your
commit. Note what is there now so `ship-change` can stage around it.

## 3. Sync main

```bash
git switch main
git pull --ff-only
```

`--ff-only` is the point of this step. A plain `git pull` will quietly build a
merge commit if your local main and the remote have diverged; `--ff-only` refuses
instead, so you find out. If it refuses, stop and use `git-recover` — do not
force anything.

Skip the `switch` if you are already on main. If the tree is dirty and the pull
complains about overwriting a file, branch first (step 5) and rebase later; on a
single-author repo main is rarely ahead of you anyway.

## 4. Name the branch

The convention here is a descriptive kebab-case phrase naming the *outcome* — no
`feature/`, `fix/`, `chore/`, or ticket prefixes. It reads like the sentence the
commit subject will use.

Real branch names from this repo:

```
onedrive-links-stay-in-onedrive
fix-window-navigation-and-doc-drift
numbered-launcher-for-workspace-commands
readme-as-a-landing-page-and-install-scripts
menu-without-a-shell-and-preview-scripts
```

Notice they describe the state of the world after the change, not the activity.
`onedrive-links-stay-in-onedrive` tells you what became true. `fix-onedrive-bug`
would not.

Name it for the change you are setting out to make. If more work joins it later,
leave the name alone and explain the spread in the PR body — that is what PR #12
did, and renaming a pushed branch costs more than it saves.

## 5. Create it

```bash
git switch -c <branch-name>
```

`-c` creates and switches in one move. Any uncommitted changes come with you,
because Git tracks your working tree separately from which commit HEAD points at
— switching branches does not touch files that differ from the commit. This is
why "I forgot to branch" is a non-event in Git and not worth stashing over.

Do **not** push yet. The branch has no commits, and an empty branch on the remote
is noise. `ship-change` pushes it at the same moment it opens the PR.

## 6. Confirm and hand off

```bash
git status -sb
```

Report the branch name and, if the tree carried pre-existing changes, say so
explicitly and name the files — that memory is what stops them being committed by
accident later.

Then get on with the actual work. When it is done, `ship-change` takes it from
commit through merge.

## If something looks wrong

`git-recover` covers the usual knots: commits on main, a diverged local main, a
pull that refuses to fast-forward, and the Windows worktree lock.
