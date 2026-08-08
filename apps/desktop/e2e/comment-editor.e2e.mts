/**
 * Drives the comment editor end to end, against the built app and a throwaway
 * seeded vault — the interactive checks `d96ecc5` ("Give comments the
 * description's editor, not a single-line input") left for a human, because
 * that session had no way to drive the Electron window itself.
 *
 * One app, one vault, ordered subtests (`{ concurrency: 1 }`): each later
 * check depends on the state the one before it left behind, same as a person
 * clicking through the panel top to bottom.
 *
 * Two layers, throughout. The DOM says what the app drew; the file says what
 * the app did. Only the second is what a comment *is* — so every check that
 * claims something happened (or did not) confirms it on both sides.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { ARTIFACTS_DIR, launchHarness, type Harness } from "./harness.mjs";
import {
  commentEditorSurface,
  commentForm,
  eventually,
  findItemKey,
  openItem,
  readComments,
  stays,
} from "./drive.mjs";

describe("the comment editor, driven end to end", { concurrency: 1 }, () => {
  let harness: Harness;
  let key: string;
  let draft: string;

  before(async () => {
    harness = await launchHarness();
    // "Agree the target reporting schema" is in_progress and open, and
    // `collapsed` initialises empty so its epic parent is already expanded —
    // the row is on screen with no setup.
    key = await findItemKey(harness.vaultRoot, "Agree the target reporting schema");
    await openItem(harness.page, key);
  });

  after(async () => {
    await harness.close();
  });

  test("an old plain-text comment renders as markdown", async () => {
    // Seeded by seed-vault.ts as a comment typed into a plain input by someone
    // with no reason to think markdown was in play — its backtick span now
    // renders as code, because old comments are reinterpreted on screen, not
    // rewritten on disk.
    const commentBody = harness.page.locator(".comment .comment-body.prose").first();
    await commentBody.waitFor({ state: "visible" });

    const codeSpans = commentBody.locator("code");
    assert.equal(await codeSpans.count(), 1);
    assert.equal((await codeSpans.first().innerText()).trim(), "dim_customer");

    const rendered = await commentBody.innerText();
    assert.ok(!rendered.includes("`"), `expected no literal backtick left in the DOM, saw: ${rendered}`);

    assert.equal(await commentBody.evaluate((el) => el.classList.contains("prose")), true);

    // The bargain this feature actually struck: reinterpreted on screen, not
    // rewritten on disk. Nothing else in this suite says that in one line.
    const comments = await readComments(harness.vaultRoot, key);
    assert.ok(
      comments.some((c) => c.body.includes("`dim_customer`")),
      "expected the file to still hold the literal backtick span",
    );
  });

  test("the hint is absent, with its own positive control", async () => {
    // Without the positive control below, "count is 0" would also pass if
    // .field-note were renamed, if the selector were wrong, or if no panel
    // were open at all.
    const commentFormNotes = commentForm(harness.page).locator(".field-note");
    assert.equal(await commentFormNotes.count(), 0);

    await harness.page.getByRole("button", { name: "edit", exact: true }).click();
    const descriptionSection = harness.page
      .locator(".detail-section")
      .filter({ has: harness.page.locator("h3", { hasText: "Description" }) });
    const descriptionNotes = descriptionSection.locator(".field-note");
    await descriptionNotes.first().waitFor({ state: "visible" });
    assert.equal(await descriptionNotes.count(), 1);

    // Focus the surface before Escape: the handler that owns Escape is bound
    // capture-phase on the rich editor's own container, so it only sees the
    // key if the event's path runs through it.
    await descriptionSection.locator(".rich-surface[contenteditable]").click();
    await harness.page.keyboard.press("Escape");
    await descriptionNotes.first().waitFor({ state: "hidden" }).catch(() => {});
    assert.equal(await descriptionNotes.count(), 0);
    assert.equal(await commentFormNotes.count(), 0);
  });

  test("blur does not post", async () => {
    draft = "The legacy names should stay in place until Q3 closes.";

    await commentEditorSurface(harness.page).click();
    // pressSequentially, not fill(): fill() bypasses the input pipeline
    // ProseMirror's state machine actually listens to.
    await commentEditorSurface(harness.page).pressSequentially(draft);

    const submitButton = commentForm(harness.page).locator('button[type="submit"]');
    await eventually(
      "the Comment button enables once there is a draft",
      () => submitButton.isEnabled(),
      (enabled) => enabled === true,
    );

    const domCountBefore = await harness.page.locator(".comment").count();
    const diskCommentsBefore = await readComments(harness.vaultRoot, key);

    // Blur by clicking a plain, non-focusable <span> in the panel header —
    // not Tab, which StarterKit's listItem binds, so it would mean something
    // different depending on which block has focus.
    await harness.page.locator(".detail-head .cell-key").click();

    // The biggest false-pass risk in this file: confirm the blur actually
    // happened before concluding anything from what did *not* follow it.
    const editorHandle = await commentEditorSurface(harness.page).elementHandle();
    const blurred = await harness.page.evaluate(
      (el) => document.activeElement !== el,
      editorHandle,
    );
    assert.equal(blurred, true, "expected focus to have left the comment editor");

    await stays("DOM comment count after blur", () => harness.page.locator(".comment").count(), domCountBefore);
    const diskCommentsAfter = await readComments(harness.vaultRoot, key);
    assert.equal(diskCommentsAfter.length, diskCommentsBefore.length);

    const survived = await commentEditorSurface(harness.page).innerText();
    assert.equal(survived.trim(), draft);
  });

  test("Ctrl+Enter is inert", async () => {
    // Refocus: check 3 deliberately left focus outside the editor, and
    // Ctrl+Enter only means anything to the handler if the event's path runs
    // through the rich editor's own capture listener.
    await commentEditorSurface(harness.page).click();
    const editorHandle = await commentEditorSurface(harness.page).elementHandle();
    const focused = await harness.page.evaluate((el) => document.activeElement === el, editorHandle);
    assert.equal(focused, true, "expected focus back in the comment editor before Ctrl+Enter");

    const domCountBefore = await harness.page.locator(".comment").count();
    const diskCommentsBefore = await readComments(harness.vaultRoot, key);
    const textBefore = await commentEditorSurface(harness.page).innerText();

    await harness.page.keyboard.press("Control+Enter");

    // "Inert" means it did nothing, not that it did something else — the
    // capture-phase handler preventDefaults Ctrl+Enter precisely so TipTap's
    // Mod-Enter -> hardBreak never runs. Zero <br> is the assertion that would
    // catch that handler moving to the bubble phase; the counts alone would not.
    await stays(
      "DOM comment count after Ctrl+Enter",
      () => harness.page.locator(".comment").count(),
      domCountBefore,
    );
    const diskCommentsAfter = await readComments(harness.vaultRoot, key);
    assert.equal(diskCommentsAfter.length, diskCommentsBefore.length);

    assert.equal(await commentEditorSurface(harness.page).locator("br").count(), 0);

    const textAfter = await commentEditorSurface(harness.page).innerText();
    assert.equal(textAfter, textBefore);

    const editorHandleAfter = await commentEditorSurface(harness.page).elementHandle();
    const stillFocused = await harness.page.evaluate(
      (el) => document.activeElement === el,
      editorHandleAfter,
    );
    assert.equal(stillFocused, true, "expected focus to remain in the comment editor");
  });

  test("posting for real works", async () => {
    // The positive control the two negative checks above depend on. Without
    // it, "blur does not post" and "Ctrl+Enter is inert" are unfalsifiable —
    // satisfied just as happily by a broken app, a missed click, or a wrong
    // selector as by the real thing.
    const domCountBefore = await harness.page.locator(".comment").count();
    const diskCommentsBefore = await readComments(harness.vaultRoot, key);

    await commentForm(harness.page).locator('button[type="submit"]').click();

    await eventually(
      "DOM comment count after posting",
      () => harness.page.locator(".comment").count(),
      (n) => n === domCountBefore + 1,
    );
    const diskCommentsAfter = await eventually(
      "disk comment count after posting",
      () => readComments(harness.vaultRoot, key),
      (comments) => comments.length === diskCommentsBefore.length + 1,
    );
    assert.equal(diskCommentsAfter[diskCommentsAfter.length - 1]?.body, draft);

    // The commentGeneration remount: RichEditor takes its content once, at
    // mount, so clearing the draft after a post has to happen by remounting it
    // rather than by pushing a new value in.
    await eventually(
      "the comment editor clears after posting",
      () => commentEditorSurface(harness.page).innerText(),
      (text) => text.trim() === "",
    );
    await eventually(
      "the Comment button disables once the draft is gone",
      () => commentForm(harness.page).locator('button[type="submit"]').isDisabled(),
      (disabled) => disabled === true,
    );
  });

  test("a quoted comment renders with visible separation from the comment's own border", async () => {
    // .comment and .prose blockquote share the identical border-left
    // declaration (index.css:1391,1531) — two same-coloured 2px rules stacked.
    // The failure worth catching mechanically is that they come out flush,
    // reading as one thick rule or an artefact.
    const quoteText = "Backfill still needs three full years, not two.";

    await commentEditorSurface(harness.page).click();
    // The toolbar button, not the `> ` input rule: a deterministic target with
    // a stable accessible name, rather than something depending on caret
    // position and StarterKit's rule set. Quote's title has no double space,
    // unlike Bold/Italic/Link's.
    await commentForm(harness.page).locator('.rich-toolbar button[title="Quote"]').click();
    await commentEditorSurface(harness.page).pressSequentially(quoteText);

    const domCountBefore = await harness.page.locator(".comment").count();
    await commentForm(harness.page).locator('button[type="submit"]').click();
    await eventually(
      "DOM comment count after posting the quote",
      () => harness.page.locator(".comment").count(),
      (n) => n === domCountBefore + 1,
    );

    const newestComment = harness.page.locator(".comment").last();
    const blockquote = newestComment.locator(".comment-body.prose blockquote");
    await blockquote.waitFor({ state: "visible" });
    assert.equal((await blockquote.innerText()).trim(), quoteText);

    const commentBox = await newestComment.boundingBox();
    const quoteBox = await blockquote.boundingBox();
    assert.ok(commentBox && quoteBox, "expected both boxes to be measurable");
    const offset = quoteBox!.x - commentBox!.x;
    assert.ok(
      offset >= 8,
      `expected the quote's border to sit at least ~8px inside the comment's own, saw ${offset}px`,
    );

    /**
     * Everything above is mechanical and everything below is not. The DOM
     * assertions prove the markup and the measured offset; they cannot prove
     * the borders actually *read* as two rules to a person looking at the
     * screen, in either colour scheme. PLAN.md's own precedent, from the
     * reporter datalist: "a check that reads the DOM cannot verify a native
     * control" — that bug was invisible to every assertion the page could
     * make about itself, and survived a run that reported green on every
     * point. A border is the same kind of thing: reading these screenshots is
     * the actual check for this part, not this test passing.
     */
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
    const detailPanel = harness.page.locator("aside.detail");

    await newestComment.screenshot({ path: path.join(ARTIFACTS_DIR, "quoted-comment.png") });

    // Forced explicitly rather than relying on whatever this machine's OS
    // theme happens to be — index.css defaults :root to dark and overrides to
    // light only under `prefers-color-scheme: light`, so leaving the scheme
    // unset here would screenshot the same rendering twice on a light-mode
    // host and never exercise the dark declarations at all.
    await harness.page.emulateMedia({ colorScheme: "dark" });
    await detailPanel.screenshot({ path: path.join(ARTIFACTS_DIR, "panel-dark.png") });

    await harness.page.emulateMedia({ colorScheme: "light" });
    await detailPanel.screenshot({ path: path.join(ARTIFACTS_DIR, "panel-light.png") });

    console.log(`wrote screenshots to ${ARTIFACTS_DIR}`);
  });
});
