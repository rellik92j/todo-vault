/**
 * Calendar arithmetic and the meaning of a cadence tick.
 *
 * Split out of util.ts for the same reason description.ts is: this module
 * imports nothing but a type, so the desktop renderer can decide whether to
 * draw a row as already ticked without dragging node:fs or zod into a browser
 * bundle. The alternative — reimplementing period boundaries in the renderer —
 * is the kind of duplication that drifts silently, and a tick that the agenda
 * and the UI disagree about is worse than no tick at all.
 *
 * util.ts re-exports the date helpers below, so existing importers are
 * unaffected by where they now live.
 */

import type { Cadence } from "./constants.js";

export function todayIso(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return todayIso(d);
}

/** Monday-anchored start of the week containing `dateIso`. */
export function startOfWeek(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00`);
  const offset = (d.getDay() + 6) % 7;
  return addDays(dateIso, -offset);
}

export function startOfMonth(dateIso: string): string {
  return `${dateIso.slice(0, 7)}-01`;
}

export function endOfMonth(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00`);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return todayIso(last);
}

export function startOfQuarter(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00`);
  return todayIso(new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1));
}

/** Day 0 of the month after the quarter's last, which is that last month's final day. */
export function endOfQuarter(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00`);
  return todayIso(new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3 + 3, 0));
}

/**
 * The stretch of calendar one turn of a cadence covers, containing `reference`.
 *
 * This is what makes a tick mean something: "done" for a daily item is a claim
 * about one day and for a monthly item a claim about one month, so a recorded
 * completion date has to be resolved against the item's own cadence before it
 * reads as "already handled". Null for `none`, which has no period and so
 * cannot be ticked at all.
 */
export function cadencePeriod(
  cadence: Cadence,
  reference: string,
): { from: string; to: string } | null {
  switch (cadence) {
    case "daily":
      return { from: reference, to: reference };
    case "weekly": {
      const from = startOfWeek(reference);
      return { from, to: addDays(from, 6) };
    }
    case "monthly":
      return { from: startOfMonth(reference), to: endOfMonth(reference) };
    case "quarterly":
      return { from: startOfQuarter(reference), to: endOfQuarter(reference) };
    case "none":
      return null;
  }
}

/** Structural on purpose — see the module note about keeping zod out of here. */
export interface Tickable {
  cadence: Cadence;
  completions: readonly string[];
}

/** Has this item already been ticked for the cadence period containing `reference`? */
export function isTickedFor(item: Tickable, reference: string): boolean {
  const period = cadencePeriod(item.cadence, reference);
  if (!period) return false;
  return item.completions.some((done) => done >= period.from && done <= period.to);
}

/**
 * Should an agenda window covering up to `windowEnd` leave this item out?
 *
 * True when the item is ticked *and* the period that tick satisfies runs to the
 * end of the window, so nothing more is owed before the window closes. The
 * tempting simplification — "ticked means hide it" — is wrong in a way that is
 * easy to miss: doing today's daily task would empty the *weekly* agenda of it
 * too, even though it comes round again tomorrow, well inside that window.
 */
export function isSettledForWindow(item: Tickable, reference: string, windowEnd: string): boolean {
  const period = cadencePeriod(item.cadence, reference);
  if (!period) return false;
  return isTickedFor(item, reference) && period.to >= windowEnd;
}
