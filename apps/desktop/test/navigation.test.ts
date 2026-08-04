import assert from "node:assert/strict";
import test from "node:test";

import { isInAppNavigation } from "../src/main/navigation.js";

const PACKAGED = "file:///C:/Program%20Files/Vault/resources/app/renderer/index.html";
const DEV = "http://localhost:5173/";

test("the packaged app may reload itself", () => {
  assert.equal(isInAppNavigation(PACKAGED, PACKAGED), true);
  // A hash or query is the same document, so in-page navigation still works.
  assert.equal(isInAppNavigation(`${PACKAGED}#item`, PACKAGED), true);
  assert.equal(isInAppNavigation(`${PACKAGED}?x=1`, PACKAGED), true);
});

test("dev-server reloads survive, including HMR full refreshes", () => {
  assert.equal(isInAppNavigation(DEV, DEV), true);
  assert.equal(isInAppNavigation("http://localhost:5173/index.html", DEV), true);
  // A different port is a different origin, and not this app.
  assert.equal(isInAppNavigation("http://localhost:5174/", DEV), false);
});

test("a dropped web URL never replaces the app", () => {
  // The gesture this app invites: a document dragged out of the OneDrive web
  // UI. Dropped anywhere unhandled, it used to navigate the window.
  assert.equal(
    isInAppNavigation("https://contoso-my.sharepoint.com/:x:/g/personal/sam/EaBc", PACKAGED),
    false,
  );
  assert.equal(isInAppNavigation("https://evil.test/", DEV), false);
  assert.equal(isInAppNavigation("http://evil.test/", DEV), false);
});

test("a local file cannot ride in on the opaque file: origin", () => {
  // Every file: URL has origin "null", so an origin comparison would call all
  // of these same-origin as the packaged app and let them load — with the
  // preload, and the whole vault API, attached.
  assert.equal(isInAppNavigation("file:///C:/Users/sam/Downloads/invoice.html", PACKAGED), false);
  assert.equal(isInAppNavigation("file:///C:/Users/sam/plan.xlsx", PACKAGED), false);
  // Even a sibling of the real renderer entry point.
  assert.equal(
    isInAppNavigation(
      "file:///C:/Program%20Files/Vault/resources/app/renderer/other.html",
      PACKAGED,
    ),
    false,
  );
});

test("schemes cannot be crossed, and nonsense is not in-app", () => {
  // The dev build loading over http must not be talked into a file: load.
  assert.equal(isInAppNavigation("file:///C:/Users/sam/x.html", DEV), false);
  assert.equal(isInAppNavigation("javascript:alert(1)", PACKAGED), false);
  assert.equal(isInAppNavigation("not a url", PACKAGED), false);
  assert.equal(isInAppNavigation("", PACKAGED), false);
  // An unparseable *current* URL should fail closed rather than throw.
  assert.equal(isInAppNavigation(PACKAGED, ""), false);
});
