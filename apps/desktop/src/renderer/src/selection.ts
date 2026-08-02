import { STATUSES, type Status } from "todo-vault/constants";
import type { Item } from "todo-vault";
import { canTransition } from "./pieces";

/**
 * The inclusive span between `anchor` and `key`, in view order, walked in
 * whichever direction the click landed.
 *
 * `orderedKeys` is the same flat list the keyboard cursor and `j`/`k` already
 * walk, so a shift-click range and "the rows between them" never disagree —
 * in particular, a collapsed subtree contributes only the parent row it shows,
 * the same as everywhere else in the app.
 */
export function rangeBetween(orderedKeys: string[], anchor: string, key: string): string[] {
  const keyIndex = orderedKeys.indexOf(key);
  if (keyIndex === -1) return [];

  const anchorIndex = orderedKeys.indexOf(anchor);
  if (anchorIndex === -1) return [key];

  const [start, end] =
    anchorIndex <= keyIndex ? [anchorIndex, keyIndex] : [keyIndex, anchorIndex];
  return orderedKeys.slice(start, end + 1);
}

/**
 * The statuses every item in the selection could legally move to.
 *
 * An intersection, not one item's row, because a mixed selection does not have
 * "the legal moves" — a `todo` and a `done` item in the same set narrow the
 * status control to whatever both can reach, which can be empty.
 *
 * Built on `canTransition` rather than intersecting `legalTransitions` arrays
 * directly, so that an item already at the target status is never the reason
 * the whole set is refused: "set everything to done" must not choke on the one
 * item that already is.
 */
export function commonTransitions(items: Item[]): Status[] {
  if (items.length === 0) return [];
  return STATUSES.filter((status) =>
    items.every((item) => canTransition(item.status, status)),
  );
}
