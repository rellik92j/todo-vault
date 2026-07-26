#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

import { Vault, VaultError } from "./vault.js";
import { buildPushPlan, loadJiraMap, toJiraCsv } from "./jira.js";
import { STATUSES, type Item, type Status } from "./schema.js";
import { formatZodError, todayIso } from "./util.js";

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) {
        flags[name] = inline;
      } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        flags[name] = argv[i + 1];
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      _.push(arg);
    }
  }
  return { _, flags };
}

function str(flags: Args["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

const HELP = `todo-vault — a local, Jira-shaped task vault

Usage: vault <command> [options]

  init [dir]                        Create a new vault (default: ./vault)
  doctor                            Validate every file and report problems
  projects                          List projects
  project new KEY "Name"            Create a project
  project set KEY --name "..."      Update project fields
  project rename OLD NEW            Change the key, re-keying every item
  project reorder KEY --before K    Reorder the project list by hand
  project move ITEM TARGET          Move an item + subtree to another project
  project hide KEY                  Drop it from the desktop app's sidebar
  project unhide KEY                Put it back
  project delete KEY [--cascade]    Trash a project
  project restore FILE              Restore a trashed project
  new --project KEY --summary "..." Create an item
  list                              List items
  show KEY                          Show one item with children and backlinks
  set KEY --status done             Update fields on an item
  done KEY                          Shorthand for --status done
  disregard KEY                     Close it as "not doing this"
  comment KEY "text"                Append a comment
  link KEY --url|--item|--file X    Attach a link
  attach KEY <path> [--no-copy]     Attach a file
  agenda [today|week|month]         What needs attention
  move KEY --after K --before K     Reorder by hand (rank)
  delete KEY [--cascade]            Move to .trash (recoverable)
  trash [--projects]                List trashed items, or trashed projects
  restore FILE                      Bring one back from .trash
  git-status                        Whether writes are being committed
  jira plan [--out plan.json]       Build a reviewable Jira push payload
  jira csv  [--out issues.csv]      Export for Jira's CSV importer

Global options:
  --vault <dir>   Vault location (default: $VAULT_DIR or ./vault)
  --git           Auto-commit every write
  --json          Machine-readable output

Item options for new/set:
  --type epic|story|task|bug|subtask   --status ${STATUSES.join("|")}
  --priority highest|high|medium|low|lowest
  --parent KEY      --category TEXT    --labels a,b,c
  --assignee NAME   --start YYYY-MM-DD --due YYYY-MM-DD
  --cadence daily|weekly|monthly|quarterly|none
  --estimate N      --description TEXT

List options:
  --sort work|rank  work = by urgency (default), rank = manual order
`;

/** [x] done, [-] disregarded, [>] in progress, [ ] still open. */
function itemLine(item: Item): string {
  const mark =
    item.status === "done"
      ? "x"
      : item.status === "disregard"
        ? "-"
        : item.status === "in_progress"
          ? ">"
          : " ";
  const due = item.dueDate ? ` due:${item.dueDate}` : "";
  const cad = item.cadence !== "none" ? ` @${item.cadence}` : "";
  const parent = item.parent ? ` ^${item.parent}` : "";
  return `[${mark}] ${item.key.padEnd(10)} ${item.type.padEnd(7)} ${item.summary}${due}${cad}${parent}`;
}

function fieldPatch(flags: Args["flags"]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const map: Record<string, string> = {
    summary: "summary",
    description: "description",
    type: "type",
    status: "status",
    priority: "priority",
    parent: "parent",
    category: "category",
    assignee: "assignee",
    reporter: "reporter",
    start: "startDate",
    due: "dueDate",
    cadence: "cadence",
  };
  for (const [flag, field] of Object.entries(map)) {
    const value = str(flags, flag);
    if (value !== undefined) patch[field] = value === "none" && field !== "cadence" ? null : value;
  }
  const labels = str(flags, "labels");
  if (labels !== undefined) patch.labels = labels.split(",").map((s) => s.trim()).filter(Boolean);
  const estimate = str(flags, "estimate");
  if (estimate !== undefined) patch.estimate = Number(estimate);
  return patch;
}

async function main(): Promise<void> {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const command = _[0];
  const sub = _[1];

  if (!command || command === "help" || flags.help) {
    process.stdout.write(HELP);
    return;
  }

  const vaultDir = str(flags, "vault") ?? process.env.VAULT_DIR ?? "./vault";
  const asJson = flags.json === true;
  const options = { git: flags.git === true };

  if (command === "init") {
    const target = _[1] ?? vaultDir;
    const vault = await Vault.init(target, options);
    process.stdout.write(`Vault ready at ${vault.root}\n`);
    process.stdout.write(`Next: vault project new ACME "Acme rollout" --vault ${target}\n`);
    return;
  }

  const vault = await Vault.open(vaultDir, options);

  switch (command) {
    case "doctor": {
      const { items, projects, errors } = await vault.load();
      process.stdout.write(`${projects} projects, ${items} items loaded from ${vault.root}\n`);
      const dangling: string[] = [];
      for (const item of vault.listItems({ limit: 500 }).items) {
        if (item.parent && !vault.hasItem(item.parent)) {
          dangling.push(`${item.key} points at missing parent ${item.parent}`);
        }
        for (const link of item.links) {
          if (link.type === "item" && !vault.hasItem(link.target)) {
            dangling.push(`${item.key} links to missing item ${link.target}`);
          }
          if (link.type === "file" && path.isAbsolute(link.target)) {
            try {
              await fs.access(link.target);
            } catch {
              dangling.push(`${item.key} links to a file that no longer exists: ${link.target}`);
            }
          }
        }
      }
      const problems = [...errors, ...dangling];
      if (!problems.length) {
        process.stdout.write("No problems found.\n");
      } else {
        process.stdout.write(`\n${problems.length} problem(s):\n`);
        for (const p of problems) process.stdout.write(`  - ${p}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case "projects": {
      const projects = vault.listProjects();
      if (asJson) {
        process.stdout.write(`${JSON.stringify(projects, null, 2)}\n`);
        return;
      }
      if (!projects.length) {
        process.stdout.write("No projects yet. Try: vault project new ACME \"Acme rollout\"\n");
        return;
      }
      for (const p of projects) {
        const open = vault.listItems({ project: p.key, open: true, limit: 500 }).total;
        // Hidden ones are still listed — hiding is the desktop app's business,
        // not the vault's — but silently listing them identically would make
        // "why is this not in the sidebar" unanswerable from here.
        const hidden = p.status === "archived" ? " [hidden]" : "";
        process.stdout.write(`${p.key.padEnd(8)} ${p.name} (${open} open)${hidden}\n`);
      }
      return;
    }

    case "project": {
      switch (sub) {
        case "new": {
          const key = _[2];
          const name = _[3];
          if (!key || !name) throw new VaultError('Usage: vault project new KEY "Name"');
          const project = await vault.createProject({
            key,
            name,
            description: str(flags, "description"),
            category: str(flags, "category"),
            lead: str(flags, "lead"),
            startDate: str(flags, "start"),
            dueDate: str(flags, "due"),
            jiraProjectKey: str(flags, "jira"),
          });
          process.stdout.write(`Created project ${project.key}\n`);
          return;
        }

        case "set": {
          const key = _[2];
          if (!key) throw new VaultError("Usage: vault project set KEY --name ... --lead ...");
          const patch: Record<string, unknown> = {};
          for (const [flag, field] of Object.entries({
            name: "name",
            description: "description",
            category: "category",
            lead: "lead",
            start: "startDate",
            due: "dueDate",
            status: "status",
            jira: "jiraProjectKey",
          })) {
            const value = str(flags, flag);
            if (value !== undefined) {
              patch[field] = value === "none" && field !== "name" ? null : value;
            }
          }
          const updated = await vault.updateProject(key, patch);
          process.stdout.write(`Updated project ${updated.key}\n`);
          return;
        }

        case "rename": {
          const from = _[2];
          const to = _[3];
          if (!from || !to) throw new VaultError("Usage: vault project rename OLD NEW");
          const before = vault.listItems({ project: from, limit: 500 }).total;
          const renamed = await vault.renameProject(from, to);
          process.stdout.write(`Renamed ${from} to ${renamed.key}, re-keying ${before} item(s)\n`);
          if (before) {
            process.stdout.write(
              `Note: anything outside the vault that quoted a ${from}- key still says ${from}-.\n`,
            );
          }
          return;
        }

        case "move": {
          const key = _[2];
          const target = _[3];
          if (!key || !target) {
            throw new VaultError("Usage: vault project move ITEM-KEY TARGET-PROJECT [--parent KEY]");
          }
          const parentFlag = str(flags, "parent");
          const result = await vault.moveItemsToProject(key, target, {
            parent: parentFlag === "none" ? null : parentFlag,
          });
          for (const { from, to } of result.rekeyed) {
            process.stdout.write(`${from} -> ${to}\n`);
          }
          if (result.parentDropped) {
            process.stdout.write(
              `Note: parent ${result.parentDropped} stayed in the old project, so the link was dropped.\n`,
            );
          }
          return;
        }

        case "reorder": {
          const key = _[2];
          if (!key) {
            throw new VaultError("Usage: vault project reorder KEY [--after KEY] [--before KEY]");
          }
          const moved = await vault.moveProject(key, {
            after: str(flags, "after"),
            before: str(flags, "before"),
          });
          process.stdout.write(`${moved.key} now ranked ${moved.rank}\n`);
          for (const p of vault.listProjects()) {
            process.stdout.write(`  ${p.key.padEnd(8)} ${p.name}\n`);
          }
          return;
        }

        case "hide": {
          const key = _[2];
          if (!key) throw new VaultError("Usage: vault project hide KEY");
          const hidden = await vault.hideProject(key);
          process.stdout.write(
            `Hid project ${hidden.key}. It is still here and still listed by 'vault projects' — ` +
              `only the desktop app's sidebar drops it. Undo with: vault project unhide ${hidden.key}\n`,
          );
          return;
        }

        case "unhide": {
          const key = _[2];
          if (!key) throw new VaultError("Usage: vault project unhide KEY");
          const shown = await vault.unhideProject(key);
          process.stdout.write(`Project ${shown.key} is visible again, with status ${shown.status}.\n`);
          return;
        }

        case "delete": {
          const key = _[2];
          if (!key) throw new VaultError("Usage: vault project delete KEY [--cascade]");
          const result = await vault.deleteProject(key, { cascade: flags.cascade === true });
          process.stdout.write(`Trashed project ${result.key} -> ${result.trashedTo}\n`);
          for (const item of result.items) {
            process.stdout.write(`  ${item.key} -> ${item.trashedTo}\n`);
          }
          return;
        }

        case "restore": {
          const file = _[2];
          if (!file) {
            throw new VaultError("Usage: vault project restore FILE  (see: vault trash --projects)");
          }
          const project = await vault.restoreProject(file);
          process.stdout.write(
            `Restored project ${project.key}. Its items are still in the trash — restore them with: vault trash\n`,
          );
          return;
        }

        default:
          throw new VaultError(
            "Usage: vault project new|set|rename|reorder|move|hide|unhide|delete|restore — see: vault help",
          );
      }
    }

    case "new": {
      const item = await vault.createItem({
        project: str(flags, "project"),
        type: str(flags, "type") ?? "task",
        summary: str(flags, "summary") ?? _[1],
        description: str(flags, "description") ?? "",
        ...fieldPatch(flags),
      });
      process.stdout.write(asJson ? `${JSON.stringify(item, null, 2)}\n` : `${item.key}\n`);
      return;
    }

    case "list": {
      const { total, items } = vault.listItems({
        project: str(flags, "project"),
        type: str(flags, "type") as never,
        status: str(flags, "status") as never,
        cadence: str(flags, "cadence") as never,
        category: str(flags, "category"),
        label: str(flags, "label"),
        parent: str(flags, "parent"),
        text: str(flags, "text"),
        open: flags.open === true ? true : undefined,
        sort: str(flags, "sort") as never,
        limit: Number(str(flags, "limit") ?? 100),
      });
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ total, items }, null, 2)}\n`);
        return;
      }
      for (const item of items) process.stdout.write(`${itemLine(item)}\n`);
      process.stdout.write(`\n${items.length} of ${total} shown\n`);
      return;
    }

    case "show": {
      const item = vault.getItem(_[1]);
      if (asJson) {
        process.stdout.write(`${JSON.stringify(item, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${item.key}  ${item.summary}\n`);
      process.stdout.write(`${"-".repeat(60)}\n`);
      process.stdout.write(`type      ${item.type}\nstatus    ${item.status}\npriority  ${item.priority}\n`);
      if (item.parent) process.stdout.write(`parent    ${item.parent}\n`);
      if (item.category) process.stdout.write(`category  ${item.category}\n`);
      if (item.startDate) process.stdout.write(`start     ${item.startDate}\n`);
      if (item.dueDate) process.stdout.write(`due       ${item.dueDate}\n`);
      if (item.cadence !== "none") process.stdout.write(`cadence   ${item.cadence}\n`);
      if (item.labels.length) process.stdout.write(`labels    ${item.labels.join(", ")}\n`);
      if (item.sync.jiraKey) process.stdout.write(`jira      ${item.sync.jiraKey} (${item.sync.state})\n`);
      if (item.description) process.stdout.write(`\n${item.description}\n`);

      for (const link of item.links) {
        process.stdout.write(`\nlink      ${link.type}: ${link.label ?? link.target}`);
      }
      for (const att of item.attachments) {
        process.stdout.write(`\nattach    ${att.path}`);
      }
      if (item.links.length || item.attachments.length) process.stdout.write("\n");

      const kids = vault.children(item.key);
      if (kids.length) {
        process.stdout.write(`\nChildren:\n`);
        for (const k of kids) process.stdout.write(`  ${itemLine(k)}\n`);
      }
      const back = vault.backlinks(item.key);
      if (back.length) {
        process.stdout.write(`\nReferenced by:\n`);
        for (const b of back) process.stdout.write(`  ${b.key}  ${b.summary}\n`);
      }
      for (const c of item.comments) {
        process.stdout.write(`\n${c.author} at ${c.at}:\n  ${c.body}\n`);
      }
      return;
    }

    case "set": {
      const item = await vault.updateItem(_[1], fieldPatch(flags));
      process.stdout.write(`${item.key} updated -> ${item.status}\n`);
      return;
    }

    case "done": {
      const item = await vault.transition(_[1], "done" as Status);
      process.stdout.write(`${item.key} done\n`);
      return;
    }

    case "disregard": {
      const item = await vault.transition(_[1], "disregard" as Status);
      process.stdout.write(`${item.key} disregarded\n`);
      return;
    }

    case "comment": {
      const item = await vault.addComment(_[1], _.slice(2).join(" "));
      process.stdout.write(`Comment added to ${item.key}\n`);
      return;
    }

    case "link": {
      const key = _[1];
      const types = ["url", "item", "file", "folder", "outlook", "note"] as const;
      const found = types.find((t) => typeof flags[t] === "string");
      if (!found) throw new VaultError(`Specify one of: ${types.map((t) => `--${t}`).join(", ")}`);
      const item = await vault.addLink(key, {
        type: found,
        target: flags[found] as string,
        label: str(flags, "label"),
      });
      process.stdout.write(`${item.key} now has ${item.links.length} link(s)\n`);
      return;
    }

    case "attach": {
      const item = await vault.addAttachment(_[1], _[2], {
        copy: flags["no-copy"] !== true,
        title: str(flags, "title"),
      });
      process.stdout.write(
        `${item.key}: ${item.attachments.length} attachment(s), ${item.links.filter((l) => l.type === "file").length} file link(s)\n`,
      );
      return;
    }

    case "agenda": {
      const scope = (_[1] ?? "today") as "today" | "week" | "month";
      const sections = vault.agenda(scope);
      if (asJson) {
        process.stdout.write(`${JSON.stringify(sections, null, 2)}\n`);
        return;
      }
      for (const section of sections) {
        const label =
          section.kind === "overdue"
            ? `Overdue as of ${todayIso()}`
            : section.kind === "recurring"
              ? `Recurring this ${section.scope === "today" ? "day" : section.scope}`
              : `Due this ${section.scope === "today" ? "day" : section.scope} (${section.from} to ${section.to})`;
        process.stdout.write(`\n${label}\n${"-".repeat(label.length)}\n`);
        if (!section.items.length) process.stdout.write("  nothing\n");
        for (const item of section.items) process.stdout.write(`  ${itemLine(item)}\n`);
      }
      process.stdout.write("\n");
      return;
    }

    case "move": {
      const key = _[1];
      if (!key) throw new VaultError("Usage: vault move KEY [--after KEY] [--before KEY]");
      const moved = await vault.moveItem(key, {
        after: str(flags, "after"),
        before: str(flags, "before"),
      });
      process.stdout.write(`${moved.key} now ranked ${moved.rank}\n`);
      return;
    }

    case "delete": {
      const key = _[1];
      if (!key) throw new VaultError("Usage: vault delete KEY [--cascade]");
      const results = await vault.deleteItem(key, { cascade: flags.cascade === true });
      if (asJson) {
        process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
        return;
      }
      for (const r of results) {
        process.stdout.write(`Trashed ${r.key} -> ${r.trashedTo}\n`);
        if (r.attachmentsTrashedTo) {
          process.stdout.write(`  attachments -> ${r.attachmentsTrashedTo}\n`);
        }
        for (const source of r.danglingBacklinks) {
          process.stdout.write(`  warning: ${source} still links to ${r.key}\n`);
        }
      }
      process.stdout.write(`\nRecover with: vault restore ${path.basename(results[0].trashedTo)}\n`);
      return;
    }

    case "trash": {
      const projectsOnly = flags.projects === true;
      const entries = projectsOnly ? await vault.listTrashedProjects() : await vault.listTrash();
      if (asJson) {
        process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
        return;
      }
      if (!entries.length) {
        process.stdout.write(projectsOnly ? "No trashed projects.\n" : "Trash is empty.\n");
        return;
      }
      for (const e of entries) {
        const attach = e.hasAttachments ? " (+attachments)" : "";
        process.stdout.write(`${e.key.padEnd(10)} ${e.summary ?? "(unreadable)"}${attach}\n`);
        process.stdout.write(`${" ".repeat(11)}${e.file}\n`);
      }
      return;
    }

    case "restore": {
      const file = _[1];
      if (!file) throw new VaultError("Usage: vault restore FILE  (see: vault trash)");
      const item = await vault.restoreItem(file);
      process.stdout.write(`Restored ${item.key}: ${item.summary}\n`);
      return;
    }

    case "git-status": {
      const status = await vault.gitStatus();
      if (asJson) {
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return;
      }
      process.stdout.write(`auto-commit  ${status.enabled ? "requested" : "off (no --git)"}\n`);
      process.stdout.write(`git present  ${status.gitAvailable ? "yes" : "no"}\n`);
      process.stdout.write(`is a repo    ${status.isRepo ? "yes" : `no — run: git init ${vault.root}`}\n`);
      if (status.repoRoot) {
        const nested = status.repoRoot !== vault.root ? "  (the vault is nested inside it)" : "";
        process.stdout.write(`history in   ${status.repoRoot}${nested}\n`);
      }
      if (status.ignored) {
        process.stdout.write(`ignored      yes — that repo ignores this vault, so nothing is committed\n`);
      }
      if (status.lastCommit) {
        process.stdout.write(`last commit  ${status.lastCommit.hash} ${status.lastCommit.subject}\n`);
      }
      if (status.lastError) {
        process.stdout.write(`last error   ${status.lastError}\n`);
      }
      process.stdout.write(
        `\n${
          status.healthy
            ? "Writes are being committed. Undo is available."
            : "Writes are NOT being committed. Deletes are still recoverable from .trash."
        }\n`,
      );
      if (!status.healthy) process.exitCode = 1;
      return;
    }

    case "jira": {
      const mapPath = str(flags, "map") ?? path.join(vault.root, "jira-map.yaml");
      const map = await loadJiraMap(mapPath);
      const { items } = vault.listItems({
        project: str(flags, "project"),
        open: flags.all === true ? undefined : true,
        limit: 500,
      });

      if (sub === "csv") {
        const csv = toJiraCsv(items, map);
        const out = str(flags, "out");
        if (out) {
          await fs.writeFile(out, csv, "utf8");
          process.stdout.write(`Wrote ${items.length} rows to ${out}\n`);
        } else {
          process.stdout.write(`${csv}\n`);
        }
        return;
      }

      const plan = buildPushPlan(items, map, vault);
      const out = str(flags, "out");
      if (out) {
        await fs.writeFile(out, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      } else if (asJson) {
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        return;
      }

      process.stdout.write(
        `Plan for Jira project ${plan.jiraProjectKey}: ${plan.drafts.length} issue(s) to create\n`,
      );
      for (const draft of plan.drafts) {
        const parent = draft.parentLocalKey ? ` (after ${draft.parentLocalKey})` : "";
        process.stdout.write(`  ${draft.localKey}  ${draft.fields.summary as string}${parent}\n`);
      }
      for (const s of plan.skipped) process.stdout.write(`  skip ${s.localKey}: ${s.reason}\n`);
      for (const w of plan.warnings) process.stdout.write(`  warn ${w}\n`);
      if (out) process.stdout.write(`\nWrote plan to ${out}. Review it before pushing.\n`);
      return;
    }

    default:
      throw new VaultError(`Unknown command '${command}'. Run \`vault help\` for the list.`);
  }
}

main().catch((err) => {
  const message = err instanceof VaultError ? err.message : formatZodError(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
