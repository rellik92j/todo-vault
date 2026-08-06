# Running todo-vault on a new computer

This covers the one path that's actually verified today: getting a working copy
running from a terminal with `npm run dev`. (There is no packaged `.exe` yet —
see `PACKAGING.md` for that plan.)

Fastest path on Windows, nothing installed yet:

```powershell
irm https://raw.githubusercontent.com/rellik92j/todo-vault/main/scripts/bootstrap.ps1 | iex
```

Installs Node and Git if missing, clones, installs dependencies, and opens the
menu — one run, in the terminal you already have open, landing you at step 5
below. It asks one question on the way, about PowerShell's execution policy;
step 4 explains what that is. See the README for what it does before running it.
The rest of this page is the same steps by hand.

## 1. Install Node

```bash
winget install OpenJS.NodeJS
```

This project is built against Node 24.18.0. Restart your terminal after
installing so `node` and `npm` are on `PATH`.

## 2. Install Git (recommended)

Git isn't required for the app to run, but without it the vault keeps no
history — every write still succeeds, it's just not committed. Grab it from
[git-scm.com](https://git-scm.com/) or `winget install Git.Git`, and confirm
it's on `PATH`:

```bash
git --version
```

## 3. Clone the repo

```bash
git clone https://github.com/rellik92j/todo-vault.git
cd todo-vault
```

## 4. Install dependencies

```bash
npm install
```

This is fast — Electron itself isn't downloaded yet, only declared.

**If PowerShell answers with a security error instead**, naming `npm.ps1` and
"running scripts is disabled on this system", nothing is wrong with your install.
Windows ships PowerShell set to `Restricted`, and PowerShell resolves `npm` to
`npm.ps1` rather than the `npm.cmd` sitting beside it — so the policy blocks it,
along with every other `npm` command on this page. The standard fix, for your
account only and with no administrator rights:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Scripts you write yourself then run; anything downloaded still has to be signed.
If your machine sets this by group policy, that overrules a per-user change —
type `npm.cmd` wherever this page says `npm` instead. The bootstrap script above
handles all of this for you, which is the main reason to prefer it.

## 5. Open the menu

```bash
npm run menu
```

Everything from here is a keypress. The first launch of **Dev app** or **Prod
preview** triggers Electron's runtime download (~350 MB) as a side effect of
building core, since Electron 43 fetches on first `require()` rather than on
`npm install`. The zip is cached in `%LOCALAPPDATA%\electron\Cache`, so this
only happens once per machine, not once per project.

What you do next depends on why you're here.

### Track A — try it with the example vault

1. Press `S` — seeds a worked example: three projects and fifteen items,
   covering an epic with children, recurring items with completion history,
   every link type, a hidden project, and both ways an item can close. It's
   also what the UI is developed against.
2. Press `2` (Prod preview) or `1` (Dev app).
3. In the app, click **Open the example vault**.

### Track B — set up your own vault

1. Press `2` (Prod preview) or `1` (Dev app) — no need to seed first.
2. In the app, click **Choose a folder…**. Pick an empty folder and confirm
   **Create a vault here** to start blank, or point it at a vault copied over
   from another machine (copy it separately first; it's its own git repo).

## 6. A few things to set up once you're in

- **Anthropic API key** (only if you want the AI drafting feature): Settings →
  Claude. It's encrypted with Windows DPAPI and bound to this machine, so it
  has to be re-entered on every new computer — there's no export/import path,
  by design.
- **Git history**: the sidebar shows a "history on / history off" dot for the
  open vault. Run `npm run vault -- git-status --vault ./vault` for detail if
  it's off and you expected it on. When it's on, press `4` for the History view,
  which reads the commits back as field changes rather than as patches; an item's
  own history is at the bottom of its detail panel, behind **Show history**.
- **Press `?`** for every keyboard shortcut. Ctrl+`+`/`−`/`0` size the text, and
  the level is remembered across launches — worth setting once on a new display
  rather than squinting at the default.

## 7. Connect Claude to the vault (optional)

Separate from the in-app drafting above: this is what lets Claude Desktop,
Cowork or Claude Code read and write the vault directly, so you can ask *"what's
due this week"* in a normal chat.

In the menu, press `C`. It asks which vault to point at, then prints a config
block with the real paths on this machine already in it — worth using rather
than copying the one in the README, since the two placeholders there are exactly
what goes wrong. Paste it into

```
%APPDATA%\Claude\claude_desktop_config.json
```

creating the file if it isn't there, then **quit Claude Desktop completely and
reopen it**. Closing the window leaves it running in the tray, and the config is
only read at startup, so a tray-close looks like the setting simply didn't work.

That one entry covers Cowork too — Cowork has no MCP config of its own, it reads
Desktop's and bridges the server across. For Claude Code, the same block goes in
`.mcp.json` at the repo root instead; it's gitignored, so creating it is safe.

Two things to know when it appears not to work. The config points at
`packages/core/dist/mcp-server.js`, which only exists once you've built — press
`7` if you skipped it. And a config pointing at a missing file fails silently:
no error, the vault tools just never show up. Pressing `C` checks for that build
and warns you before printing.

## Updating an existing copy

Already cloned and just want the latest changes? `npm run menu`, then press
`U` — it pulls (refusing rather than surprising you with a merge if your copy
has diverged), reinstalls (a no-op if nothing changed), and rebuilds core, in
that order.

By hand, the same three steps:

```bash
git pull
npm install       # only needed if that pull touched package.json / package-lock.json
npm run build     # rebuilds core; needed whenever the pull touched its source, not its deps
npm run dev
```

### If the pull refuses over package-lock.json

```
error: Your local changes to the following files would be overwritten by merge:
        package-lock.json
```

Nothing of yours is in that file. `npm install` edits the lockfile when what is
already sitting in `node_modules` satisfies the versions `package.json` asks
for — which happens as soon as you check out a branch that moved a dependency,
since `node_modules` is shared across every branch. Throw the edit away and the
pull brings the real copy:

```bash
git restore package-lock.json
```

`npm run update` and the `U` menu entry now do that for you, and say so when
they do. They stop instead if a `package.json` changed too, or if you had
staged the lockfile — that is a dependency change of yours, and worth keeping.

Your vault and settings (API key, last-open vault) live outside the repo, so
pulling never touches them.

## Everyday commands, once set up

```bash
npm run menu            # numbered launcher — pick any of the below by keypress
npm run update          # pull, install, rebuild core — the [U] menu entry
npm run dev             # build core, launch the app
npm run preview         # build core, launch the production build
npm run build           # both workspaces
npm test                # core, desktop, and the launcher's own tests
npm run typecheck       # both workspaces, plus scripts/
npm run vault -- agenda week --vault ./vault   # CLI, run from repo root
```

`npm run menu` is worth knowing about on a machine you only use the app on.
It lists these commands, runs the picked one, and returns to the list when it
finishes — so you do not have to remember any of the names above. The sequences
live in the scripts themselves, which is why `npm run preview` builds the core
before launching: that is the step that is easy to forget, and skipping it
produces a fresh-looking app wrapped around a stale core.

Set `VAULT_DIR` as an environment variable to skip passing `--vault` on every
CLI call.

## If you're copying a folder instead of cloning

That works too, as long as you exclude `node_modules/` and
`apps/desktop/out/` — `node_modules/` is rebuilt by step 4's `npm install`,
`apps/desktop/out/` by whichever menu option you launch in step 5. A zip
preserves line endings exactly; if you use git instead, `.gitattributes`
already pins `eol=lf` so Windows checkouts don't get corrupted into CRLF.
