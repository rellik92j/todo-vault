import Anthropic from "@anthropic-ai/sdk";
import {
  CADENCES,
  CreateItemInput,
  ITEM_TYPES,
  PRIORITIES,
  todayIso,
} from "todo-vault";
import type { ItemDraft } from "../shared/api.js";
import { getApiKey } from "./secrets.js";

/**
 * The optional Claude layer: a sentence in, a proposed item out.
 *
 * Lives in main for one non-negotiable reason — the API key. It is read from
 * safeStorage here, used here, and never travels to the renderer or into the
 * renderer bundle. The renderer sends a prompt and receives a draft.
 *
 * Nothing here writes to the vault. `draftItem` returns a proposal that the UI
 * renders into the ordinary create form for the user to confirm or edit, so the
 * model's output is a suggestion the user accepts, never an action it took.
 */

/** Named so the UI can say what it is about to call. */
export const CLAUDE_MODEL = "claude-opus-5";

/**
 * The wire shape, as a JSON Schema rather than the core's zod schema.
 *
 * Two schemas, deliberately. Structured outputs cannot express most of what
 * CreateItemInput asserts — no `max(255)`, no date regex, no key format — so a
 * schema derived from it would silently drop exactly the constraints worth
 * keeping. Instead this one covers only shape and enums, and the core's schema
 * is still the sole authority on validity: every draft is parsed through
 * CreateItemInput below before it can leave this module.
 *
 * Every field is required because a strict schema has no notion of "omit this";
 * absence is expressed as an empty string or an empty array and stripped after
 * parsing. `parent` is absent from the list on purpose — guessing at a parent
 * key invents a relationship the user did not ask for, and the form already has
 * a picker that only offers legal parents.
 */
const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "project",
    "type",
    "summary",
    "description",
    "priority",
    "category",
    "labels",
    "dueDate",
    "cadence",
    "notes",
  ],
  properties: {
    project: {
      type: "string",
      description: "The key of one of the projects listed in the context, e.g. ACME.",
    },
    type: { type: "string", enum: [...ITEM_TYPES] },
    summary: {
      type: "string",
      description:
        "One line naming the work, in the imperative. No trailing period. Under 120 characters.",
    },
    description: {
      type: "string",
      description:
        "Markdown body with any detail the prompt gave. Empty string when the prompt said nothing beyond the summary — do not invent detail to fill it.",
    },
    priority: { type: "string", enum: [...PRIORITIES] },
    category: {
      type: "string",
      description:
        "Reuse one of the existing categories listed in the context when one fits. Empty string otherwise.",
    },
    labels: {
      type: "array",
      items: { type: "string" },
      description: "Reuse existing labels where they fit. Empty array is fine.",
    },
    dueDate: {
      type: "string",
      description:
        "YYYY-MM-DD, resolved against today's date given in the context. Empty string when the prompt implies no deadline.",
    },
    cadence: {
      type: "string",
      enum: [...CADENCES],
      description: "How often the work recurs. 'none' for one-off work, which is most work.",
    },
    notes: {
      type: "string",
      description:
        "One or two sentences on what you assumed, guessed, or could not determine — especially a due date you resolved from a relative phrase, or a project you picked by inference. Empty string when nothing needed assuming.",
    },
  },
} as const;

interface DraftContext {
  projects: Array<{ key: string; name: string }>;
  categories: string[];
  labels: string[];
  defaultProject: string | null;
}

/** The layer refuses in one place, so every caller gets the same message. */
export class ClaudeUnavailable extends Error {}

function systemPrompt(context: DraftContext): string {
  const projects = context.projects.length
    ? context.projects.map((p) => `  ${p.key} — ${p.name}`).join("\n")
    : "  (none yet)";

  return [
    "You turn a short note from someone's head into one task in their local vault.",
    "",
    `Today is ${todayIso()}. Resolve every relative date against it — "Friday" means`,
    "the next Friday on or after today, and a date must never land in the past.",
    "",
    "Projects available:",
    projects,
    context.defaultProject
      ? `The user is currently looking at ${context.defaultProject}. Use it unless the note points somewhere else.`
      : "No project is in focus; pick the one the note fits best.",
    "",
    context.categories.length
      ? `Categories already in use: ${context.categories.join(", ")}`
      : "No categories are in use yet.",
    context.labels.length
      ? `Labels already in use: ${context.labels.join(", ")}`
      : "No labels are in use yet.",
    "",
    "Draft exactly what the note asks for. Do not add scope, invent detail, or",
    "split one note into several tasks. When the note is vague, leave fields empty",
    "and say so in `notes` rather than guessing — the draft is shown to the user for",
    "confirmation, and an honest gap is easier to fix than a confident invention.",
  ].join("\n");
}

/**
 * Draft an item from a sentence. Rejects rather than returning a partial draft.
 *
 * Failure modes are distinguished on purpose: a missing key, a rejected key, and
 * a model that produced something the vault would refuse are three different
 * problems with three different fixes, and a single "Claude failed" would hide
 * which one happened.
 */
export async function draftItem(prompt: string, context: DraftContext): Promise<ItemDraft> {
  const trimmed = prompt.trim();
  if (!trimmed) throw new ClaudeUnavailable("Describe the task first.");

  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new ClaudeUnavailable("No Anthropic API key is stored. Add one to use drafting.");
  }

  const client = new Anthropic({ apiKey });

  let response;
  try {
    response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      system: systemPrompt(context),
      // Low effort with thinking left on. Drafting one task is not hard, and
      // disabling thinking on this model is the more expensive lever — it can
      // put a tool call or a <thinking> tag into the visible text.
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: DRAFT_SCHEMA },
      },
      messages: [{ role: "user", content: trimmed }],
    });
  } catch (err) {
    throw new ClaudeUnavailable(describeApiError(err));
  }

  // Check before reading content: a refusal returns 200 with content that is
  // empty or partial, so indexing straight into it would throw something
  // unrelated to what actually happened.
  if (response.stop_reason === "refusal") {
    throw new ClaudeUnavailable("Claude declined to draft this one. Try rewording it.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new ClaudeUnavailable("The reply was cut off before it was complete. Try again.");
  }

  const text = response.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") {
    throw new ClaudeUnavailable("Claude replied with nothing to read.");
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.text) as Record<string, unknown>;
  } catch {
    throw new ClaudeUnavailable("Claude's reply was not the JSON it was asked for.");
  }

  const notes = typeof raw.notes === "string" ? raw.notes.trim() : "";
  const parsed = CreateItemInput.safeParse(stripEmpty(raw));
  if (!parsed.success) {
    // The core's own message, which is written for a human and names the field.
    throw new ClaudeUnavailable(
      `Claude's draft is not a valid item: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return { input: parsed.data, notes };
}

/**
 * Empty string and empty array mean "absent" on the wire, because a strict
 * schema cannot omit a field. CreateItemInput would reject "" as a date and as
 * a category, so they are dropped rather than passed through.
 */
function stripEmpty(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "notes") continue; // ours, not the vault's
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/** Typed SDK errors, turned into something worth showing in a toast. */
function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "That API key was rejected. Check it and enter it again.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return "That key does not have access to this model.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Rate limited by the API. Wait a moment and try again.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Could not reach the API. Check the network connection.";
  }
  if (err instanceof Anthropic.APIError) {
    return `The API returned ${err.status}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
