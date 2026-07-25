/**
 * Builds the worked example vault the README describes: two projects, an epic
 * with stories, tasks, a subtask and a bug, recurring items at every cadence,
 * and one of every link type.
 *
 * Also the fixture the desktop UI is developed against, so it is a script rather
 * than a sequence of CLI calls — resetting to a known state should be one
 * command.
 *
 *   npx tsx scripts/seed-vault.ts ./vault
 *
 * Refuses to run over an existing vault unless --force is passed.
 */
import { promises as fs } from "node:fs";
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
    await fs.rm(root, { recursive: true, force: true });
  }

  const vault = await Vault.init(root);
  const repoRoot = path.resolve(import.meta.dirname, "..");

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
    cadence: "weekly",
    dueDate: offset(4),
  });

  await vault.createItem({
    project: "OPS",
    summary: "Reconcile cloud spend against the forecast",
    description: "Anything more than 10% over forecast needs a written explanation.",
    priority: "medium",
    category: "Finance",
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

  // ------------------------------------------------- exercise the workflow
  // Reaching in_review has to go through in_progress, which is the point of the
  // transition rules — so drive it rather than creating it in that state.
  await vault.transition(backfillStory.key, "in_progress");
  await vault.transition(backfillStory.key, "in_review");
  await vault.transition(stale.key, "blocked");
  await vault.transition(bug.key, "in_progress");

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
    target: path.join(repoRoot, "src"),
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
  const scratch = path.join(root, "..", `seed-spec-${Date.now()}.md`);
  await fs.writeFile(
    scratch,
    "# Target reporting schema\n\nDraft for review. Column names are not final.\n",
    "utf8",
  );
  await vault.addAttachment(schemaStory.key, scratch, {
    copy: true,
    title: "Target schema draft",
  });
  await vault.addAttachment(bug.key, path.join(repoRoot, "README.md"), {
    copy: false,
    title: "Project README (left in place)",
  });
  await fs.rm(scratch, { force: true });

  // ----------------------------------------------------------------- report
  const { items, projects, errors } = await vault.load();
  process.stdout.write(`Seeded ${projects} projects and ${items} items at ${root}\n`);
  if (errors.length) {
    process.stdout.write(`\n${errors.length} file(s) failed to parse:\n`);
    for (const e of errors) process.stdout.write(`  - ${e}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Next: npx tsx src/cli.ts agenda week --vault ./vault\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
