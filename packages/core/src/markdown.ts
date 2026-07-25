import YAML from "yaml";

/**
 * Frontmatter read/write.
 *
 * Hand-rolled rather than using gray-matter so we control key ordering on the
 * way out. Stable ordering means a status change produces a one-line git diff
 * instead of a reshuffled file, which matters a lot when Claude and the app are
 * both writing to the same vault.
 */

const FENCE = "---";

export interface ParsedFile<T = Record<string, unknown>> {
  data: T;
  body: string;
}

export function parseFrontmatter(text: string): ParsedFile {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

  if (!normalized.startsWith(`${FENCE}\n`)) {
    // No frontmatter at all — treat the whole file as body.
    return { data: {}, body: normalized.trim() };
  }

  const end = normalized.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) {
    throw new Error(
      "Frontmatter block was opened with --- but never closed. Add a closing --- line.",
    );
  }

  const yamlText = normalized.slice(FENCE.length + 1, end);
  const rest = normalized.slice(end + FENCE.length + 1);

  let data: unknown;
  try {
    data = YAML.parse(yamlText) ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Frontmatter is not valid YAML: ${message}`);
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Frontmatter must be a YAML mapping of field names to values");
  }

  return {
    data: data as Record<string, unknown>,
    body: rest.replace(/^\n+/, "").trimEnd(),
  };
}

/** Reorders keys to match `order`, dropping undefined and null values. */
function orderKeys(
  data: Record<string, unknown>,
  order: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  // Anything not in the order list still gets written, so a field added by a
  // future version of the app is never silently destroyed by an older one.
  for (const key of Object.keys(data)) {
    if (key in out) continue;
    if (order.includes(key)) continue;
    const value = data[key];
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

export function serializeFrontmatter(
  data: Record<string, unknown>,
  body: string,
  order: readonly string[],
): string {
  const ordered = orderKeys(data, order);
  const yamlText = YAML.stringify(ordered, {
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
    singleQuote: false,
  }).trimEnd();

  const trimmedBody = body.trim();
  return `${FENCE}\n${yamlText}\n${FENCE}\n\n${trimmedBody}\n`;
}
