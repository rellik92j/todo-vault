import { useMemo, useState } from "react";
import { PRIORITIES } from "todo-vault/constants";
import type { Item } from "todo-vault";

import { commonTransitions } from "./selection";
import { STATUS_LABELS } from "./pieces";

type LabelsMode = "add" | "remove" | "replace";

interface BulkUpdateOutcome {
  error: string | null;
  updated: number;
  skipped: Array<{ key: string; reason: string }>;
}

/**
 * The backlog's bulk edit bar: one commit per field change, applied to every
 * checked row at once.
 *
 * Every control here fires and resets rather than holding a bound value —
 * there is no single "current status" or "current assignee" across a mixed
 * selection worth displaying, so each is a trigger, not a field. That is also
 * why status/priority reset to a placeholder after firing instead of showing
 * whatever was just picked: the pick was an instruction, not a fact about the
 * selection.
 */
export function BulkBar({
  checkedItems,
  hiddenByFilter,
  reporters,
  assignees,
  busy,
  onClear,
  onUpdate,
}: {
  checkedItems: Item[];
  /** How many checked rows the current filter or "Hide closed" is not showing. */
  hiddenByFilter: number;
  reporters: string[];
  assignees: string[];
  busy: boolean;
  onClear: () => void;
  onUpdate: (patch: Record<string, unknown>) => Promise<BulkUpdateOutcome>;
}): React.JSX.Element {
  const [assigneeDraft, setAssigneeDraft] = useState("");
  const [reporterDraft, setReporterDraft] = useState("");
  const [dueDateDraft, setDueDateDraft] = useState("");
  const [labelsMode, setLabelsMode] = useState<LabelsMode>("add");
  const [labelsDraft, setLabelsDraft] = useState("");
  const [lastResult, setLastResult] = useState<{ text: string; detail?: string } | null>(null);

  const transitions = useMemo(() => commonTransitions(checkedItems), [checkedItems]);

  const run = async (patch: Record<string, unknown>): Promise<void> => {
    const result = await onUpdate(patch);
    if (result.error) {
      setLastResult({ text: result.error });
      return;
    }
    if (!result.skipped.length) {
      setLastResult({ text: `${result.updated} updated` });
      return;
    }
    setLastResult({
      text: `${result.updated} updated, ${result.skipped.length} skipped: ${result.skipped.map((s) => s.key).join(", ")}`,
      detail: result.skipped.map((s) => `${s.key}: ${s.reason}`).join("\n"),
    });
  };

  return (
    <div className="bulk-bar">
      <span className="bulk-count">
        {checkedItems.length} selected
        {hiddenByFilter > 0 && ` — ${hiddenByFilter} not shown here`}
      </span>

      <button className="btn" onClick={onClear} disabled={busy}>
        Clear
      </button>

      <select
        value=""
        disabled={busy || transitions.length === 0}
        title={
          transitions.length === 0
            ? "No status is reachable by every selected item"
            : "Set status for every selected item"
        }
        onChange={(e) => {
          const status = e.target.value;
          if (status) void run({ status });
        }}
      >
        <option value="" disabled>
          Status…
        </option>
        {transitions.map((status) => (
          <option key={status} value={status}>
            {STATUS_LABELS[status] ?? status}
          </option>
        ))}
      </select>

      <select
        value=""
        disabled={busy}
        title="Set priority for every selected item"
        onChange={(e) => {
          const priority = e.target.value;
          if (priority) void run({ priority });
        }}
      >
        <option value="" disabled>
          Priority…
        </option>
        {PRIORITIES.map((priority) => (
          <option key={priority} value={priority}>
            {priority}
          </option>
        ))}
      </select>

      {/*
        Assignee and Reporter commit on Enter always — including empty, which
        clears the field for the whole selection — but on blur only when
        non-empty. A passive click somewhere else in this bar must not read as
        "clear the assignee for twelve items"; a deliberate Enter on an empty
        box may.
      */}
      <input
        type="text"
        list="bulk-bar-assignees"
        placeholder="Assignee…"
        value={assigneeDraft}
        disabled={busy}
        onChange={(e) => setAssigneeDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setAssigneeDraft("");
            return;
          }
          if (e.key !== "Enter") return;
          e.preventDefault();
          const trimmed = assigneeDraft.trim();
          setAssigneeDraft("");
          void run({ assignee: trimmed || null });
        }}
        onBlur={() => {
          const trimmed = assigneeDraft.trim();
          setAssigneeDraft("");
          if (trimmed) void run({ assignee: trimmed });
        }}
      />
      <datalist id="bulk-bar-assignees">
        {assignees.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <input
        type="text"
        list="bulk-bar-reporters"
        placeholder="Reporter…"
        value={reporterDraft}
        disabled={busy}
        onChange={(e) => setReporterDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setReporterDraft("");
            return;
          }
          if (e.key !== "Enter") return;
          e.preventDefault();
          const trimmed = reporterDraft.trim();
          setReporterDraft("");
          void run({ reporter: trimmed || null });
        }}
        onBlur={() => {
          const trimmed = reporterDraft.trim();
          setReporterDraft("");
          if (trimmed) void run({ reporter: trimmed });
        }}
      />
      <datalist id="bulk-bar-reporters">
        {reporters.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <span className="date-field">
        <input
          type="date"
          value={dueDateDraft}
          disabled={busy}
          title="Set due date for every selected item"
          onChange={(e) => {
            const value = e.target.value;
            setDueDateDraft("");
            void run({ dueDate: value || null });
          }}
        />
        <button
          type="button"
          className="clear-btn"
          disabled={busy}
          title="Clear due date for every selected item"
          onClick={() => void run({ dueDate: null })}
        >
          ✕
        </button>
      </span>

      <select
        value={labelsMode}
        disabled={busy}
        title="How the typed labels apply to the selection"
        onChange={(e) => setLabelsMode(e.target.value as LabelsMode)}
      >
        <option value="add">Add labels</option>
        <option value="remove">Remove labels</option>
        <option value="replace">Replace labels</option>
      </select>
      <input
        type="text"
        placeholder="Labels, comma separated…"
        value={labelsDraft}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setLabelsDraft("");
            return;
          }
          if (e.key !== "Enter") return;
          e.preventDefault();
          const values = labelsDraft
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          setLabelsDraft("");
          // Add/remove with nothing typed is a no-op; replace with nothing
          // typed is a deliberate "clear every label", so it alone goes through.
          if (!values.length && labelsMode !== "replace") return;
          void run({ labels: { mode: labelsMode, values } });
        }}
        onChange={(e) => setLabelsDraft(e.target.value)}
      />

      {lastResult && (
        <span className="bulk-result" title={lastResult.detail}>
          {lastResult.text}
        </span>
      )}
    </div>
  );
}
