import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// The constants subpath, not the package root — see the note at the top of
// pieces.tsx: the root pulls vault.js, and node:fs with it, into the bundle.
import { ITEM_TYPES, type ItemType } from "todo-vault/constants";
import type { Item, Status } from "todo-vault";
import type { AgendaScope, ProjectSummary } from "@shared/api";

import { useVault } from "./useVault";
import { BacklogTable } from "./BacklogTable";
import { Board } from "./Board";
import { Agenda } from "./Agenda";
import { Calendar } from "./CalendarView";
import { History } from "./History";
import { ItemDetail } from "./ItemDetail";
import { Welcome } from "./Welcome";
import { CreateDialog } from "./CreateDialog";
import { ProjectDialog } from "./ProjectDialog";
import { TrashPanel } from "./TrashPanel";
import { HiddenPanel } from "./HiddenPanel";
import { CommandPalette } from "./CommandPalette";
import { ShortcutHelp } from "./ShortcutHelp";
import { ClaudeSettings } from "./ClaudeSettings";
import { isTypingTarget } from "./shortcuts";
import { backlogOrder, boardLanes } from "./ordering";
import { monthGrid, stepMonth } from "./calendar";
import { rangeBetween } from "./selection";
import { BOARD_ORDER, STATUS_LABELS, isClosed, knownReporters, todayIso } from "./pieces";
import { BulkBar } from "./BulkBar";

type View = "backlog" | "board" | "agenda" | "calendar" | "history";

/** What a new-item form should open pointed at. Empty from the toolbar. */
type NewItemDefaults = { project?: string; type?: ItemType; parent?: string };

export function App(): React.JSX.Element {
  const vault = useVault();
  const [view, setView] = useState<View>("backlog");
  const [project, setProject] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | "all">("all");
  const [cadence, setCadence] = useState<string>("all");
  /**
   * The reporter filter, holding a *folded* name — lowercased — or "all".
   *
   * Folded because knownReporters offers one entry per person and picks the
   * spelling the vault uses most, so the canonical spelling can change under a
   * live filter when an edit tips the count. Matching on the folded name means
   * that reshuffle is invisible here, and the menu's claim that "John Doe" and
   * "john doe" are one person holds when you act on it.
   */
  const [reporter, setReporter] = useState<string>("all");
  /**
   * The type filter, holding the types to *keep*. Empty means every type.
   *
   * A set rather than a single value because there are five types and the two
   * things worth asking for are "epics only", which reads as a roadmap, and
   * "everything except subtasks", which is noise reduction. One select gives
   * the first and cannot express the second.
   *
   * Empty-means-all rather than starting full: it makes the unfiltered view the
   * default state *and* the place clicking the last chip off returns to, so the
   * one failure mode a multi-toggle has over a select — emptying the view by
   * deselecting everything — is unreachable.
   *
   * Absent from the dangling-filter recovery above `filtered`, and that is not
   * an oversight. That effect exists because the project and reporter menus are
   * derived from the items, so an option can vanish under a live filter.
   * ITEM_TYPES is a constant; these cannot dangle.
   */
  const [types, setTypes] = useState<ReadonlySet<ItemType>>(() => new Set());
  const [openOnly, setOpenOnly] = useState(true);
  /**
   * Whether the board splits into one band per project.
   *
   * Board-only, and held here beside the other view state rather than inside
   * `Board` for the reason `collapsed` is: `orderedKeys` below has to build the
   * keyboard walk from the same grouping the board draws, and grouping changes
   * that order from status-major to lane-major.
   *
   * Not persisted, because nothing here is — not even which view is open. See
   * `settings.ts`, which remembers the vault and the zoom level and deliberately
   * nothing else.
   */
  const [grouped, setGrouped] = useState(false);
  /**
   * History's own project filter, separate from `project` above.
   *
   * The two mean different things. `project` narrows a list of items; this
   * narrows a list of commits, and a single commit routinely touches several
   * projects at once — `Update 2 items` and `Reseed: 3 projects, 15 items` are
   * both real entries in this vault's log. Sharing the sidebar selection would
   * make History reshuffle whenever someone clicked a project to look at it.
   */
  const [historyProject, setHistoryProject] = useState<string | null>(null);
  const [text, setText] = useState("");
  /**
   * The backlog rows whose children are hidden — view state, sat here beside
   * the filters rather than inside BacklogTable, because `orderedKeys` below is
   * built from a second `backlogOrder` call and both must be given the same
   * set. A table hiding rows privately would turn every collapsed subtree into
   * a stretch of the keyboard walk where the highlight is off screen.
   *
   * Keys, not row indices: the array is re-derived from a fresh snapshot on
   * every write. Nothing prunes keys whose items have gone — a stale one
   * matches nothing, and keeping it means a subtree filtered out and then back
   * in returns the way the user left it.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [scope, setScope] = useState<AgendaScope>("week");
  /**
   * The calendar's visible month, YYYY-MM. Not persisted, for the same reason
   * `grouped` is not — see the note there. Resets to the current month on
   * every launch.
   */
  const [month, setMonth] = useState<string>(() => todayIso().slice(0, 7));
  const [creating, setCreating] = useState<NewItemDefaults | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [dragProject, setDragProject] = useState<string | null>(null);

  /**
   * Two pieces of state, not one, because the detail panel is `position: fixed`
   * over the right-hand 520px of the window. If moving the keyboard cursor also
   * opened the panel, every `j` would slide a panel across the list being
   * navigated. So `selected` is the highlight — which every view already renders
   * as `aria-selected`, so none of them needed changing — and `detailKey` is what
   * the panel shows. A click sets both; `j`/`k` set only the first.
   */
  const [selected, setSelected] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState<string | null>(null);

  /**
   * The backlog's multi-select, for the bulk edit bar. A third notion of "which
   * item" beside `selected` and `detailKey` — deliberately: folding it into the
   * cursor would mean every `j` throws away a twelve-item selection, since the
   * cursor's whole job is to move freely.
   *
   * `anchorRef` is the shift-click/shift-J/K pivot. A ref rather than state: it
   * is read only from inside the same handlers that set it, on the next
   * keypress or click, and never rendered — nothing on screen depicts "the
   * anchor" on its own.
   */
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [claudeOpen, setClaudeOpen] = useState(false);
  /** Set by `e`: the item whose summary should open for editing. Consumed once. */
  const [editSummaryFor, setEditSummaryFor] = useState<string | null>(null);
  /** The agenda builds its order asynchronously, so it reports it upward. */
  const [agendaOrder, setAgendaOrder] = useState<string[]>([]);

  const searchRef = useRef<HTMLInputElement | null>(null);

  const snapshot = vault.snapshot;

  /** Any overlay that owns the keyboard while it is up. */
  const overlaid =
    creating !== null ||
    creatingProject ||
    showTrash ||
    showHidden ||
    paletteOpen ||
    helpOpen ||
    claudeOpen;

  /** Whether the bulk edit bar is showing — backlog only, and only with a selection. */
  const bulkBarOpen = view === "backlog" && checked.size > 0;

  /**
   * The hiding split, computed once.
   *
   * The snapshot carries every project, hidden or not — `listProjects()` stays
   * unfiltered so the CLI and MCP server keep seeing the whole vault. Dropping
   * them is this window's job, and it has to happen in both directions: the
   * project list, and the items belonging to those projects. Hiding a project
   * while leaving its cards on the board would be worse than not hiding it.
   */
  const visibleProjects = useMemo<ProjectSummary[]>(
    () => snapshot?.projects.filter((p) => !p.hidden) ?? [],
    [snapshot],
  );
  const hiddenProjects = useMemo<ProjectSummary[]>(
    () => snapshot?.projects.filter((p) => p.hidden) ?? [],
    [snapshot],
  );
  const hiddenKeys = useMemo(
    () => new Set(hiddenProjects.map((p) => p.key)),
    [hiddenProjects],
  );

  /** Every item this window will admit exists. The agenda works from this too. */
  const visibleItems = useMemo<Item[]>(
    () => snapshot?.items.filter((i) => !hiddenKeys.has(i.project)) ?? [],
    [snapshot, hiddenKeys],
  );

  /**
   * Two lists of names, because the menus ask different questions.
   *
   * `allReporters` is every name the vault has ever been given, hidden projects
   * included, and it feeds the two places you *type* a name. A name is not an
   * item: hiding a project should not make a colleague un-nameable, and the
   * alternative is that the person you are trying to record silently stops being
   * offered for a reason nothing on screen explains.
   *
   * `reporters` is the subset this window can actually match on, and it feeds the
   * toolbar filter — where an option drawn from a hidden project could only ever
   * return an empty view, which is the exact failure the dangling-filter recovery
   * below exists to prevent.
   */
  const allReporters = useMemo(() => knownReporters(snapshot?.items ?? []), [snapshot]);
  const reporters = useMemo(() => knownReporters(visibleItems), [visibleItems]);

  /**
   * Open items per project, for the Hide button's tooltip. The count alone is
   * already on ProjectSummary; this is what the core's refusal would name, so
   * the reason is readable before the click rather than after it.
   */
  const openByProject = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const item of snapshot?.items ?? []) {
      if (isClosed(item.status)) continue;
      const list = map.get(item.project);
      if (list) list.push(item.key);
      else map.set(item.project, [item.key]);
    }
    return map;
  }, [snapshot]);

  // Select whatever was just created, so the detail panel opens on it.
  useEffect(() => {
    if (vault.lastCreated) {
      setSelected(vault.lastCreated);
      setDetailKey(vault.lastCreated);
    }
  }, [vault.lastCreated]);

  // A selection that no longer exists — deleted, or re-keyed by a project
  // rename — must not leave a stale panel open.
  useEffect(() => {
    if (!snapshot) return;
    // Against the visible set, not the whole snapshot: an item can also leave
    // the window by having its project hidden, and a detail panel left open on
    // one is a card from a project the sidebar says is not there.
    const gone = (key: string | null): boolean =>
      Boolean(key) && !visibleItems.some((i) => i.key === key);
    if (gone(selected)) setSelected(null);
    if (gone(detailKey)) setDetailKey(null);
    // Pruned against visibleItems, not filtered: a bulk edit routinely pushes
    // its own targets out of the filtered view — set twelve items to done with
    // "Hide closed" on and they all vanish from the table — and the selection
    // must survive that. Only a truly gone item (deleted, re-keyed, or its
    // project hidden) drops out here.
    setChecked((current) => {
      const next = new Set([...current].filter((key) => !gone(key)));
      return next.size === current.size ? current : next;
    });
    // A project filter pointing at something no longer in the sidebar — hidden,
    // deleted, or renamed — leaves every view empty with nothing saying why.
    // Falling back to All is the same recovery in all three cases.
    if (project && !snapshot.projects.some((p) => p.key === project && !p.hidden)) {
      setProject(null);
    }
    // The same recovery for the reporter filter, which needs it more: that menu
    // is derived from the items themselves, so clearing the last item carrying a
    // name takes the name off the menu, and a select left pointing at it would
    // filter everything out while showing a blank option as the reason.
    if (reporter !== "all" && !reporters.some((name) => name.toLowerCase() === reporter)) {
      setReporter("all");
    }
  }, [snapshot, visibleItems, selected, detailKey, project, reporter, reporters]);

  const filtered = useMemo<Item[]>(() => {
    if (!snapshot) return [];
    const needle = text.trim().toLowerCase();
    return visibleItems.filter((item) => {
      if (project && item.project !== project) return false;
      if (status !== "all" && item.status !== status) return false;
      if (types.size && !types.has(item.type)) return false;
      if (cadence !== "all" && item.cadence !== cadence) return false;
      if (reporter !== "all" && item.reporter?.trim().toLowerCase() !== reporter) return false;
      if (openOnly && isClosed(item.status)) return false;
      if (needle) {
        const haystack = `${item.key} ${item.summary} ${item.description} ${item.category ?? ""} ${item.labels.join(" ")} ${item.reporter ?? ""}`;
        if (!haystack.toLowerCase().includes(needle)) return false;
      }
      return true;
    });
  }, [snapshot, visibleItems, project, status, types, cadence, reporter, openOnly, text]);

  /**
   * Every key the vault still holds — not `visibleItems`.
   *
   * History names things that may since have been deleted, and this is what
   * decides whether a row opens the detail panel or is drawn as plain text. An
   * item in a hidden project still exists, so hiding must not make its history
   * rows look like they point at nothing.
   */
  const liveKeys = useMemo(
    () => new Set((snapshot?.items ?? []).map((i) => i.key)),
    [snapshot],
  );

  const projectOrder = useMemo(
    () => visibleProjects.map((p) => p.key),
    [visibleProjects],
  );

  /** Key -> name, for the board's lane headers. */
  const projectNames = useMemo(
    () => new Map(visibleProjects.map((p) => [p.key, p.name])),
    [visibleProjects],
  );

  /**
   * The backlog as it is drawn, kept whole rather than reduced straight to keys
   * because `←`/`→` also need to know whether the row under the cursor has
   * anything to collapse. `BacklogTable` derives the same rows from the same
   * two inputs — see its own note on why the collapsed set is a prop.
   */
  const backlogRows = useMemo(
    () => (view === "backlog" ? backlogOrder(filtered, collapsed) : []),
    [view, filtered, collapsed],
  );

  /**
   * The keys of the current view, in the order it is actually displaying them,
   * which is what `j`/`k` walk. Each view's ordering is the one it renders with —
   * imported from `ordering.ts` rather than recomputed here, because a cursor
   * that steps through a different order than the eye sees is worse than no
   * cursor at all. The agenda's comes back over IPC, hence the reported copy.
   */
  const orderedKeys = useMemo<string[]>(() => {
    if (view === "backlog") return backlogRows.map(({ item }) => item.key);
    if (view === "board") {
      return boardLanes(filtered, projectOrder, grouped).flatMap((lane) =>
        lane.columns.flatMap((c) => c.items.map((i) => i.key)),
      );
    }
    if (view === "calendar") {
      return monthGrid(month, filtered, todayIso()).flatMap((day) =>
        day.items.map((i) => i.key),
      );
    }
    return agendaOrder;
  }, [view, backlogRows, filtered, projectOrder, grouped, month, agendaOrder]);

  const selectedItem = visibleItems.find((i) => i.key === selected) ?? null;
  const detailItem = visibleItems.find((i) => i.key === detailKey) ?? null;

  /**
   * The checked rows, resolved against visibleItems rather than filtered — the
   * same reasoning as the pruning effect above. This is what the bulk bar
   * actually edits.
   */
  const checkedItems = useMemo(
    () => visibleItems.filter((i) => checked.has(i.key)),
    [visibleItems, checked],
  );

  /**
   * How many checked rows the current filter is hiding, so the bar can say so
   * instead of silently acting on rows nobody can see right now. `filtered`,
   * unlike `visibleItems`, is what a filter chip or "Hide closed" can shrink.
   */
  const checkedHiddenByFilter = useMemo(() => {
    if (checked.size === 0) return 0;
    const shown = new Set(filtered.map((i) => i.key));
    return checkedItems.filter((i) => !shown.has(i.key)).length;
  }, [checked, checkedItems, filtered]);

  /** Open an item in the detail panel, and put the cursor on it. */
  const open = useCallback((key: string) => {
    setSelected(key);
    setDetailKey(key);
  }, []);

  /**
   * Toggle one row, or extend from the anchor — Ctrl/Cmd+click and shift-click
   * respectively. A plain click replaces the anchor with the clicked row, so the
   * next shift-click ranges from there rather than from wherever the selection
   * started.
   */
  const toggleCheck = useCallback(
    (key: string, event: { shiftKey: boolean }) => {
      setChecked((current) => {
        if (event.shiftKey && anchorRef.current) {
          const range = rangeBetween(orderedKeys, anchorRef.current, key);
          const next = new Set(current);
          for (const k of range) next.add(k);
          return next;
        }
        anchorRef.current = key;
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    },
    [orderedKeys],
  );

  const selectAllVisible = useCallback(() => {
    setChecked(new Set(orderedKeys));
  }, [orderedKeys]);

  const clearChecked = useCallback(() => {
    setChecked(new Set());
    anchorRef.current = null;
  }, []);

  /** The backlog table's header checkbox: force a set of rows to one state. */
  const setCheckedMany = useCallback((keys: string[], next: boolean) => {
    setChecked((current) => {
      const updated = new Set(current);
      for (const key of keys) {
        if (next) updated.add(key);
        else updated.delete(key);
      }
      return updated;
    });
  }, []);

  /** One type chip on or off. A new Set each time — the state is read-only. */
  const toggleType = useCallback((type: ItemType) => {
    setTypes((current) => {
      const next = new Set(current);
      if (!next.delete(type)) next.add(type);
      return next;
    });
  }, []);

  const move = useCallback(
    (delta: number) => {
      if (!orderedKeys.length) return;
      const at = selected ? orderedKeys.indexOf(selected) : -1;
      const next =
        at === -1
          ? delta > 0
            ? 0
            : orderedKeys.length - 1
          : (at + delta + orderedKeys.length) % orderedKeys.length;
      const key = orderedKeys[next];
      setSelected(key);
      // An open panel follows the cursor, the way a mail client's reading pane
      // does. A closed one stays closed — that is the whole point of the split.
      setDetailKey((current) => (current === null ? null : key));
    },
    [orderedKeys, selected],
  );

  /**
   * Shift+J / Shift+K: move the cursor exactly as `move` does, and grow the
   * checked set to cover the span just crossed. The anchor seeds from wherever
   * the cursor already was when it is not already set, so the first Shift+J
   * from an empty selection checks two rows, not one.
   */
  const moveAndExtend = useCallback(
    (delta: number) => {
      if (!orderedKeys.length) return;
      if (!anchorRef.current) anchorRef.current = selected ?? orderedKeys[0];
      const at = selected ? orderedKeys.indexOf(selected) : -1;
      const next =
        at === -1
          ? delta > 0
            ? 0
            : orderedKeys.length - 1
          : (at + delta + orderedKeys.length) % orderedKeys.length;
      const key = orderedKeys[next];
      setSelected(key);
      setDetailKey((current) => (current === null ? null : key));
      setChecked((current) => {
        const range = rangeBetween(orderedKeys, anchorRef.current as string, key);
        const nextSet = new Set(current);
        for (const k of range) nextSet.add(k);
        return nextSet;
      });
    },
    [orderedKeys, selected],
  );

  /**
   * Collapse or expand one subtree.
   *
   * The cursor rule is the part worth stating: closing a subtree the cursor is
   * inside would leave the next `j` resuming from a row nobody can see, so the
   * cursor comes up to the parent that just closed. Whether it is still visible
   * is asked of `backlogOrder` itself rather than re-derived from `parent`
   * links here — one answer, and it cannot disagree with what the table draws.
   */
  const setCollapse = useCallback(
    (key: string, next: boolean) => {
      if (collapsed.has(key) === next) return;
      const updated = new Set(collapsed);
      if (next) updated.add(key);
      else updated.delete(key);
      setCollapsed(updated);

      if (!next || !selected) return;
      const visible = backlogOrder(filtered, updated);
      if (!visible.some(({ item }) => item.key === selected)) setSelected(key);
    },
    [collapsed, filtered, selected],
  );

  const toggleCollapse = useCallback(
    (key: string) => setCollapse(key, !collapsed.has(key)),
    [collapsed, setCollapse],
  );

  /**
   * ← and → on the backlog. A row with no children is left alone rather than
   * added to the set: it would hide nothing today and quietly hide something
   * the day it gains a child.
   *
   * Reports whether it did anything, so the handler can leave the key alone
   * otherwise — the board is six columns wide and `.content` scrolls, and
   * swallowing → there would take away the only way to scroll it from the
   * keyboard.
   */
  const collapseSelected = useCallback(
    (next: boolean): boolean => {
      if (view !== "backlog" || !selected) return false;
      const row = backlogRows.find(({ item }) => item.key === selected);
      if (!row?.hasChildren) return false;
      setCollapse(selected, next);
      return true;
    },
    [view, selected, backlogRows, setCollapse],
  );

  // Keep the highlighted row on screen. Scoped to `.content` because the view
  // tabs are a real tablist and carry aria-selected too.
  useEffect(() => {
    if (!selected) return;
    document
      .querySelector('.content [aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, view]);

  /**
   * Delete, turning the core's refusal into a question.
   *
   * `deleteItem` fails when the item has children and the message lists them.
   * That is a decision for the user, not an error, so it becomes a confirm and a
   * retry with cascade.
   */
  const handleDelete = useCallback(
    async (item: Item) => {
      const first = await vault.deleteItem(item.key, false);
      if (!first.error) return;

      if (/beneath it/.test(first.error)) {
        if (window.confirm(`${first.error}\n\nTrash all of them together?`)) {
          await vault.deleteItem(item.key, true);
        }
        return;
      }
      window.alert(first.error);
    },
    [vault],
  );

  /**
   * The one keyboard handler, driven by the same registry the help overlay
   * renders — see shortcuts.ts for why they must not be two lists.
   *
   * Ctrl-K and Escape are the only things that fire while a text field has
   * focus. A bare `n` mid-word must type an "n".
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing = isTypingTarget(event.target);
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
        return;
      }

      // Not marked whileTyping in the registry, deliberately: Ctrl-A inside a
      // text field must still select that field's text, so this only acts
      // outside one. No preventDefault otherwise, which is what leaves the
      // native behaviour intact.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        if (!typing && !overlaid && view === "backlog") {
          event.preventDefault();
          selectAllVisible();
        }
        return;
      }

      if (event.key === "Escape") {
        // Every overlay closes itself; this only handles the layers below them.
        if (overlaid) return;
        // Out of the field first. An inline editor has already reverted itself
        // by now — its own onKeyDown runs before this one — so this only stops
        // Escape from closing the whole panel while a field still has focus.
        if (typing) {
          (event.target as HTMLElement).blur();
          return;
        }
        // First rung: drop the bulk selection, the same way a Finder or Gmail
        // Escape does before it touches anything else. Otherwise clearing a
        // twelve-item selection takes as many Escapes as the panel does.
        if (checked.size > 0) {
          clearChecked();
          return;
        }
        if (detailKey) setDetailKey(null);
        else setSelected(null);
        return;
      }

      if (typing || !plain || overlaid) return;

      switch (event.key) {
        case "j":
        case "ArrowDown":
          event.preventDefault();
          move(1);
          return;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          move(-1);
          return;
        // Shift+J / Shift+K. The plain gate above excludes Ctrl/Meta/Alt but not
        // Shift, so these arrive here as "J"/"K" without any change to it.
        // Backlog-only: checked rows only mean anything where the bulk bar is.
        case "J":
          if (view === "backlog") {
            event.preventDefault();
            moveAndExtend(1);
          }
          return;
        case "K":
          if (view === "backlog") {
            event.preventDefault();
            moveAndExtend(-1);
          }
          return;
        case " ":
          if (view === "backlog" && selected) {
            event.preventDefault();
            toggleCheck(selected, { shiftKey: false });
          }
          return;
        case "h":
        case "ArrowLeft":
          if (collapseSelected(true)) event.preventDefault();
          return;
        case "l":
        case "ArrowRight":
          if (collapseSelected(false)) event.preventDefault();
          return;
        case "Enter":
          if (selected) {
            event.preventDefault();
            open(selected);
          }
          return;
        case "/":
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          return;
        case "1":
          setView("backlog");
          return;
        case "2":
          setView("board");
          return;
        case "3":
          setView("agenda");
          return;
        case "4":
          setView("calendar");
          return;
        case "5":
          setView("history");
          return;
        // Gated on the board rather than global: it is the only view with lanes,
        // and a key that silently changes something two views away is worse than
        // one that does nothing.
        case "g":
          if (view === "board") setGrouped((on) => !on);
          return;
        // Same reasoning as "g": a key that pages the calendar's month while
        // some other view is open is worse than a key that does nothing there.
        case "[":
          if (view === "calendar") setMonth((m) => stepMonth(m, -1));
          return;
        case "]":
          if (view === "calendar") setMonth((m) => stepMonth(m, 1));
          return;
        case "n":
          event.preventDefault();
          setCreating({});
          return;
        case "x":
          if (selectedItem) void handleDelete(selectedItem);
          return;
        case "e":
          if (selected) {
            event.preventDefault();
            open(selected);
            setEditSummaryFor(selected);
          }
          return;
        case "t":
          setShowTrash(true);
          return;
        case "r":
          void vault.reload();
          return;
        case "?":
          event.preventDefault();
          setHelpOpen(true);
          return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    overlaid,
    view,
    detailKey,
    selected,
    selectedItem,
    checked,
    move,
    moveAndExtend,
    toggleCheck,
    selectAllVisible,
    clearChecked,
    open,
    collapseSelected,
    handleDelete,
    vault,
  ]);

  const onProjectDrop = (target: ProjectSummary): void => {
    if (!dragProject || dragProject === target.key) return;
    const from = projectOrder.indexOf(dragProject);
    const to = projectOrder.indexOf(target.key);
    setDragProject(null);
    if (from === -1 || to === -1) return;
    void vault.mutate(() =>
      window.vault.moveProject(
        dragProject,
        from < to ? { after: target.key } : { before: target.key },
      ),
    );
  };

  /**
   * Hide and unhide. Both are plain mutations: the core refuses a hide that
   * would take live work out of view, and `mutate` already puts that refusal in
   * the banner naming the items. The sidebar disables the button before it gets
   * that far, so the banner is for the case where the last open item was
   * reopened from outside the app since this render.
   */
  const handleHideProject = useCallback(
    (key: string) => {
      void vault.mutate(() => window.vault.hideProject(key));
    },
    [vault],
  );

  const handleUnhideProject = useCallback(
    (key: string) => {
      void vault.mutate(() => window.vault.unhideProject(key));
    },
    [vault],
  );

  /**
   * Create, then filter to what was just created. A new project lands at the
   * bottom of an unranked list and is empty besides, so leaving the view on
   * "All projects" would make a successful create look like nothing happened.
   */
  const handleCreateProject = async (
    input: Parameters<typeof vault.createProject>[0],
  ): Promise<string | null> => {
    const message = await vault.createProject(input);
    if (!message) setProject(input.key);
    return message;
  };

  if (!snapshot) {
    return (
      <Welcome
        loading={vault.loading}
        error={vault.error}
        onChoose={vault.chooseVault}
        onOpen={vault.openVault}
      />
    );
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-head">
          <span className="sidebar-title">Projects</span>
          {/*
            An auto margin rather than a .spacer element: this row aligns on the
            baseline, and an empty div has nothing to align to.
          */}
          <span className="project-count" style={{ marginLeft: "auto" }}>
            {visibleItems.length} items
          </span>
          <button
            className="add-btn"
            onClick={() => setCreatingProject(true)}
            title="New project"
          >
            + new
          </button>
        </div>

        <div className="sidebar-scroll">
          <button
            className="project"
            aria-current={project === null}
            onClick={() => setProject(null)}
          >
            <span className="project-name">All projects</span>
            <span className="project-count">
              {visibleItems.filter((i) => !isClosed(i.status)).length}
            </span>
          </button>

          {/*
            Drag to reorder. listProjects already returns manual order, and
            hidden ones are dropped here rather than in the core.

            A row is a div wrapping two buttons, not one button, because a
            button cannot contain a button and the Hide control has to live on
            the row it acts on. The drag handlers moved out to the wrapper with
            it, so dragging still grabs the whole row.
          */}
          {visibleProjects.map((p) => {
            const blockers = openByProject.get(p.key) ?? [];
            return (
              <div
                className={`project-row ${dragProject === p.key ? "project-dragging" : ""}`}
                key={p.key}
                draggable
                onDragStart={() => setDragProject(p.key)}
                onDragEnd={() => setDragProject(null)}
                onDragOver={(e) => e.preventDefault()}
                // Both events have to be cancelled, not just dragover:
                // cancelling dragover only makes this a valid drop target, and
                // the drop's own default is to navigate to whatever was
                // dropped. A OneDrive document dragged onto a project row is
                // an easy miss for the detail panel.
                onDrop={(e) => {
                  e.preventDefault();
                  onProjectDrop(p);
                }}
              >
                <button
                  className="project"
                  aria-current={project === p.key}
                  onClick={() => setProject(p.key)}
                  title={`${p.name} — ${p.totalItems} items, ${p.openItems} open${p.rank !== undefined ? `, rank ${p.rank}` : ""}\nDrag to reorder`}
                >
                  <span className="project-key">{p.key}</span>
                  <span className="project-name">{p.name}</span>
                  <span className="project-count">{p.openItems}</span>
                </button>
                {/*
                  The title sits on the span rather than the button: a disabled
                  button takes no pointer events, so its own tooltip never
                  appears — which is exactly the case that needs explaining.
                */}
                <span
                  className="project-hide-slot"
                  title={
                    blockers.length
                      ? `Cannot hide ${p.key}: ${blockers.slice(0, 6).join(", ")}${blockers.length > 6 ? `, and ${blockers.length - 6} more` : ""} ${blockers.length === 1 ? "is" : "are"} not done or disregarded`
                      : `Hide ${p.key} from this sidebar. Nothing is deleted, and the CLI and MCP server still see it.`
                  }
                >
                  <button
                    className="project-hide"
                    disabled={blockers.length > 0 || vault.busy}
                    aria-label={`Hide project ${p.key}`}
                    onClick={() => handleHideProject(p.key)}
                  >
                    Hide
                  </button>
                </span>
              </div>
            );
          })}
        </div>

        <div className="sidebar-foot">
          <div className="status-line" title={snapshot.root}>
            <span className="mono-path">{shortenPath(snapshot.root)}</span>
          </div>
          <div className="status-line">
            <span
              className="dot"
              style={{ background: snapshot.git.healthy ? "var(--done)" : "var(--high)" }}
            />
            <span title={gitTitle(snapshot.git)}>
              {snapshot.git.healthy ? "history on" : "history off"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => void window.vault.revealPath({ kind: "vault" })}>
              Folder
            </button>
            <button className="btn" onClick={() => setShowTrash(true)} title="Trash (t)">
              Trash{snapshot.trashCount > 0 ? ` (${snapshot.trashCount})` : ""}
            </button>
            {/*
              Always here, even at zero, and beside Trash on purpose: the two
              are the same promise. Something left this window and there is one
              place that says where it went.
            */}
            <button
              className="btn"
              onClick={() => setShowHidden(true)}
              title="Projects dropped from this sidebar. Nothing is deleted."
            >
              Hidden{hiddenProjects.length > 0 ? ` (${hiddenProjects.length})` : ""}
            </button>
            <button className="btn" onClick={vault.chooseVault}>
              Switch
            </button>
            <button
              className="btn"
              onClick={() => setClaudeOpen(true)}
              title="Claude drafting — optional, off until a key is added"
            >
              Claude
            </button>
            <button className="btn" onClick={() => setHelpOpen(true)} title="Keyboard shortcuts (?)">
              ?
            </button>
          </div>
        </div>
      </nav>

      <main className="main">
        <div className="toolbar">
          <div className="tabs" role="tablist">
            {(["backlog", "board", "agenda", "calendar", "history"] as const).map((candidate, index) => (
              <button
                key={candidate}
                role="tab"
                className="tab"
                aria-selected={view === candidate}
                onClick={() => setView(candidate)}
                title={`${candidate[0].toUpperCase() + candidate.slice(1)} (${index + 1})`}
              >
                {candidate[0].toUpperCase() + candidate.slice(1)}
              </button>
            ))}
          </div>

          {/*
            History gets a project dropdown and nothing else. A status/cadence/
            reporter row over a list of commits is five controls that do nothing,
            and the filter is its own state rather than the sidebar's because one
            commit routinely spans projects — following the selection would make
            the same commit appear and disappear for reasons the row does not
            explain.
          */}
          {view === "history" ? (
            <select
              value={historyProject ?? ""}
              onChange={(e) => setHistoryProject(e.target.value || null)}
            >
              <option value="">Every project</option>
              {visibleProjects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.key} — {p.name}
                </option>
              ))}
            </select>
          ) : view === "agenda" ? (
            <select value={scope} onChange={(e) => setScope(e.target.value as AgendaScope)}>
              <option value="today">Today</option>
              <option value="week">This week</option>
              <option value="nextWeek">Next week</option>
              <option value="twoWeeks">This week and next</option>
              <option value="month">This month</option>
              <option value="next30Days">Next 30 days</option>
            </select>
          ) : (
            <>
              {/*
                Calendar-only, and at the head of the row rather than replacing
                it: the shared filters below still narrow the grid, which is the
                whole reason the calendar reads `filtered` instead of going over
                IPC like the agenda does.
              */}
              {view === "calendar" && (
                <div className="cal-toolbar">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setMonth((m) => stepMonth(m, -1))}
                    title="Previous month ([)"
                  >
                    ‹
                  </button>
                  <span>{monthLabel(month)}</span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setMonth((m) => stepMonth(m, 1))}
                    title="Next month (])"
                  >
                    ›
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setMonth(todayIso().slice(0, 7))}
                  >
                    Today
                  </button>
                </div>
              )}
              <select value={status} onChange={(e) => setStatus(e.target.value as Status | "all")}>
                <option value="all">Any status</option>
                {BOARD_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
              <select value={cadence} onChange={(e) => setCadence(e.target.value)}>
                <option value="all">Any cadence</option>
                <option value="none">One-off</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
              </select>
              {/*
                Absent rather than empty in a vault where nobody has used the
                field: a select offering only "Any reporter" is a control that
                cannot do anything, and the toolbar is already five wide.
              */}
              {reporters.length > 0 && (
                <select
                  value={reporter}
                  onChange={(e) => setReporter(e.target.value)}
                  title="Who asked for the work"
                >
                  <option value="all">Any reporter</option>
                  {reporters.map((name) => (
                    <option key={name} value={name.toLowerCase()}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
              {/*
                Toggles rather than a select, because "everything except
                subtasks" is one of the two things worth asking for and a select
                cannot say it. A role=group of aria-pressed buttons, not a
                tablist: selection here is not exclusive, and aria-selected
                would tell a screen reader it was.
              */}
              <div
                className="chips"
                role="group"
                aria-label="Filter by type"
                title="Show only these types. With none picked, every type is shown."
              >
                {ITEM_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="chip"
                    aria-pressed={types.has(t)}
                    onClick={() => toggleType(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <label
                className="status-line"
                style={{ cursor: "pointer" }}
                title="Hides both endings — work that got done, and work that was disregarded"
              >
                <input
                  type="checkbox"
                  checked={openOnly}
                  onChange={(e) => setOpenOnly(e.target.checked)}
                />
                Hide closed
              </label>
              {/*
                Board-only, so it is absent on the backlog rather than present
                and inert. A checkbox and not a .chip: .chip capitalizes its
                label, which would render this as "Group By Project".
              */}
              {view === "board" && (
                <label
                  className="status-line"
                  style={{ cursor: "pointer" }}
                  title="One band per project, in sidebar order (g)"
                >
                  <input
                    type="checkbox"
                    checked={grouped}
                    onChange={(e) => setGrouped(e.target.checked)}
                  />
                  Group by project
                </label>
              )}
            </>
          )}

          <div className="spacer" />

          {/*
            This filters the view. Ctrl-K is the other one, and it searches the
            whole vault regardless of what is filtered here — the two are
            deliberately different tools, so the placeholder says which this is.
          */}
          <input
            ref={searchRef}
            type="search"
            placeholder="Filter this view… (/)"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            className="btn"
            onClick={() => setPaletteOpen(true)}
            title="Search the whole vault (Ctrl-K)"
          >
            Search
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setCreating({})}
            title="New item (n)"
          >
            + New
          </button>
        </div>

        {vault.error && (
          <div className="banner banner-warn">
            <span style={{ flex: 1 }}>{vault.error}</span>
            <button className="banner-close" onClick={vault.dismissError} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}

        {/* Without this, a file with broken YAML just vanishes from every view. */}
        {snapshot.errors.length > 0 && (
          <div className="banner banner-warn">
            <span style={{ flex: 1 }}>
              <strong>
                {snapshot.errors.length} file{snapshot.errors.length === 1 ? "" : "s"} failed to
                parse
              </strong>{" "}
              and {snapshot.errors.length === 1 ? "is" : "are"} not shown anywhere:{" "}
              {snapshot.errors.map((e, i) => (
                <span key={i}>
                  {i > 0 && "; "}
                  <code>{e}</code>
                </span>
              ))}
            </span>
          </div>
        )}

        {!snapshot.git.healthy && (
          <div className="banner banner-info">
            <span style={{ flex: 1 }}>
              Writes are not being committed, so there is no undo history.{" "}
              {snapshot.git.ignored
                ? "The repository this vault sits in ignores it."
                : snapshot.git.isRepo
                  ? snapshot.git.lastError
                  : "The vault folder is not a git repository."}{" "}
              Deletes still go to <code>.trash</code> and stay recoverable.
            </span>
          </div>
        )}

        <div className={`content${bulkBarOpen ? " content-with-bulk-bar" : ""}`}>
          {view === "backlog" && (
            <BacklogTable
              items={filtered}
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
              selected={selected}
              onSelect={open}
              checked={checked}
              onCheck={toggleCheck}
              onCheckAll={setCheckedMany}
            />
          )}
          {view === "board" && (
            <Board
              items={filtered}
              projectOrder={projectOrder}
              projectNames={projectNames}
              grouped={grouped}
              selected={selected}
              onSelect={open}
              onTransition={(key, next) =>
                void vault.mutate(() => window.vault.transitionItem(key, next))
              }
              onReorder={(key, position) =>
                void vault.mutate(() => window.vault.moveItem(key, position))
              }
            />
          )}
          {view === "agenda" && (
            <Agenda
              scope={scope}
              /*
                Not snapshot.items: the agenda's sections are computed in the
                core, over the whole vault, so this is the only thing keeping a
                hidden project's overdue work off the agenda. Without it, hiding
                would silence the board and the backlog but not the one view
                that leads with "Overdue".
              */
              items={visibleItems}
              selected={selected}
              onSelect={open}
              onOrder={setAgendaOrder}
              onTick={(key, undo) =>
                void vault.mutate(() => window.vault.tickItem(key, undefined, undo))
              }
            />
          )}
          {view === "calendar" && (
            <Calendar
              month={month}
              items={filtered}
              today={todayIso()}
              selected={selected}
              onSelect={open}
              onJumpToMonth={setMonth}
            />
          )}
          {view === "history" && (
            <History
              git={snapshot.git}
              project={historyProject}
              /* Deliberately not visibleItems — see the memo above. */
              liveKeys={liveKeys}
              onSelect={open}
            />
          )}
        </div>

        {/*
          Anchored to the bottom of .main, out of normal flow — see .bulk-bar's
          CSS. In flow it pushed .content down by its own height the instant a
          first checkbox was ticked, which read as the whole table jumping.
          Positioned rather than in the .toast slot for the reason recorded
          there: the undo toast can appear at the same moment a bulk edit
          finishes, and the two would collide in one fixed spot.
        */}
        {bulkBarOpen && (
          <BulkBar
            checkedItems={checkedItems}
            hiddenByFilter={checkedHiddenByFilter}
            reporters={allReporters}
            busy={vault.busy}
            onClear={clearChecked}
            onUpdate={(patch) => vault.updateItems([...checked], patch)}
          />
        )}
      </main>

      {detailItem && (
        <ItemDetail
          item={detailItem}
          /* Parent choices, filtered like the create form's: a project this
             window says is not there is not somewhere to file work under. */
          items={visibleItems}
          reporters={allReporters}
          editSummary={editSummaryFor === detailItem.key}
          onEditSummaryConsumed={() => setEditSummaryFor(null)}
          onClose={() => setDetailKey(null)}
          onSelect={open}
          onDelete={handleDelete}
          onNewChild={(parent, type) =>
            setCreating({ project: parent.project, type, parent: parent.key })
          }
          mutate={vault.mutate}
          attachPaths={vault.attachPaths}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          /*
            Hidden projects and their items are out of the palette too. It sets
            the sidebar filter, and jumping to a project that is not in the
            sidebar would land on an empty view with nothing explaining it.
          */
          items={visibleItems}
          projects={visibleProjects}
          onClose={() => setPaletteOpen(false)}
          onSelectItem={open}
          onSelectProject={setProject}
        />
      )}

      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}

      {claudeOpen && <ClaudeSettings onClose={() => setClaudeOpen(false)} />}

      {creating && (
        <CreateDialog
          /* No creating work into a project you cannot see it land in. */
          projects={visibleProjects}
          items={visibleItems}
          reporters={allReporters}
          /* The sidebar's project, unless a prefill names the parent's. */
          defaultProject={creating.project ?? project}
          defaultType={creating.type}
          defaultParent={creating.parent}
          onClose={() => setCreating(null)}
          onCreate={vault.createItem}
        />
      )}

      {creatingProject && (
        <ProjectDialog
          /*
            Every project, hidden included — this list is only used to catch a
            key that is already taken, and a hidden project's key is still taken.
          */
          projects={snapshot.projects}
          onClose={() => setCreatingProject(false)}
          onCreate={handleCreateProject}
        />
      )}

      {showTrash && (
        <TrashPanel
          onClose={() => setShowTrash(false)}
          onRestore={(file) => vault.restore([file])}
        />
      )}

      {showHidden && (
        <HiddenPanel
          projects={hiddenProjects}
          busy={vault.busy}
          onClose={() => setShowHidden(false)}
          onUnhide={handleUnhideProject}
        />
      )}

      {vault.undo && (
        <div className="toast">
          <span style={{ flex: 1 }}>{vault.undo.message}</span>
          <button
            className="btn"
            onClick={() => void vault.restore(vault.undo?.files ?? [])}
            disabled={vault.busy}
          >
            Undo
          </button>
          <button className="banner-close" onClick={vault.dismissUndo} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

function monthLabel(month: string): string {
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(year, monthIndex - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function shortenPath(full: string): string {
  const parts = full.split(/[\\/]/);
  return parts.length <= 3 ? full : `…${parts.slice(-2).join("/")}`;
}

function gitTitle(git: { healthy: boolean; repoRoot?: string; lastError?: string }): string {
  if (git.healthy) return `Every write is committed to ${git.repoRoot}`;
  return git.lastError ?? "Auto-commit is not active for this vault";
}
