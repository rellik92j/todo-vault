import type { ThemePreference } from "@shared/api";

/**
 * The theme control's state machine, such as it is.
 *
 * Pure and separate from App.tsx for the same reason ordering.ts and
 * selection.ts are: it is the only part of this feature a test can reach without
 * launching Electron. Everything else — that `themeSource` actually flips the
 * media query, that the picker popup follows — needs a real window.
 *
 * `ThemePreference` comes from the shared contract rather than being restated
 * here, so main and renderer cannot disagree about the three strings.
 */
export type { ThemePreference };

/**
 * One button, cycled, rather than three segments.
 *
 * A `.chips` group is the house idiom for a small exclusive set, but the sidebar
 * is 236px and its foot row already wraps at six buttons — three more segments
 * push it to a third line for the least-pressed control in the app.
 */
export const THEME_CYCLE: readonly ThemePreference[] = ["system", "light", "dark"];

/**
 * The next state in the cycle.
 *
 * An unrecognised current value lands on `system`: indexOf returns -1, and -1 + 1
 * is 0. That is the right destination anyway — `system` is the default, and it is
 * the state a confused control should recover to.
 */
export function nextTheme(current: ThemePreference): ThemePreference {
  const index = THEME_CYCLE.indexOf(current);
  return THEME_CYCLE[(index + 1) % THEME_CYCLE.length] ?? "system";
}

/**
 * Labelled with the state it is *in*, never the state pressing would move to.
 *
 * That settles the ambiguity every mode button has — "does ☾ mean it *is* dark,
 * or that pressing makes it dark?" — and it is the reading that stays true when
 * the OS flips underneath `Auto`.
 */
export const THEME_LABELS: Record<ThemePreference, { glyph: string; label: string }> = {
  system: { glyph: "◐", label: "Auto" },
  light: { glyph: "☀", label: "Light" },
  dark: { glyph: "☾", label: "Dark" },
};

/** Spelled out for the screen reader, since three glyphs are not a label. */
export const THEME_DESCRIPTIONS: Record<ThemePreference, string> = {
  system: "Theme: following the system",
  light: "Theme: light",
  dark: "Theme: dark",
};
