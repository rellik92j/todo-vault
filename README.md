# todo-vault

A local, Jira-shaped task tracker that lives in plain markdown files.

Every task is a markdown file with YAML frontmatter. That one decision is what
lets a desktop app, a command line, and any Claude — inside the app or outside
it — all read and write the same data with no server, no database, and no sync
protocol. Your tasks stay files you own, greppable and diffable, and git gives
you history and undo for free.

It is shaped like Jira on purpose — epics, stories, tasks, bugs, subtasks, a
real status workflow, priorities, labels, links — so work can be pushed *up* to
Jira when it needs to be shared. The vault is always upstream; it is never a
mirror.

> **Status:** the vault core, CLI, MCP server and desktop app are built and in
> daily use. The Jira push builds a reviewable payload but does not POST it.
> See [`PLAN.md`](PLAN.md) for what was built and why, and
> [`IDEAS.md`](IDEAS.md) for what is being considered next.

---

## What you get

**A desktop app.** Backlog table with nested subtasks, a drag-and-drop board,
an agenda over six time scopes, a History view reading the git log back in vault
terms (`dueDate 2026-08-06 → 2026-08-19`, not a patch), and a detail panel where
every edit commits straight to the file — there is no save button and no draft state. Illegal
status moves are prevented rather than attempted and reported. Descriptions are
rich-text edited but stored as plain markdown. Recurring work is ticked off for
the current period rather than closed permanently. Press `?` for every keyboard
shortcut.

**A command line.** Everything the app does, plus diagnostics and exports.
Scriptable, and the fastest way to add a task without breaking flow.

**An MCP server.** Point Claude Desktop or Claude Code at the vault and ask it
in plain language: *"what's due this week"*, *"add a task to chase the vendor
SOW, due Friday, under the migration epic"*. Twenty-six tools, with schema
validation and hierarchy rules enforced on the way in.

**Optional AI drafting inside the app.** Add an Anthropic API key and the create
dialog takes a sentence and fills the form out for you to review before anything
is written.

**Git-backed history.** Pass `--git` and every write is auto-committed, which
gives you an audit trail and an undo that does not depend on the app being
running. Deletes go to `.trash/` regardless, so recovery never depends on git
being set up at all.

---

## Requirements

| | |
|---|---|
| **Node.js 20+** | Developed against 24. `node --version` to check. |
| **npm** | Ships with Node. The repo is an npm workspace. |
| **Git** *(recommended)* | Not required to run, but without it the vault keeps no history. |
| **~350 MB disk** | Electron's runtime, downloaded on first build and cached per-machine. |
| **An Anthropic API key** *(optional)* | Only for in-app AI drafting. Everything else works without one. |

Windows, macOS and Linux are all supported by the toolchain; the app is
developed and used on Windows.

New machine, step by step? See [`GETTING-STARTED.md`](GETTING-STARTED.md).

---

## Fastest path (Windows, nothing installed yet)

```powershell
irm https://raw.githubusercontent.com/rellik92j/todo-vault/main/scripts/bootstrap.ps1 | iex
```

Installs Node and Git via `winget` if either is missing, clones the repo, runs
`npm install`, and opens the menu — all in one run, in the terminal you already
have open. This fetches and runs a script from this repo over the network — read
[`scripts/bootstrap.ps1`](scripts/bootstrap.ps1) first if that's a concern; it is
mostly comments explaining itself.

It asks one question, and only on a machine that needs it. Windows ships
PowerShell set to refuse scripts, and `npm` is one — typing it runs `npm.ps1`,
so every `npm` command on this page fails with a security error that names a
file you've never heard of. The script offers to switch **your account** (not
the machine) to `RemoteSigned`, which is the standard fix and needs no
administrator rights. Decline and it still finishes; only your own `npm`
commands afterwards stay blocked.

Already have Node and Git? The quick start below skips straight to a clone.

---

## Quick start - set up a test vault with pre-loaded examples. 

```bash
git clone https://github.com/rellik92j/todo-vault.git
cd todo-vault
npm install
npm run build          # first run downloads Electron (~350 MB, cached after)
npm run seed -- ./vault
npm run dev
```

That builds the core, creates a worked example vault, and launches the app
against it.

The example vault is three projects and fifteen items — an epic with stories,
tasks, a subtask and a bug, recurring daily/weekly/monthly items, every link
type, both ways an item can close, a hidden project, and one item already pushed
to Jira. It is also the fixture the UI is developed against. Rebuild it any time
with `npm run seed -- ./vault --force`, which clears the contents but leaves
`.git` alone, so history survives a reset.

---

## Running it: the menu **Main way to begin**

```bash
npm run menu
```

A numbered launcher for everything below. Pick an option with a **single
keypress** — no Enter, no remembering script names — and it returns to the menu
when the command finishes.

```
  todo-vault — workspace commands
  ──────────────────────────────────────────────────────────

  Run
   [1] Dev app                          builds core, then Vite dev server + HMR
   [2] Prod preview                     builds core, then production bundles
   [3] Prod preview (reuse last build)  launches without rebuilding
   [4] MCP server                       stdio server over the vault

  Check
   [5] Test                             both workspaces
   [6] Typecheck                        both workspaces, plus these scripts
   [7] Build                            both workspaces

  Vault
   [8] Vault CLI…                       asks for arguments, e.g. agenda week
   [9] Doctor                           validate every file and report problems
   [S] Seed example vault               the worked example; overwriting asks first

  Setup
   [U] Update                           git pull --ff-only, reinstall, rebuild core
   [I] Install dependencies             npm install only — no pull, no build
   [C] Connect Claude…                  prints the MCP config, paths filled in

   [0] Exit

  ──────────────────────────────────────────────────────────
  Choose an option (single keypress, Ctrl+C to quit):
```

Almost every option runs one npm script. Where a command is really a sequence it
is the script that encodes it, not the menu: **Prod preview** has to build the
core *before* launching, or you get a freshly built desktop bundle wrapped around
whatever `packages/core/dist` happened to contain last time — an app that looks
clean and carries a stale core. `npm run preview` holds that order for everyone,
including whoever never opens the menu.

Three options take input rather than running straight away. **[8] Vault CLI**
prompts for arguments and hands them to the CLI, quotes honoured, so
`new --project ENG --summary "Two words"` arrives intact. **[S] Seed** asks for a
target directory and requires you to type `FORCE` before it will overwrite an
existing vault, since that is not a recoverable action. **[C] Connect Claude**
asks which vault to point at and prints the config block below, and is the one
entry that runs no npm script at all — it composes text and displays it. It
never edits `claude_desktop_config.json`, because that file holds other servers,
credentials and preferences, and merging into it would reformat all of them to
add four lines.

`Ctrl+C` inside a running command — the dev server, the MCP server — stops that
command and returns you to the menu rather than killing both.

### Or run the scripts directly

| Command | What it does |
|---|---|
| `npm run dev` | Builds the core, launches the app with hot reload. Day-to-day editing. |
| `npm run build` | Builds both workspaces. |
| `npm run preview` | Builds the core, then the production preview. Closest to what ships. |
| `npm run preview:skip-build` | The same preview without rebuilding. Only correct if nothing changed. |
| `npm test` | Runs both workspaces' tests plus the launcher's own. |
| `npm run typecheck` | Both workspaces, plus `scripts/`. |
| `npm run vault -- <args>` | The vault CLI, from the repo root. |
| `npm run mcp` | The MCP server, over stdio. |
| `npm run seed -- <dir>` | Build the worked example vault. |
| `npm run menu` | The launcher above. |

---

## The CLI

The CLI runs from the repo root, so relative paths mean what they look like:

```bash
npm run vault -- agenda week --vault ./vault
```

The everyday ones:

```
new --project KEY --summary "..."   Create an item
list [--project --status --open]    List items
show KEY                            Full item, children, backlinks, comments
set KEY --status done --due DATE    Update fields
done KEY                            Shorthand for --status done
tick KEY [--on DATE] [--undo]       Recurring work: done for this period
agenda [SCOPE]                      What needs attention
history [KEY|PROJ]                  What changed, newest first, from the git log
comment KEY "text"                  Append to the running log
link KEY --url|--item|--file X      Link arbitrary content
delete KEY [--cascade]              Move to .trash, recoverable
doctor                              Validate every file, find dangling links
```

Plus `init`, `disregard`, `attach`, `move`, `trash`/`restore`, `git-status`, a
`project` group (create, rename, reorder, hide, move items between, delete) and
`jira plan`/`jira csv`. **Run `npm run vault` with no arguments for the complete
list**, including every field flag for `new` and `set`.

### Global options

| Flag | |
|---|---|
| `--vault <dir>` | Vault location. Defaults to `$VAULT_DIR`, then `./vault`. |
| `--git` | Auto-commit every write. The desktop app always passes this. |
| `--json` | Machine-readable output, for scripting. |

Set `VAULT_DIR` in your environment to stop passing `--vault` everywhere.

### Agenda scopes

`agenda` takes six, defaulting to `today`. Weeks run Monday to Sunday.

| Scope | |
|---|---|
| `today` `week` `nextWeek` | The calendar periods around now |
| `twoWeeks` | This week and next, as one fourteen-day window |
| `month` | The calendar month |
| `next30Days` | Thirty days rolling forward from today |

The last one matters on the 28th, when `month` has three days left in it. The
three long scopes subdivide their output — nearest first, two or three headings
whatever day it is — rather than printing one flat list. The app draws the same
bands.

**A few other flags worth knowing.** `list --sort rank` gives the manual order;
the default `--sort work` sorts by urgency (overdue, then due date, then
priority). `link` takes six kinds: `--url`, `--item`, `--file`, `--folder`,
`--outlook`, `--note`. `attach --no-copy` points at a file in place rather than
copying it in, which is what you want for anything living in OneDrive or
SharePoint.

---

## Wiring up Claude

The MCP server exposes the vault over stdio. `npm run menu` → **[C]** prints the
config below with this machine's paths already filled in, which is the way to do
this — the two placeholders are exactly the kind of thing that goes wrong
silently. Add it to Claude Desktop's `claude_desktop_config.json`, or to your
Claude Code MCP settings:

```json
{
  "mcpServers": {
    "todo-vault": {
      "command": "node",
      "args": ["/absolute/path/to/todo-vault/packages/core/dist/mcp-server.js"],
      "env": {
        "VAULT_DIR": "/absolute/path/to/your/vault",
        "VAULT_GIT": "1"
      }
    }
  }
}
```

That path is the *built* server, so `npm run build` has to have run. Point it at
a file that is not there and nothing announces it: Claude reports no error and
the vault tools simply never appear.

**Cowork needs nothing extra.** It has no MCP config of its own — it reads the
same `claude_desktop_config.json` and bridges local stdio servers into its VM
through Desktop, so the one entry covers both. Desktop has to be quit fully and
reopened for either to see it; the file is read at startup only, and closing to
the tray is not quitting.

Then, from any Claude session: *"what's due this week"*, *"add a task to chase
the vendor SOW, due Friday, under the migration epic"*, *"mark ACME-12 done and
note that legal signed off"*.

Twenty-six tools are registered, covering:

- **Reading** — filtered lists, a full record with children and backlinks, the
  agenda, and the project portfolio.
- **Writing** — create, update, transition through the workflow, tick recurring
  work, reorder, comment, link, and attach.
- **Projects** — create, update, rename (re-keying every item), reorder, hide,
  unhide, and move an item and its subtree across.
- **Recovery** — delete to `.trash/`, restore, and list what is recoverable.
- **Jira** — build a reviewable push payload, and record a completed push.

Destructive tools are marked `destructiveHint` and refuse rather than guess:
deleting something with children returns an error listing what is in the way
instead of taking it along.

Because the vault is plain markdown, a Claude with only filesystem access can
already read and edit it. The MCP server adds schema validation, key allocation
and hierarchy rules on top — worth having, but not a hard dependency.

The CLI and MCP surfaces cover the same ground on items and projects. A handful
of operations are one-sided — `doctor`, `git-status`, `history` and `jira csv`
are CLI-only (`history` is also a desktop view);
`vault_mark_pushed` is MCP-only; bulk edit and removing a link are desktop-only.

---

## Pushing to Jira

Push only. The vault is upstream of Jira, never a mirror of it.

```bash
cp jira-map.example.yaml vault/jira-map.yaml
# fill in your instance's custom field ids — see the comments in the file
npm run vault -- jira plan --vault ./vault --out plan.json
```

`plan.json` contains ordered issue drafts with descriptions already converted to
Atlassian Document Format. Parents are sequenced before their children, and
items already pushed and unchanged are skipped. Review it, POST it, then record
the push so drift detection has a baseline.

**Nothing in this repo makes a network call.** The actual POST is deliberately
left to you, so an offline vault stays offline until you decide otherwise.

The part that always bites: **every Jira instance names its fields
differently.** Start date is a custom field with a different id on every site.
Run these against your instance and search the output before filling in the map:

```
GET /rest/api/3/field
GET /rest/api/3/issue/createmeta?projectKeys=ENG&expand=projects.issuetypes.fields
```

If `fields.startDate` is missing from your map, the plan warns rather than
silently dropping your dates.

---

## Project layout

An npm workspace with two packages:

| | |
|---|---|
| `packages/core` | The vault: schema, read/write, CLI, MCP server, Jira planner |
| `apps/desktop` | The Electron app over it |

The core has no idea the app exists. The app holds no state the vault does not.

Inside the core, `schema.ts` is the source of truth — a zod schema every write
is validated against. `Vault` imports `node:fs`, so it lives in Electron's main
process and the renderer reaches it only through a `contextBridge` preload, with
`contextIsolation` on and `nodeIntegration` off. The app watches `items/` and
`projects/`, so an edit from the CLI, an external Claude, or Notepad shows up in
about a second without a refresh.

Read [`SCHEMA.md`](SCHEMA.md) before changing anything in
`packages/core/src/schema.ts`.

### Tests

```bash
npm test
```

Covers the core (key allocation, disk round-trips, frontmatter stability,
hierarchy and transition rules, recurrence periods, agenda sectioning, the
description grammar in both directions, ADF conversion, push ordering, drift
detection, trash and restore, atomic writes, bulk edit), the desktop app's pure
renderer logic (nesting, collapse, type filtering, board lanes, agenda bands,
multi-select ranges), and the launcher's argument tokenizer.

There is no CI yet — the suite is run by hand. See [`IDEAS.md`](IDEAS.md).

---

## Documentation

| | |
|---|---|
| [`GETTING-STARTED.md`](GETTING-STARTED.md) | Running it on a machine that has never seen it |
| [`SCHEMA.md`](SCHEMA.md) | The data model and the rules that hold it together |
| [`PLAN.md`](PLAN.md) | What was built, phase by phase, and why each call was made |
| [`IDEAS.md`](IDEAS.md) | Unscheduled ideas, newest first |
| [`PLAN-LINKS.md`](PLAN-LINKS.md) | The design for OneDrive-aware links |
| [`PACKAGING.md`](PACKAGING.md) | Moving a working copy, and the plan for a real `.exe` |

---

## License

MIT — see [`LICENSE`](LICENSE).
