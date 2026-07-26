# Getting it onto another machine

Two different jobs, and only the first one works today.

**Moving a working copy** is a clone plus two commands, and you still start the
app from a terminal. That is verified — it is how the app runs here.

**Packaging** turns it into a double-click `.exe` with no console attached.
Nothing in the repo does that yet: there is no `electron-builder`, no
`electron-forge`, no `build` config anywhere. Everything in the second half of
this document is a plan, not a recipe that has been run.

## What `out/` actually is

`npm run build -w @todo-vault/desktop` produces about 1.2 MB:

| | |
|---|---|
| `out/main/index.js` | ~446 kB — the main process, with `todo-vault` bundled in |
| `out/preload/index.js` | ~4 kB — CJS, because a sandboxed preload cannot be ESM |
| `out/renderer/` | ~770 kB JS + ~24 kB CSS, plus `index.html` |

That is *only* the application code. It needs Electron's ~350 MB runtime around
it, which is not in the repo and is not in `out/`. This is the whole reason a
copied folder cannot just be double-clicked, and the whole reason packaging is a
real step rather than a flag.

`out/` is gitignored, so it never travels with a clone. Neither does
`node_modules/`. Both are rebuilt on the far end.

## Moving a working copy

On the new machine:

```bash
winget install OpenJS.NodeJS     # Node 24.18.0 is what this is built against
git clone <your remote>
cd files
npm install                      # seconds; Electron is not fetched yet
npm run build                    # first run downloads Electron, ~350 MB
npm run dev
```

**Electron downloads on first `require()`, not on install.** Electron 43
declares no install script, so `npm install` finishes fast and the first build
pauses to fetch the runtime. That is what `ensure-electron` — wired to `predev`
and `prebuild` — is forcing. The zip is cached in
`%LOCALAPPDATA%\electron\Cache`, so a second project on the same machine
extracts from cache instead of re-downloading.

**Copying the folder instead of cloning is fine**, as long as you exclude
`node_modules/` and `apps/desktop/out/`. A zip preserves bytes exactly, so line
endings are safe; a git transfer is safe too, because `.gitattributes` pins
`eol=lf`. Without that pin git would check files out as CRLF on Windows, the app
would rewrite them as LF, and every vault file would read as wholly modified.

### Three things that do not travel

**The vault.** It is its own git repository and the code repo gitignores
`/vault/`, so a clone gives you the app with no data in it. Copy the vault
folder separately, or point the first-run picker at a new one. If the point of
the exercise is testing in a real working environment, decide this deliberately
rather than discovering it on the far end.

**The Anthropic API key.** It is encrypted with Electron's `safeStorage`, which
on Windows is DPAPI — bound to your user account on this machine. There is no
getter on the IPC surface and no export path, by design. Re-enter it in
Settings → Claude on the new machine.

**Which vault was last open.** That lives in `settings.json` under
`app.getPath('userData')`, which is per-machine, so a fresh machine gets the
first-run picker.

### One thing worth checking on arrival

**Git needs to be on PATH** for history to accrue. `Vault.commit()` shells out
with `cwd` set to the vault root, and it is non-fatal by design — a machine
without git accepts every write and silently keeps no history. The sidebar's
"history on / history off" dot reports the truth, and `vault git-status` says it
in more detail. Check it once rather than assuming.

## Packaging: the next steps

### What you get to choose

| Target | Shape | Good for |
|---|---|---|
| **Portable `.exe`** | One file, double-click, installs nothing | Copying to a test machine to see how it feels |
| **NSIS installer** | Start Menu entry, desktop shortcut, uninstaller | Actually living in it |

They are nearly the same configuration, so build both from one config rather
than choosing now.

### The work, in order

1. **Add the tool.** `npm i -D electron-builder -w @todo-vault/desktop`.
2. **Write `apps/desktop/electron-builder.yml`** — `appId`, `productName`, and
   `files` covering `out/**`. The `main` field in `package.json` already points
   at `out/main/index.js`, so the entry point needs no change.
3. **Resolve the external dependencies.** See below; this is the step most
   likely to bite.
4. **Add an icon.** There is no `.ico` anywhere in the tree today, so a build
   made now would ship with the stock Electron icon.
5. **Add a `dist` script** and confirm a build runs clean.
6. **Launch the packaged app on a machine that has never had Node installed.**
   This is the only test that proves anything — a packaged app that quietly
   falls back to something present only on a developer machine looks fine
   everywhere except where it matters.

### Friction point 1: hoisted workspace dependencies

`electron.vite.config.ts` deliberately leaves third-party dependencies external
and bundles only the workspace core:

```ts
externalizeDepsPlugin({ exclude: ["todo-vault"] })
```

So `chokidar` and `@anthropic-ai/sdk` — and `zod`, `yaml` and the MCP SDK
underneath the core — are `require`d from `node_modules` at runtime rather than
being compiled in. In an npm workspace those are hoisted to the **root**
`node_modules`, not `apps/desktop/node_modules`, and electron-builder packs
relative to the app directory. This is the most likely thing to need fixing
before a packaged build will start.

Three ways out, roughly in order of preference:

- Let electron-builder resolve the hoisted layout (it understands workspaces),
  and only intervene if the packaged app throws `Cannot find module`.
- Bundle the externals too, by narrowing what `externalizeDepsPlugin` keeps
  external. Cleanest result — one file, nothing to resolve — but it needs
  checking that none of them depend on being real files on disk.
- Ship `node_modules` explicitly via the `files` globs. Works, and it is the
  least tidy.

`todo-vault: "*"` is a workspace symlink but is already bundled into
`out/main/index.js`, so it does not need to survive packaging — worth making
sure electron-builder does not try to pack the symlink anyway.

### Friction point 2: the first run inside a package

`suggestedVault()` probes three paths to offer the example vault on the Welcome
screen:

```
<appPath>/../../vault
<appPath>/../../../vault
<cwd>/vault
```

All three are repo-shaped. In a packaged app `getAppPath()` points inside
`resources/app.asar`, so none of them will match and the function returns
`null`. It degrades rather than breaking — the picker simply offers no shortcut
— but a packaged first run should probably suggest something better, such as a
vault under `app.getPath('documents')`, with an offer to initialise it.

### Two things to expect, neither of them bugs

**SmartScreen will flag it.** "Windows protected your PC" → More info → Run
anyway. Code signing is the only fix and it costs real money annually. Fine for
your own machines; worth knowing before you hand the file to anyone else.

**There is no auto-update.** Every new version means copying the file across
again. Perfectly reasonable while testing; `electron-updater` is the answer if
that ever stops being true.

## Checklist for when we do this

- [ ] `electron-builder` added to `apps/desktop`
- [ ] `electron-builder.yml` with portable + NSIS targets
- [ ] External dependencies resolved — packaged app starts with no `Cannot find module`
- [ ] An `.ico`, so it is not the stock Electron icon
- [ ] `suggestedVault()` given a sensible packaged-app default
- [ ] Built app launched on a machine with no Node installed
- [ ] A vault created from scratch through the picker, not just opened
- [ ] The API key entered and used once, to confirm `safeStorage` works in a packaged context
