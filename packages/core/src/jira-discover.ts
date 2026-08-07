/**
 * Reads a live Jira instance and reports the ids `jira-map.yaml` needs.
 *
 * This exists because `jira.ts` has been telling people to run it. The warning
 * at the bottom of `buildPushPlan` — "Run `vault jira discover` to find the
 * custom field id for your instance" — fired during a real push against a
 * command the CLI had no case for, which made it the one gap in this repo that
 * reached a user rather than a reader.
 *
 * Two rules shape everything here, and both are inherited rather than invented.
 *
 * **It only reads.** `jira.ts` opens by saying the vault is upstream of Jira and
 * never a mirror of it: "we generate a payload, you review it, and only then
 * does anything leave the machine". Discovery is two GETs against metadata
 * endpoints. Nothing is created, updated or transitioned.
 *
 * **It prints; it does not write `jira-map.yaml`.** The menu's `[C] Connect
 * Claude` settled this argument once already — it composes a config block and
 * refuses to edit `claude_desktop_config.json`, because merging into a file
 * means reserialising everything the user wrote around it. `jira-map.yaml` is
 * the same shape of file: `jira-map.example.yaml` is nine tenths comments
 * explaining what each value is for, and a writer would have to either preserve
 * them by hand or destroy them. So this emits a fragment to paste.
 */
import { z } from "zod";

/** Credentials for Jira Cloud, which authenticates with an email and an API token. */
export interface JiraAuth {
  email: string;
  token: string;
}

/** One entry from `GET /rest/api/3/field`. */
export interface JiraField {
  id: string;
  name: string;
  custom?: boolean;
}

/** The `fields` keys in `JiraMapSchema` that an instance can tell us about. */
export type DiscoverableField = "startDate" | "estimate" | "epicLink";

export interface FieldMatch {
  key: DiscoverableField;
  id: string;
  /** The instance's own name for it, so a reader can confirm the guess. */
  name: string;
  /**
   * Other fields carrying a name we also accept. Jira lets two fields share a
   * display name — a company-managed and a team-managed project each having
   * their own "Story Points" is the common way it happens — and picking one
   * silently is how a push ends up writing estimates into a field nobody reads.
   */
  alternatives: { id: string; name: string }[];
}

/**
 * What each map key is called on a real instance, in the order we prefer them.
 *
 * These are display names rather than ids because the id is the thing being
 * looked up. The lists are not guesses: "Start date" is the Jira Cloud default,
 * "Target start" is what Advanced Roadmaps calls it, and estimate is genuinely
 * two different fields — "Story point estimate" on team-managed projects and
 * "Story Points" on company-managed ones, which is exactly the split that makes
 * a hardcoded customfield_10016 wrong half the time.
 *
 * Each name appears once in whatever casing reads best, because matching is
 * case-insensitive and listing "Story Points" beside "Story points" would make
 * a single field match twice — which showed up as a phantom duplicate in the
 * ambiguity report, the one output that exists to be trusted.
 */
const FIELD_NAMES: Record<DiscoverableField, string[]> = {
  startDate: ["Start date", "Target start"],
  estimate: ["Story point estimate", "Story Points"],
  epicLink: ["Epic Link"],
};

/**
 * Picks the field id for each map key, and says what else it could have been.
 *
 * Matching is case-insensitive because instances differ on capitalisation for
 * the same field, and preference order decides ties across *different* names —
 * "Start date" wins over "Target start" when a site has both. Ties within one
 * name are not resolved at all; they come back as `alternatives` for a human to
 * settle, since nothing here can tell which of two identically named fields the
 * project actually uses.
 *
 * Pure, so the whole matching policy is testable against canned JSON without a
 * Jira to point at — the same split `connectionSnippet` and `classifyLockfile`
 * use, and the only reason any of this has tests at all.
 */
export function matchJiraFields(fields: JiraField[]): FieldMatch[] {
  const matches: FieldMatch[] = [];

  for (const [key, names] of Object.entries(FIELD_NAMES) as [DiscoverableField, string[]][]) {
    const found: { id: string; name: string }[] = [];

    for (const wanted of names) {
      for (const field of fields) {
        if (
          field.name.toLowerCase() === wanted.toLowerCase() &&
          // By id, not by name: an instance may legitimately carry two fields
          // with the same display name, and that pair is the finding worth
          // reporting. What must not happen is one field appearing twice.
          !found.some((f) => f.id === field.id)
        ) {
          found.push({ id: field.id, name: field.name });
        }
      }
    }

    const [best, ...rest] = found;
    if (best) matches.push({ key, id: best.id, name: best.name, alternatives: rest });
  }

  return matches;
}

/** Local item type to the issue type name the instance uses on its create screen. */
export type IssueTypeMap = Record<string, string>;

const LOCAL_TYPES = ["epic", "story", "task", "bug", "subtask"] as const;

/**
 * Matches this vault's five item types against the instance's issue type names.
 *
 * Exact match first, then a case-insensitive one, and nothing clever after that.
 * A site that renamed "Story" to "User Story" or "Deliverable" cannot be guessed
 * at, and guessing would be worse than reporting it: the unmatched names come
 * back for the caller to show, so the user fills in the two that are bespoke
 * rather than trusting five that might all be wrong.
 */
export function matchIssueTypes(available: string[]): {
  matched: IssueTypeMap;
  unmatched: string[];
} {
  const matched: IssueTypeMap = {};
  const unmatched: string[] = [];

  for (const local of LOCAL_TYPES) {
    const exact = available.find((name) => name.toLowerCase() === local);
    // "Sub-task" is Jira's own spelling on company-managed projects, and is the
    // one case where the local name and the remote name differ by punctuation
    // rather than by wording.
    const hyphenated =
      local === "subtask" ? available.find((n) => n.toLowerCase().replace(/[-\s]/g, "") === "subtask") : undefined;

    const found = exact ?? hyphenated;
    if (found) matched[local] = found;
    else unmatched.push(local);
  }

  return { matched, unmatched };
}

/**
 * Builds the YAML fragment to paste into `jira-map.yaml`.
 *
 * Emitted by hand rather than through `YAML.stringify` on purpose. The value of
 * this output is the commentary — which field it picked, what else it could
 * have been, and what it could not find at all — and a serialiser would drop
 * every line of that. The result is a fragment a person edits, not a document a
 * program reads back.
 */
export function renderDiscovered(input: {
  baseUrl: string;
  projectKey: string;
  fields: FieldMatch[];
  issueTypes: IssueTypeMap;
  unmatchedTypes: string[];
}): string {
  const lines: string[] = [
    `# Discovered from ${input.baseUrl} for project ${input.projectKey}.`,
    `# Paste into <vault>/jira-map.yaml and check every line — this is a report,`,
    `# not a decision. Nothing was written for you.`,
    "",
    `jiraProjectKey: ${input.projectKey}`,
    `baseUrl: ${input.baseUrl}`,
    "",
    "issueTypes:",
  ];

  for (const local of LOCAL_TYPES) {
    const name = input.issueTypes[local];
    lines.push(name ? `  ${local}: ${name}` : `  # ${local}: NOT FOUND — fill this in yourself`);
  }

  if (input.unmatchedTypes.length > 0) {
    lines.push(
      "",
      `# ${input.unmatchedTypes.join(", ")} had no issue type with a matching name.`,
      `# A site that renamed them cannot be guessed at; open the create screen and copy the name.`,
    );
  }

  lines.push("", "fields:");

  if (input.fields.length === 0) {
    lines.push("  # Nothing matched. Every id below is instance-specific, so leaving");
    lines.push("  # them out is safer than guessing: the push warns rather than dropping data.");
  }

  for (const match of input.fields) {
    lines.push(`  ${match.key}: ${match.id}   # ${match.name}`);
    for (const other of match.alternatives) {
      lines.push(`  # ambiguous — also matched ${other.id} (${other.name}). Confirm which this project uses.`);
    }
  }

  const missing = (["startDate", "estimate", "epicLink"] as DiscoverableField[]).filter(
    (k) => !input.fields.some((m) => m.key === k),
  );
  if (missing.length > 0) {
    lines.push(
      "",
      `# Not found: ${missing.join(", ")}. epicLink is only needed on older`,
      `# company-managed projects, so its absence is usually correct.`,
    );
  }

  lines.push("", "# category: 'labels' folds the local category into labels. Unchanged by discovery.");
  lines.push("category: labels");

  return lines.join("\n");
}

// --------------------------------------------------------------------- network

/** Only the parts of each response this reads, so a shape change fails here and says so. */
const FieldsResponse = z.array(
  z.object({ id: z.string(), name: z.string(), custom: z.boolean().optional() }),
);

const CreateMetaResponse = z.object({
  projects: z
    .array(z.object({ issuetypes: z.array(z.object({ name: z.string() })).default([]) }))
    .default([]),
});

/** Trailing slashes are the most common way a pasted site URL differs from a usable one. */
export function normaliseBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

async function getJson(url: string, auth: JiraAuth): Promise<unknown> {
  // Basic over email:token is what Jira Cloud accepts; there is no bearer form
  // for an API token. Built here rather than passed in so the token is not
  // sitting formatted in a caller's scope.
  const credentials = Buffer.from(`${auth.email}:${auth.token}`).toString("base64");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Basic ${credentials}`, Accept: "application/json" },
    });
  } catch (err) {
    throw new Error(
      `Could not reach ${url}. ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Jira rejected the credentials (${response.status}). Check JIRA_EMAIL is the account's email address and that JIRA_TOKEN is a current API token from id.atlassian.com.`,
    );
  }
  if (response.status === 404) {
    throw new Error(`${url} returned 404. Check the site URL, and that the project key exists.`);
  }
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}.`);
  }

  return response.json();
}

/** `GET /rest/api/3/field` — every field on the instance, system and custom. */
export async function fetchFields(baseUrl: string, auth: JiraAuth): Promise<JiraField[]> {
  return FieldsResponse.parse(await getJson(`${baseUrl}/rest/api/3/field`, auth));
}

/** `GET /rest/api/3/issue/createmeta` — the issue type names offered for one project. */
export async function fetchIssueTypeNames(
  baseUrl: string,
  auth: JiraAuth,
  projectKey: string,
): Promise<string[]> {
  const url = `${baseUrl}/rest/api/3/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes.fields`;
  const parsed = CreateMetaResponse.parse(await getJson(url, auth));
  return parsed.projects.flatMap((p) => p.issuetypes.map((t) => t.name));
}

/**
 * The whole command: two GETs, then the pure matchers, then a fragment.
 *
 * Thin on purpose. Everything worth testing is above this line, and this is the
 * part no test can reach without a live instance to point at.
 */
export async function discoverJiraMap(
  baseUrl: string,
  auth: JiraAuth,
  projectKey: string,
): Promise<string> {
  const site = normaliseBaseUrl(baseUrl);
  const fields = matchJiraFields(await fetchFields(site, auth));
  const { matched, unmatched } = matchIssueTypes(await fetchIssueTypeNames(site, auth, projectKey));

  return renderDiscovered({
    baseUrl: site,
    projectKey,
    fields,
    issueTypes: matched,
    unmatchedTypes: unmatched,
  });
}
