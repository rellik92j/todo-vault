# Running todo-vault on a new computer

This covers the one path that's actually verified today: getting a working copy
running from a terminal with `npm run dev`. (There is no packaged `.exe` yet —
see `PACKAGING.md` for that plan.)

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

## 5. Build the core

```bash
npm run build
```

The first build triggers Electron's runtime download (~350 MB), since Electron
43 fetches on first `require()` rather than on `npm install`. The zip is cached
in `%LOCALAPPDATA%\electron\Cache`, so this only happens once per machine, not
once per project.

## 6. Get a vault

The repo's `/vault` folder is gitignored, so a fresh clone has the app but no
data. Two options:

```bash
npm run seed -- ./vault
```

builds the worked example vault — three projects and fifteen items, covering an
epic with children, recurring items with completion history, every link type, a
hidden project, and both ways an item can close. Good for exploring the app,
and it's what the UI is developed against.

Or point the desktop app's first-run picker at a different folder if you're
bringing your own vault across from another machine (copy it separately; it's
its own git repo).

## 7. Launch the app

```bash
npm run dev
```

This builds the core and opens the desktop app.

## 8. A few things to set up once you're in

- **Anthropic API key** (only if you want the AI drafting feature): Settings →
  Claude. It's encrypted with Windows DPAPI and bound to this machine, so it
  has to be re-entered on every new computer — there's no export/import path,
  by design.
- **Git history**: the sidebar shows a "history on / history off" dot for the
  open vault. Run `npm run vault -- git-status --vault ./vault` for detail if
  it's off and you expected it on.
- **Press `?`** for every keyboard shortcut. Ctrl+`+`/`−`/`0` size the text, and
  the level is remembered across launches — worth setting once on a new display
  rather than squinting at the default.

## Updating an existing copy

Already cloned and just want the latest changes?

```bash
git pull
npm run build     # skip if package.json / package-lock.json didn't change
npm run dev
```

Only rerun `npm install` if that pull touched `package.json` or
`package-lock.json`. Your vault and settings (API key, last-open vault) live
outside the repo, so pulling never touches them.

## Everyday commands, once set up

```bash
npm run menu            # numbered launcher — pick any of the below by keypress
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
`apps/desktop/out/` — both get rebuilt by steps 4–5 above. A zip preserves line
endings exactly; if you use git instead, `.gitattributes` already pins `eol=lf`
so Windows checkouts don't get corrupted into CRLF.
