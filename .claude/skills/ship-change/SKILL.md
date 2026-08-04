---
name: ship-change
description: Take finished work in the todo-vault repo from a branch to merged and synced — verify with typecheck and tests, review the diff, commit in this repo's prose style, push, open a PR with gh, wait for CI, merge, and pull main back down. Use this whenever the user says "ship it", "commit this", "push it up", "open a PR", "merge it", "I'm done", or otherwise signals a change is finished. Also use it when a change is complete and still sitting uncommitted, even if the user only asks for part of the sequence — committing without pushing usually means the rest is about to be asked for anyway.
---

# Ship a change

The order below is not arbitrary. Verification comes before the commit message so
a red suite stops you before you have spent effort writing prose about work that
does not pass. Review comes before staging so debris is caught while it is still
easy to leave out. Everything after that is mechanical.

## 0. Guard: are you on main?

```bash
git status -sb
```

If the branch is `main`, the work needs a branch before it needs anything else:

```bash
git switch -c <descriptive-kebab-case-name>
```

Uncommitted changes come with you — nothing is lost and no stash is needed. See
`start-change` for the naming convention. If commits have *already* landed on
main, stop and use `git-recover` instead.

## 1. Verify

```bash
npm run typecheck
npm test
```

Both must exit 0. There is CI on pull requests now, but a red PR is a slow way to
learn what a local run tells you in seconds, and CI cannot tell you anything
useful about a commit message you have not written yet.

Add `npm run build` when the change touches build configuration — electron-vite
config, any `tsconfig*.json`, `package.json` scripts, or dependencies. Typecheck
reads the types; it never exercises the bundler, so a change that breaks the
build can typecheck cleanly.

Note the test count from the output. The commit body cites it.

If either fails: fix it, then re-run. Do not commit red and do not describe a
failure as "pre-existing" without checking `git stash` first to prove it.

## 2. Review what you are about to commit

```bash
git status --short
git diff
```

You are looking for four things:

- **Debris** — reproduction scripts, scratch files, commented-out experiments.
- **Someone else's work.** This tree often carries in-progress edits from an
  earlier session. They are not yours to commit.
- **Secrets or machine-specific paths.** `.gitignore` already excludes
  `.mcp.json`, `plan.json`, `issues.csv`, `.claude/settings.local.json`, and
  `/vault/`, but new files arrive faster than the ignore list does.
- **Anything the diff shows that you did not intend.**

## 3. Commit

Stage by explicit path. `git add -A` is what sweeps unrelated work into your
commit, and this repo's working tree makes that a live risk rather than a
theoretical one:

```bash
git add path/to/file.ts path/to/other.md
```

### Subject line

Imperative mood, roughly 50–72 characters, no trailing period, and **no
conventional-commit prefix** — this repo does not use `feat:` / `fix:` / `chore:`.
State the outcome, not the activity. Real subjects from the history:

```
Stop a dropped link from replacing the app window
Spawn npm through node, so the menu needs no shell at all
Keep OneDrive documents in OneDrive, rather than copying them in
Date an item the moment it moves into in_progress
Add a numbered launcher, so the two-step commands cannot be got wrong
```

Each one tells you what became true. `fix: navigation bug` does not.

### Body

Blank line after the subject, wrapped around 76 columns, prose rather than
bullets. Cover:

1. **The problem, concretely.** What actually went wrong, with the error text or
   the specific behaviour. Not "there was an issue with X".
2. **Why this fix and not another.** The reasoning that is invisible in the diff
   is the only part of a commit message that cannot be reconstructed later.
3. **What you verified**, with numbers — "125 tests green, typecheck clean".
4. **What you did not verify.** This repo does this consistently and it is the
   most valuable line in the message. A commit that names its own blind spot is
   far more useful in six months than one that implies everything was checked.
   `9979aca` closes with "Not verified: the preview scripts are checked by
   construction … but Electron was never launched." Copy that habit.

### Trailers

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: <the current session URL>
```

### Writing it

Use a heredoc so the body's line breaks survive. From the Bash tool:

```bash
git commit -F - <<'EOF'
Subject line in the imperative

The problem, stated concretely enough that someone who has never seen the
bug can recognise it.

Why this approach rather than the obvious alternative, and what that
alternative would have cost.

125 tests green, typecheck clean. Not verified: <the honest gap>.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: <session url>
EOF
```

Prefer the Bash tool for this. PowerShell can do it with a single-quoted
here-string, but the closing `'@` must sit at column zero or it is a parse error,
and that is an easy way to lose a carefully written message:

```powershell
git commit -m @'
Subject line in the imperative

Body text, with $literal dollar signs safe inside single quotes.
'@
```

## 4. Push

```bash
git push -u origin HEAD
```

`-u` records the upstream so later pushes on this branch are a bare `git push`.
`HEAD` saves retyping the branch name and cannot get it wrong.

## 5. Open the pull request

```bash
gh pr create --title "..." --body-file -
```

**Title:** for a single-commit PR, reuse the commit subject verbatim. For several
commits, write one sentence that covers the set — PR #12's title named the
headline change and the body explained that agenda work rode along.

**Body:** the PRs in this repo are substantive prose, not bullet dumps, and they
are worth the few extra minutes because they are the only place the *shape* of a
multi-commit change gets explained. Structure that works:

- Open with the problem or the state of things before the change.
- Explain what changed and the reasoning the diff cannot show.
- Use `##` sections when the PR carries genuinely distinct pieces, with the
  relevant commit SHA in the heading — PR #12 and #10 both do this.
- Close with what was verified and what was not.

```bash
gh pr create --title "Subject line" --body-file - <<'EOF'
The situation that made this necessary.

## First distinct piece (`abc1234`)

What changed and why.

## Second distinct piece (`def5678`)

What changed and why.

125 tests green, typecheck clean. Not verified: <gap>.
EOF
```

## 6. Wait for CI, then merge

```bash
gh pr checks --watch
gh pr merge --merge --delete-branch
```

`gh pr checks --watch` blocks until the workflow finishes and exits non-zero if
anything failed. If it reports no checks at all, the workflow did not trigger —
worth a look, but not a reason to block a merge.

`--merge` rather than `--squash` is deliberate. A merge commit keeps the
individual commits inside the PR available to `git bisect` and `git blame`, while
still making the entire PR revertable as one unit via `git revert -m 1`. Squashing
gives you the second property and destroys the first, which matters here because
PRs routinely carry three to five commits.

`--delete-branch` removes the branch locally as well as on the remote. The repo
already has `delete_branch_on_merge` enabled, so the remote side happens either
way; the flag is what stops dead branches piling up on your machine.

**If checks fail:** fix on the same branch, commit, and push. The PR updates
itself — never close and reopen it.

## 7. Sync main back down

```bash
git switch main
git pull --ff-only
git log --oneline --first-parent -3
```

The merge commit is now the tip of main. `--first-parent` shows one line per
merged PR, which is the view this whole workflow exists to produce.

## The whole sequence

```bash
npm run typecheck && npm test          # 1. verify
git status --short && git diff         # 2. review
git add <explicit paths>               # 3. stage deliberately
git commit -F - <<'EOF' ... EOF        #    commit in house style
git push -u origin HEAD                # 4. push
gh pr create --title "..." --body-file - <<'EOF' ... EOF   # 5. PR
gh pr checks --watch                   # 6. wait for CI
gh pr merge --merge --delete-branch    #    merge
git switch main && git pull --ff-only  # 7. sync
```

## If something goes wrong

`git-recover` covers commits on the wrong branch, undoing a merged PR, a pull
that will not fast-forward, and amending a commit that has not been pushed.
