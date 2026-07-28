/**
 * Builds the worked example vault the README describes: two projects, an epic
 * with stories, tasks, a subtask and a bug, recurring items at every cadence,
 * one of every link type, and a handful of reporters.
 *
 * Also the fixture the desktop UI is developed against, so it is a script rather
 * than a sequence of CLI calls — resetting to a known state should be one
 * command.
 *
 *   npm run seed -- ./vault
 *
 * Refuses to run over an existing vault unless --force is passed.
 *
 * `--force` is sharper than it looks. It clears items/, projects/, attachments/,
 * .trash and .counters.json, and it does *not* commit: `Vault.init` is called
 * without `git: true`, so nothing here writes history even when the target is a
 * git repo. Whatever was in the vault is recoverable only as far as its last
 * commit — anything written since is gone with no reflog entry to find it by.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Vault } from "../src/vault.js";
import { pathExists } from "../src/util.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const target = args.find((a) => !a.startsWith("-")) ?? "./vault";

/** Dates relative to today, so the agenda views always have something in them. */
function offset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const root = path.resolve(target);

  if (await pathExists(path.join(root, "items"))) {
    if (!force) {
      throw new Error(
        `A vault already exists at ${root}. Pass --force to delete and rebuild it.`,
      );
    }
    // Clear the contents, never the directory itself — removing the whole thing
    // takes the vault's .git and .gitattributes with it, which silently turns
    // off version history for every write that follows.
    for (const entry of ["items", "projects", "attachments", ".trash", ".counters.json"]) {
      await fs.rm(path.join(root, entry), { recursive: true, force: true });
    }
  }

  const vault = await Vault.init(root);
  // scripts/ -> packages/core -> packages -> repo root. The link fixtures below
  // point at real files, so these have to be right or `doctor` reports dangling
  // links on a freshly seeded vault.
  const coreRoot = path.resolve(import.meta.dirname, "..");
  const repoRoot = path.resolve(coreRoot, "../..");

  // ------------------------------------------------------------- projects
  await vault.createProject({
    key: "ACME",
    name: "Acme platform rollout",
    description: "Migrating the reporting stack off the legacy warehouse.",
    category: "Delivery",
    lead: "me",
    startDate: offset(-30),
    dueDate: offset(90),
    jiraProjectKey: "ENG",
  });

  await vault.createProject({
    key: "OPS",
    name: "Running the shop",
    description: "Recurring operational work that never really ends.",
    category: "Operations",
    lead: "me",
  });

  // Finished work, kept for reference and dropped from the sidebar further down.
  // A vault with nothing hidden makes the Hidden panel, the Hide button's
  // refusal, and the split between the two reporter menus all unobservable.
  await vault.createProject({
    key: "LEG",
    name: "Legacy reporting (retired)",
    description: "The stack ACME is replacing. Closed out; kept for the audit trail.",
    category: "Delivery",
    lead: "me",
  });

  // Deliberately not alphabetical, so the fixture exercises manual project order
  // rather than accidentally agreeing with the fallback sort.
  await vault.moveProject("OPS", { before: "ACME" });

  // ------------------------------------------------------------ reporters
  //
  // Who asked for the work. Three names across both projects, each on more than
  // one item, because the field's whole point in the UI is a menu of what has
  // been used before — and a fixture where every name appears once would show a
  // list you can only ever add to, never pick from.
  //
  // Most items carry none, which is also deliberate: work you raised yourself has
  // no reporter, and the empty state is the one the field is in most of the time.
  //
  // One spelling each. The UI folds "Priya Raman" and "priya raman" together and
  // offers the commoner one, but that is a defence against drift, not something a
  // worked example should be modelling as normal.
  const analytics = "Mei Lin"; // wants the reporting stack fixed
  const finance = "Priya Raman"; // already named in the note link on the bug below
  const sponsor = "Dan Okafor"; // the steering group this all reports to
  // Used on one item, in the archived project, and nowhere else. That is the
  // whole point of it: it is the name that proves the two menus differ. It is
  // offered when you are typing a reporter — a name is a name, and hiding a
  // project should not make a colleague un-nameable — and withheld from the
  // toolbar filter, where it could only ever select an empty view.
  const retired = "Nadia Hart";

  // ------------------------------------------------------------ assignees
  // Who is doing it, which is a different question from who asked, so a
  // different cast. Overlapping the two would make the fixture read as though
  // the fields were interchangeable, and only this one reaches Jira on push.
  const me = "me"; // the vault owner, and both projects' lead
  const engineer = "Ravi Shah";

  // ------------------------------------------------- ACME: epic and children
  const epic = await vault.createItem({
    project: "ACME",
    type: "epic",
    summary: "Migrate reporting off the legacy warehouse",
    description:
      "Everything needed to retire the old warehouse.\n\n" +
      "Done when the last dashboard reads from the new schema and the legacy\n" +
      "instance has been switched off for a full month without complaint.",
    priority: "high",
    category: "Migration",
    labels: ["reporting", "migration"],
    reporter: sponsor,
    startDate: offset(-30),
    dueDate: offset(75),
  });

  const schemaStory = await vault.createItem({
    project: "ACME",
    type: "story",
    summary: "Agree the target reporting schema",
    description:
      "Analysts need to sign off on table and column names before anything gets\n" +
      "built on top of them, because renaming later means rewriting every query.",
    status: "in_progress",
    priority: "highest",
    parent: epic.key,
    category: "Migration",
    labels: ["schema"],
    reporter: analytics,
    assignee: me,
    dueDate: offset(3),
    estimate: 5,
  });

  const backfillStory = await vault.createItem({
    project: "ACME",
    type: "story",
    summary: "Backfill three years of history",
    description: "Nightly batches, oldest first, so a failure costs one night rather than the lot.",
    priority: "medium",
    parent: epic.key,
    category: "Migration",
    labels: ["etl"],
    components: ["warehouse"],
    reporter: analytics,
    assignee: engineer,
    startDate: offset(10),
    dueDate: offset(38),
    estimate: 8,
  });

  const sowTask = await vault.createItem({
    project: "ACME",
    type: "task",
    summary: "Send the vendor SOW for legal review",
    description: "Legal needs to review sections 4 and 7 before this goes out.",
    priority: "high",
    parent: epic.key,
    category: "Procurement",
    labels: ["vendor", "legal"],
    dueDate: offset(-2), // deliberately overdue, so the agenda has an overdue section
  });

  await vault.createItem({
    project: "ACME",
    type: "subtask",
    summary: "Redline the indemnity clause",
    description: "Our standard cap is 12 months of fees. Theirs is unlimited.",
    priority: "high",
    parent: sowTask.key,
    dueDate: offset(-2),
  });

  const bug = await vault.createItem({
    project: "ACME",
    type: "bug",
    summary: "Revenue widget double-counts refunds",
    description:
      "Steps:\n\n" +
      "1. Open the Q3 revenue dashboard\n" +
      "2. Compare the total against the finance close\n\n" +
      "The widget is out by exactly the refund total, so refunds are being\n" +
      "subtracted from gross and then again from net.",
    priority: "highest",
    parent: epic.key,
    category: "Defects",
    labels: ["reporting", "finance"],
    components: ["reporting-api"],
    reporter: finance,
    assignee: engineer,
    dueDate: offset(1),
  });

  await vault.createItem({
    project: "ACME",
    type: "task",
    summary: "Decommission the legacy warehouse instance",
    description: "Only after a full month of clean parallel running.",
    priority: "low",
    parent: epic.key,
    category: "Migration",
    startDate: offset(60),
    dueDate: offset(75),
  });

  // Two items that are over, one each way. Without them a third of the board is
  // empty in the worked example, "Hide closed" has nothing to hide, and the
  // sidebar's open count always equals its total — so none of the three reads as
  // meaning anything.
  const chosen = await vault.createItem({
    project: "ACME",
    type: "task",
    summary: "Choose the replacement warehouse",
    description: "Three vendors evaluated against the analysts' own query patterns.",
    priority: "high",
    parent: epic.key,
    category: "Migration",
    reporter: sponsor,
    assignee: me,
    estimate: 3,
  });

  const macros = await vault.createItem({
    project: "ACME",
    type: "task",
    summary: "Port the old Excel macros to the new schema",
    description:
      "Nobody has opened the workbook these feed since the last close. Better to\n" +
      "let them go than migrate something already on its way out.",
    priority: "lowest",
    parent: epic.key,
    category: "Migration",
    reporter: finance,
  });

  // ------------------------------------------------------- OPS: recurring
  await vault.createItem({
    project: "OPS",
    summary: "Morning check of the overnight batch",
    description: "Failures page automatically; this is for the ones that succeeded but look wrong.",
    priority: "medium",
    category: "Routine",
    cadence: "daily",
  });

  await vault.createItem({
    project: "OPS",
    summary: "Weekly rollup to the steering group",
    description: "What moved, what is stuck, what needs a decision from them.",
    priority: "high",
    category: "Reporting",
    reporter: sponsor,
    assignee: me,
    cadence: "weekly",
    dueDate: offset(4),
  });

  await vault.createItem({
    project: "OPS",
    summary: "Reconcile cloud spend against the forecast",
    description: "Anything more than 10% over forecast needs a written explanation.",
    priority: "medium",
    category: "Finance",
    reporter: finance,
    cadence: "monthly",
  });

  await vault.createItem({
    project: "OPS",
    summary: "Quarterly access review",
    description: "Confirm every service account still needs the access it has.",
    priority: "high",
    category: "Compliance",
    labels: ["security"],
    cadence: "quarterly",
  });

  const stale = await vault.createItem({
    project: "OPS",
    summary: "Chase the unanswered DPA question",
    description: "Third follow-up. Escalate if there is nothing back by the end of the week.",
    priority: "low",
    category: "Routine",
    dueDate: offset(-9),
  });

  // -------------------------------------------------------- LEG: retired
  const retiredItem = await vault.createItem({
    project: "LEG",
    type: "task",
    summary: "Agree what happens to the archived dashboards",
    description: "Kept read-only for seven years, then dropped. Signed off by finance.",
    priority: "medium",
    category: "Compliance",
    reporter: retired,
    assignee: me,
  });

  // ------------------------------------------------- exercise the workflow
  // Reaching in_review has to go through in_progress, which is the point of the
  // transition rules — so drive it rather than creating it in that state.
  await vault.transition(backfillStory.key, "in_progress");
  await vault.transition(backfillStory.key, "in_review");
  await vault.transition(stale.key, "blocked");
  await vault.transition(bug.key, "in_progress");

  // The two endings. `done` is work that happened; `disregard` is work that was
  // decided against — see the `disregard` section in PLAN.md for why those are
  // not the same state wearing different labels.
  await vault.transition(chosen.key, "in_progress");
  await vault.transition(chosen.key, "done");
  await vault.transition(macros.key, "disregard");

  // Hiding refuses while a project still holds live work, so this only succeeds
  // because the one item above is closed first — which is the rule the sidebar's
  // disabled Hide button is reporting, exercised here rather than asserted.
  await vault.transition(retiredItem.key, "done");
  await vault.hideProject("LEG");

  await vault.addComment(sowTask.key, "Legal have it. Promised a first pass by Thursday.");
  await vault.addComment(bug.key, "Reproduced on staging with the Q3 data. Not a caching artefact.");
  await vault.addComment(
    schemaStory.key,
    "Analysts pushed back on `dim_customer` — they want the legacy column names kept as aliases.",
  );

  // ------------------------------------------------------ every link type
  await vault.addLink(schemaStory.key, {
    type: "url",
    target: "https://www.atlassian.com/software/jira",
    label: "Where this eventually gets pushed",
  });
  await vault.addLink(schemaStory.key, {
    type: "item",
    target: backfillStory.key,
    label: "Blocks the backfill",
  });
  await vault.addLink(schemaStory.key, {
    type: "file",
    target: path.join(repoRoot, "SCHEMA.md"),
    label: "Vault schema, for reference",
  });
  await vault.addLink(backfillStory.key, {
    type: "folder",
    target: path.join(coreRoot, "src"),
    label: "Core library source",
  });
  await vault.addLink(sowTask.key, {
    type: "outlook",
    target: "outlook:AAMkAGI2NDQyZjc5LTRhMmEtNDIwZi05ZTk0",
    label: "Vendor kickoff thread",
  });
  await vault.addLink(bug.key, {
    type: "note",
    target: "Finance close figures live in the shared drive; ask Priya for access.",
  });

  // ----------------------------------------------------------- attachments
  // One copied into the vault, one left where it lives — the distinction
  // SCHEMA.md draws between attachments and file links.
  // The scratch source goes in the OS temp directory rather than beside the
  // vault. It used to land in the repo root, where nothing gitignores it, so any
  // failure between writing it and removing it left a file behind — which is how
  // one ended up committed. `finally` closes the rest of that gap, and a private
  // temp directory means the name no longer has to be unique, so a reseed now
  // produces an identical vault instead of a fresh attachment filename.
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "todo-vault-seed-"));
  const scratch = path.join(scratchDir, "target-schema-draft.md");
  try {
    await fs.writeFile(
      scratch,
      "# Target reporting schema\n\nDraft for review. Column names are not final.\n",
      "utf8",
    );
    await vault.addAttachment(schemaStory.key, scratch, {
      copy: true,
      title: "Target schema draft",
    });
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true });
  }

  await vault.addAttachment(bug.key, path.join(repoRoot, "README.md"), {
    copy: false,
    title: "Project README (left in place)",
  });

  // ------------------------------------------------------------ one push
  // ACME declares jiraProjectKey ENG, so its counterpart is an ENG key. Last,
  // after every edit to this item, because markPushed stamps a hash of the
  // pushable fields as they stand — pushing first and editing after would seed
  // an item that reports itself as drifted, which is a different demonstration
  // and not the one the Jira row is for.
  await vault.markPushed(schemaStory.key, "ENG-412", "10412");

  // ----------------------------------------------------------------- report
  const { items, projects, errors } = await vault.load();
  process.stdout.write(`Seeded ${projects} projects and ${items} items at ${root}\n`);
  if (errors.length) {
    process.stdout.write(`\n${errors.length} file(s) failed to parse:\n`);
    for (const e of errors) process.stdout.write(`  - ${e}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Next: npm run vault -- agenda week --vault ./vault\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
