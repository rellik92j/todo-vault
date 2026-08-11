/**
 * Drives the theme toggle end to end — Part 1 of `plans/PLAN-theme-toggle.md`.
 *
 * `theme.test.ts` already proves the cycle is a cycle. Everything that actually
 * matters about this feature is outside a pure function: that
 * `nativeTheme.themeSource` really does move `prefers-color-scheme` in the
 * renderer, that the *stylesheet* follows rather than just Electron, that the
 * choice survives a relaunch, and that the colour painted before the renderer
 * exists matches the one it will paint. Only a real window can say.
 *
 * Two launches, and the second is the interesting one. `keepStem` on the first
 * close is what lets it read back the settings.json the first wrote.
 *
 * `colorScheme: null` on both is not optional and is not tidiness. Playwright's
 * `electron.launch` emulates `prefers-color-scheme: light` by default, over CDP,
 * above whatever `themeSource` says — so without it this spec watched Electron
 * flip to dark while the page stayed obstinately light, which is a true report
 * about the harness and a false one about the app.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { launchHarness, type Harness } from "./harness.mjs";

/** Copies of `--bg` in each block of src/renderer/src/index.css, as main holds them. */
const DARK_BG = "#0f1115";
const DARK_BG_RGB = "rgb(15, 17, 21)";

/** Reads the app's own settings.json, not the one the harness seeded. */
async function savedTheme(userDataDir: string): Promise<unknown> {
  const raw = await fs.readFile(path.join(userDataDir, "settings.json"), "utf8");
  return (JSON.parse(raw) as { theme?: unknown }).theme;
}

const themeSource = (harness: Harness): Promise<string> =>
  harness.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);

/** The button labels itself with the state it is in — see renderer/src/theme.ts. */
const themeButton = (harness: Harness) => harness.page.locator(".sidebar-foot button[aria-label^='Theme:']");

describe("the theme is chosen rather than inherited", { concurrency: 1 }, () => {
  let harness: Harness;
  let stem: string;

  before(async () => {
    harness = await launchHarness({ colorScheme: null });
    stem = harness.stem;
  });

  after(async () => {
    await harness.close();
  });

  test("with no theme in settings the app follows the OS, and the button says so", async () => {
    assert.equal(await themeSource(harness), "system");
    assert.equal(await savedTheme(harness.userDataDir), undefined);

    const button = themeButton(harness);
    await button.waitFor({ state: "visible" });
    assert.match(await button.innerText(), /Auto/);
    assert.equal(await button.getAttribute("aria-label"), "Theme: following the system");
  });

  test("two presses reach Dark, and the media query in the renderer moves with it", async () => {
    const button = themeButton(harness);
    await button.click(); // system -> light
    await button.click(); // light -> dark

    // Electron's side first, then the page's. Both, because either alone would
    // pass while the other silently did nothing.
    assert.equal(await themeSource(harness), "dark");
    await harness.page.waitForFunction(
      () => window.matchMedia("(prefers-color-scheme: dark)").matches,
      undefined,
      { timeout: 5_000 },
    );
  });

  test("the stylesheet followed, not just Electron", async () => {
    // The assertion the whole `themeSource`-over-`data-theme` argument rests on:
    // no CSS was written for this feature, so a body painted with the dark --bg
    // is proof the untouched media query is the thing the button drives.
    const background = await harness.page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    assert.equal(background, DARK_BG_RGB);
  });

  test("the choice is on disk, beside the vault root it did not disturb", async () => {
    assert.equal(await savedTheme(harness.userDataDir), "dark");
    const raw = await fs.readFile(path.join(harness.userDataDir, "settings.json"), "utf8");
    const settings = JSON.parse(raw) as { vaultRoot?: string };
    assert.equal(settings.vaultRoot, harness.vaultRoot);
  });

  test("a relaunch paints the saved scheme before the renderer exists", async () => {
    await harness.close({ keepStem: true });
    harness = await launchHarness({ stem, colorScheme: null });

    assert.equal(await themeSource(harness), "dark");

    // The honest check on the no-flash claim. getBackgroundColor reads the
    // colour Chromium paints *before* the first frame, which no page assertion
    // can see — a theme applied on did-finish-load would pass every check above
    // and fail this one.
    const background = await harness.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getBackgroundColor(),
    );
    assert.equal(String(background).toLowerCase(), DARK_BG);

    // And the renderer painted dark without anyone pressing anything, which is
    // what applySavedTheme() running before createWindow() buys.
    const rendered = await harness.page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    assert.equal(rendered, DARK_BG_RGB);

    assert.match(await themeButton(harness).innerText(), /Dark/);
  });

  test("cycling past Dark returns to following the OS", async () => {
    await themeButton(harness).click(); // dark -> system
    assert.equal(await themeSource(harness), "system");
    assert.equal(await savedTheme(harness.userDataDir), "system");
    assert.match(await themeButton(harness).innerText(), /Auto/);
  });
});
