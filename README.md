# todo-vault

A local, Jira-shaped task tracker that lives in plain markdown files, so the
desktop app, an in-app assistant, and any Claude on the outside can all read and
write the same data without a server.

Phases 1, 2, and 5 of the plan: schema, vault core, CLI, and MCP server. The
desktop UI comes next and sits on top of `Vault` without changing any of this.

## Quick start

```bash
npm install
npm run build

npx tsx src/cli.ts init ./vault
npx tsx src/cli.ts project new ACME "Acme platform rollout" --vault ./vault
npx tsx src/cli.ts new --vault ./vault --project ACME --type epic --summary "Migrate reporting"
npx tsx src/cli.ts agenda week --vault ./vault
```

Set `VAULT_DIR` to skip `--vault` everywhere. Add `--git` to auto-commit every
write, which gives you undo and a full audit trail for free.

A worked example vault is included at `./vault` — two projects, an epic with
stories, tasks, a subtask and a bug, recurring daily/weekly/monthly items, and
examples of every link type. Rebuild it from scratch at any time:

```bash
npx tsx scripts/seed-vault.ts ./vault --force
```

It is also the fixture the desktop UI is developed against. `--force` clears the
vault's contents but leaves its `.git` alone, so history survives a reset.

## Commands

```
init [dir]                        Create a vault
doctor                            Validate every file, find dangling links
projects                          List projects with open counts
project new KEY "Name"            Create a project
project set KEY --name "..."      Update project fields
project rename OLD NEW            Change the key, re-keying every item
project reorder KEY --before K    Reorder the project list by hand
project move ITEM TARGET          Move an item + subtree to another project
project delete KEY [--cascade]    Trash a project
project restore FILE              Restore a trashed project
new --project KEY --summary "..." Create an item
list [--project --status --open]  List items
show KEY                          Full item, children, backlinks, comments
set KEY --status done --due DATE  Update fields
done KEY                          Shorthand
comment KEY "text"                Append to the running log
link KEY --url|--item|--outlook X Link arbitrary content
attach KEY <path> [--no-copy]     Attach a file
agenda [today|week|month]         What needs attention
move KEY --after K --before K     Reorder by hand
delete KEY [--cascade]            Move to .trash, recoverable
trash                             List what is in .trash
restore FILE                      Bring one back
git-status                        Whether writes are being committed
jira plan [--out plan.json]       Reviewable push payload
jira csv  [--out issues.csv]      For Jira's CSV importer
```

`list --sort rank` gives the manual order; the default `--sort work` gives the
derived one (overdue, due date, priority). Deletes go to `.trash/` rather than
being unlinked, so recovery does not depend on git being set up — run
`git-status` to see whether it actually is.

## Wiring up Claude

The MCP server exposes the vault over stdio. Add it to Claude Desktop's config
(`claude_desktop_config.json`) or your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "todo-vault": {
      "command": "node",
      "args": ["/absolute/path/to/todo-vault/dist/mcp-server.js"],
      "env": {
        "VAULT_DIR": "/absolute/path/to/your/vault",
        "VAULT_GIT": "1"
      }
    }
  }
}
```

Then, from any Claude session: *"what's due this week"*, *"add a task to chase
the vendor SOW, due Friday, under the migration epic"*, *"mark ACME-12 done and
note that legal signed off"*.

Twenty-three tools are registered:

| Tool | |
|---|---|
| `vault_list_items` | Filtered list, compact projection |
| `vault_get_item` | Full record plus children and backlinks |
| `vault_get_agenda` | Overdue, due, and recurring, kept separate |
| `vault_list_projects` | Portfolio view, in manual order |
| `vault_create_item` | Create, with hierarchy validation |
| `vault_update_item` | Patch fields |
| `vault_transition_item` | Move through the workflow |
| `vault_move_item` | Reorder by hand within a project |
| `vault_add_comment` | Append to the log |
| `vault_link_item` | Link a URL, file, item, or Outlook message |
| `vault_attach_file` | Copy in, or point at in place |
| `vault_delete_item` | To `.trash/`, recoverable |
| `vault_restore_item` | Back out of `.trash/` |
| `vault_list_trash` | What is recoverable |
| `vault_create_project` | New project |
| `vault_update_project` | Patch project fields |
| `vault_rename_project` | Change the key, re-keying every item |
| `vault_reorder_project` | Reorder the project list |
| `vault_move_item_to_project` | Move an item and its subtree across |
| `vault_delete_project` | To `.trash/projects/`, recoverable |
| `vault_restore_project` | Back out of `.trash/projects/` |
| `vault_plan_jira_push` | Build a reviewable payload. Sends nothing. |
| `vault_mark_pushed` | Record a completed push |

The destructive ones are marked `destructiveHint` and refuse rather than guess:
deleting something with children, or a project with items, returns an error
listing what is in the way instead of taking it along.

Because the vault is plain markdown, a Claude with only filesystem access can
already read and edit it. The MCP server adds schema validation, key allocation,
and hierarchy rules on top — worth having, but not a hard dependency.

The MCP surface, the CLI, and `Vault` all cover the same operations, so nothing
is reachable from one and not the others.

## Pushing to Jira

Push only. The vault is upstream of Jira, never a mirror of it.

```bash
cp jira-map.example.yaml vault/jira-map.yaml
# fill in your instance's custom field ids — see the comments in the file
npx tsx src/cli.ts jira plan --vault ./vault --out plan.json
```

`plan.json` contains ordered issue drafts with descriptions already converted to
Atlassian Document Format. Parents are sequenced before their children. Items
already pushed and unchanged are skipped. Review it, POST it, then call
`vault_mark_pushed` (or `Vault.markPushed`) so drift detection has a baseline.

Nothing in this repo makes a network call. The actual POST is deliberately left
to you, so an offline vault stays offline until you decide otherwise.

The part that always bites: **every Jira instance names its fields
differently**. Start date is a custom field with a different id on every site.
Run this against your instance and search the output before filling in the map:

```
GET /rest/api/3/field
GET /rest/api/3/issue/createmeta?projectKeys=ENG&expand=projects.issuetypes.fields
```

If `fields.startDate` is missing from your map, the plan warns rather than
silently dropping your dates.

## Tests

```bash
npx tsx --test test/vault.test.ts
```

Thirty-six tests covering key allocation, disk round-trips, frontmatter
stability, hierarchy rules, transition validation, backlinks, attachments,
agenda sectioning, ADF conversion, push ordering, drift detection, manual
reordering of both items and projects, trash and restore, project rename and
cross-project moves, path portability, and git health reporting.

## What is not here yet

- **Desktop shell** (phases 3–4). Tauri or Electron over `Vault`. Board view,
  backlog table, item detail, drag and drop.
- **In-app Claude** (phase 6). One line of text to a filled draft, using the
  Messages API with tool-use for structured output, validated against
  `CreateItemInput`, shown as a preview before it writes.
- **Live file watching.** `Vault.load()` is cheap and rebuilds the whole index;
  wire it to chokidar so the UI updates when an external Claude writes a file.
- **The actual Jira POST.** By design.

## Layout

```
src/
├── schema.ts       zod schema — the source of truth
├── markdown.ts     frontmatter with stable key ordering
├── util.ts         dates, hashing, atomic writes, rank arithmetic
├── vault.ts        core: load, validate, index, write atomically
├── jira.ts         field mapping, markdown→ADF, push plans
├── cli.ts          proves the core without a UI
├── mcp-server.ts   stdio MCP server
└── index.ts        public API for the desktop app

scripts/
└── seed-vault.ts   builds the worked example vault
```

Read `SCHEMA.md` before changing anything in `src/schema.ts`.
