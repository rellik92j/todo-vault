---
name: git-recover
description: Get unstuck from a git mistake in the todo-vault repo — commits on the wrong branch, work sitting on main, undoing a commit or a whole merged PR, a pull that will not fast-forward, a rebase conflict, a diverged local main, a file committed that should have been ignored, or a Windows worktree that will not delete. Use this whenever the user says "undo", "revert", "I messed up", "wrong branch", "I committed to main", "get rid of that commit", "conflict", "it won't let me pull", or sounds stuck or worried about git state. Also use it when a git command has just failed and the next step is not obvious.
---

# Recover from a git mistake

Start here, because it changes how the rest reads: **almost nothing in this repo
is expensive to undo.** One question decides which category a mistake is in.

> Has it been pushed and merged?

Before that line, you are rewriting your own private history and nothing outside
this machine has seen it. After it, you fix forward with a revert instead of
rewriting. This repo is single-author with no branch protection, so the genuinely
expensive category is nearly empty — and even a `reset --hard` that eats a commit
is recoverable via the reflog (last section).

**Before running anything destructive**, take a seatbelt. It costs one command:

```bash
git branch backup-before-reset
```

That pins every commit currently reachable from HEAD to a name, so no matter what
the next command does, the work is still findable. Delete it afterwards with
`git branch -D backup-before-reset` once you are sure. Use a plain literal name
rather than a `$(date)` expansion — this box runs PowerShell as often as bash,
and the substitution syntax differs.

## Symptom index

| Symptom | Section |
|---|---|
| Uncommitted work sitting on main | 1 |
| Committed to main, not pushed | 2 |
| Committed to main and pushed | 3 |
| Wrong content or missing file in the last commit | 4 |
| A merged PR needs undoing | 5 |
| `git pull --ff-only` refuses | 6 |
| Conflict during a rebase or merge | 7 |
| Local main is diverged or confusing | 8 |
| Committed a file that should be ignored | 9 |
| Worktree will not delete on Windows | 10 |
| No idea what state anything is in | 11 |

## 1. Uncommitted work sitting on main

Nothing is wrong yet. Branching carries the changes with you:

```bash
git switch -c descriptive-branch-name
```

Git tracks your working tree separately from which commit HEAD points at, so
switching branches leaves modified files alone. No stash, no copy, no loss. Carry
on with `ship-change`.

## 2. Committed to main, not pushed

The commits are fine; they are just in the wrong place. Move the branch label,
do not move the commits:

```bash
git switch -c descriptive-branch-name   # this branch now holds the commits
git switch main
git reset --hard origin/main            # main returns to the remote's state
```

`reset --hard` throws away uncommitted changes in the working tree as well as
moving the branch — that is exactly why step one comes first. Because the commits
are already reachable from the new branch, nothing is lost.

Confirm before and after with `git log --oneline main ^origin/main`, which lists
commits on main that the remote does not have. It should be empty at the end.

## 3. Committed to main and pushed

Two honest options, and the second is usually right.

**Leave it.** A pushed commit on main is not broken, just un-reviewed. If the
content is correct, the cost of rewriting exceeds the cost of an untidy history.

**Revert the content** if the change itself is wrong:

```bash
git revert <sha>
```

This adds a new commit that undoes the old one. It is safe precisely because it
adds history rather than rewriting it.

Rewriting is possible here — single author, no protection — but it is the option
to reach for last:

```bash
git reset --hard <good-sha>
git push --force-with-lease
```

Use `--force-with-lease`, never bare `--force`. The lease refuses the push if the
remote moved since your last fetch, so you cannot silently clobber something you
have not seen. Bare `--force` will happily destroy it.

## 4. Wrong content or a missing file in the last commit

Only safe while the commit is unpushed — amending replaces the commit with a new
SHA, so a pushed amend makes your next push get rejected.

```bash
git add the-file-you-forgot.ts
git commit --amend --no-edit    # keep the message, fix the content
git commit --amend              # or reword the message too
```

If it is already pushed, do not amend. Make a follow-up commit, or revert.

## 5. A merged PR needs undoing

This is what merge commits buy you:

```bash
git switch -c revert-pr-<number>
git revert -m 1 <merge-commit-sha>
```

`-m 1` means "keep the first parent's side" — the state main was in before the PR
landed. A merge commit has two parents, so Git cannot know which side you meant
without being told; parent 1 is always main, parent 2 is the branch.

Then ship it through `ship-change` like any other change. Reverting a merge is a
normal reviewable change, not an emergency.

Find the merge SHA with:

```bash
git log --oneline --first-parent -10
```

## 6. `git pull --ff-only` refuses

Good — that is the flag working. It means local main and `origin/main` have both
moved, and a fast-forward is impossible. Nothing has broken; the pull simply did
not happen.

See what arrived and what you have that the remote does not:

```bash
git log --oneline origin/main ^main    # incoming
git log --oneline main ^origin/main    # yours
```

If your side is commits that belong on a branch, use section 2. If your side is
empty and it still refuses, your local main has diverged some other way — section
8. If both sides have real work, replay yours on top:

```bash
git pull --rebase
```

## 7. Conflict during a rebase or merge

Git stops and marks the conflicting regions in the files. The way out:

```bash
# edit the files to resolve, then
git add <resolved-files>
git rebase --continue      # or: git merge --continue
```

The escape hatch matters more than the resolution:

```bash
git rebase --abort         # or: git merge --abort
```

That returns you exactly to where you started, as if the command never ran. If a
conflict looks confusing, abort first and understand the two sides before trying
again — there is no penalty for aborting.

`git status` during a conflict lists precisely which files still need attention.

## 8. Local main is diverged or confusing

If nothing on local main matters, `origin/main` is the reset button:

```bash
git log --oneline main ^origin/main    # check what you'd lose FIRST
git switch main
git reset --hard origin/main
```

Run the first command every time. If it prints nothing, the reset is free. If it
prints commits, section 2 saves them onto a branch first.

## 9. Committed a file that should be ignored

```bash
git rm --cached path/to/file
```

`--cached` removes it from Git's index while leaving it on disk. Add the path to
`.gitignore`, then commit both changes together.

If the file was already pushed and contains anything sensitive, note that removing
it now does not remove it from history — anyone can still read it at the old
commit. That is a bigger problem than this skill covers; say so plainly rather
than implying the removal fixed it.

## 10. Worktree will not delete on Windows

`git worktree remove` fails on the final directory removal because VS Code's file
watcher holds a lock on `.claude/worktrees/<name>`. The important part is that git
still deregisters the worktree and the contents still delete — only the empty
directory survives.

```bash
git worktree list      # confirm it is gone from git's view
git worktree prune     # clear any stale registration
```

Then delete the leftover empty directory manually, or leave it —
`.claude/worktrees/` is gitignored, so it will never reach a commit either way.

## 11. No idea what state anything is in

Three commands, in this order:

```bash
git status -sb                    # branch, upstream, and what's modified
git log --oneline --graph -10     # recent shape of history
git reflog -15                    # every move HEAD has made
```

`git reflog` is the one worth internalising. It records every position HEAD has
held for the last 90 days — including positions you reached and then destroyed
with a `reset --hard`. So a commit that seems deleted is almost always sitting
right there with a SHA next to it:

```bash
git switch -c rescue <sha-from-reflog>
```

This is the real reason git mistakes in a solo repo are close to impossible to
make permanent. The history you can see is not the whole history Git kept.

## Related

`start-change` for opening a branch correctly; `ship-change` for taking work from
commit to merged.
