import assert from "node:assert/strict";
import test from "node:test";

import {
  matchIssueTypes,
  matchJiraFields,
  normaliseBaseUrl,
  renderDiscovered,
  type JiraField,
} from "../src/jira-discover.js";

/**
 * Shaped like a real `GET /rest/api/3/field` response: a few system fields with
 * plain ids, then the custom ones whose numbers differ on every site — which is
 * the entire reason this command exists.
 */
const FIELDS: JiraField[] = [
  { id: "summary", name: "Summary" },
  { id: "issuetype", name: "Issue Type" },
  { id: "customfield_10015", name: "Start date", custom: true },
  { id: "customfield_10016", name: "Story point estimate", custom: true },
  { id: "customfield_10014", name: "Epic Link", custom: true },
  { id: "customfield_10099", name: "Squad", custom: true },
];

test("finds the three ids a jira-map cannot be written without", () => {
  const matches = matchJiraFields(FIELDS);
  const byKey = Object.fromEntries(matches.map((m) => [m.key, m.id]));

  assert.deepEqual(byKey, {
    startDate: "customfield_10015",
    estimate: "customfield_10016",
    epicLink: "customfield_10014",
  });
});

test("ignores custom fields it was not looking for", () => {
  // "Squad" is a real custom field and none of this vault's business. Matching
  // by name rather than by "is custom" is what keeps it out.
  const matches = matchJiraFields(FIELDS);
  assert.ok(!matches.some((m) => m.id === "customfield_10099"));
});

test("matches names case-insensitively, since instances disagree on capitals", () => {
  const matches = matchJiraFields([{ id: "customfield_1", name: "START DATE", custom: true }]);
  assert.equal(matches[0]?.key, "startDate");
  assert.equal(matches[0]?.id, "customfield_1");
});

test("prefers the team-managed estimate field over the company-managed one", () => {
  // A site can have both. Preference order, not source order, decides — so the
  // answer does not depend on how Jira happened to sort its response.
  const both: JiraField[] = [
    { id: "customfield_20000", name: "Story Points", custom: true },
    { id: "customfield_10016", name: "Story point estimate", custom: true },
  ];

  assert.equal(matchJiraFields(both)[0]?.id, "customfield_10016");
});

test("two fields sharing a name are reported, never silently picked", () => {
  // Jira allows duplicate display names, and this is how estimates end up
  // written into a field nobody reads. The second is surfaced for a human.
  const duplicated: JiraField[] = [
    { id: "customfield_10016", name: "Story Points", custom: true },
    { id: "customfield_30000", name: "Story Points", custom: true },
  ];

  const [match] = matchJiraFields(duplicated);
  assert.equal(match?.id, "customfield_10016");
  assert.deepEqual(match?.alternatives, [{ id: "customfield_30000", name: "Story Points" }]);
});

test("an instance with none of them yields no guesses at all", () => {
  // Emitting a plausible-looking customfield_10015 here is the failure this
  // whole command exists to prevent.
  assert.deepEqual(matchJiraFields([{ id: "summary", name: "Summary" }]), []);
});

test("matches the five issue types, including Jira's own Sub-task spelling", () => {
  const { matched, unmatched } = matchIssueTypes(["Epic", "Story", "Task", "Bug", "Sub-task"]);

  assert.deepEqual(matched, {
    epic: "Epic",
    story: "Story",
    task: "Task",
    bug: "Bug",
    subtask: "Sub-task",
  });
  assert.deepEqual(unmatched, []);
});

test("a renamed issue type is reported rather than guessed", () => {
  const { matched, unmatched } = matchIssueTypes(["Epic", "Deliverable", "Task", "Bug"]);

  assert.equal(matched.story, undefined);
  assert.deepEqual(unmatched, ["story", "subtask"]);
});

test("the fragment carries the ids, the instance's own names, and what is missing", () => {
  const yaml = renderDiscovered({
    baseUrl: "https://acme.atlassian.net",
    projectKey: "ENG",
    fields: matchJiraFields(FIELDS),
    issueTypes: { epic: "Epic", story: "Story", task: "Task", bug: "Bug", subtask: "Sub-task" },
    unmatchedTypes: [],
  });

  assert.ok(yaml.includes("jiraProjectKey: ENG"));
  assert.ok(yaml.includes("baseUrl: https://acme.atlassian.net"));
  assert.ok(yaml.includes("startDate: customfield_10015"));
  // The instance's own name for the field, so a reader can check the guess
  // rather than trusting an opaque number.
  assert.ok(yaml.includes("# Start date"));
  assert.ok(yaml.includes("subtask: Sub-task"));
  assert.ok(yaml.includes("category: labels"));
});

test("the fragment says outright when nothing matched", () => {
  const yaml = renderDiscovered({
    baseUrl: "https://acme.atlassian.net",
    projectKey: "ENG",
    fields: [],
    issueTypes: {},
    unmatchedTypes: ["epic", "story", "task", "bug", "subtask"],
  });

  assert.ok(yaml.includes("Nothing matched"));
  assert.ok(yaml.includes("NOT FOUND"));
  // A fragment that silently omitted them would paste as a valid-looking map
  // whose pushes quietly drop start dates.
  assert.ok(yaml.includes("Not found: startDate, estimate, epicLink"));
});

test("an ambiguous match is visible in the pasted fragment, not just in the data", () => {
  const yaml = renderDiscovered({
    baseUrl: "https://acme.atlassian.net",
    projectKey: "ENG",
    fields: matchJiraFields([
      { id: "customfield_10016", name: "Story Points", custom: true },
      { id: "customfield_30000", name: "Story Points", custom: true },
    ]),
    issueTypes: {},
    unmatchedTypes: [],
  });

  assert.ok(yaml.includes("ambiguous"));
  assert.ok(yaml.includes("customfield_30000"));
});

test("a pasted site URL keeps working with a trailing slash", () => {
  assert.equal(normaliseBaseUrl("https://acme.atlassian.net/"), "https://acme.atlassian.net");
  assert.equal(normaliseBaseUrl("  https://acme.atlassian.net//  "), "https://acme.atlassian.net");
  assert.equal(normaliseBaseUrl("https://acme.atlassian.net"), "https://acme.atlassian.net");
});
