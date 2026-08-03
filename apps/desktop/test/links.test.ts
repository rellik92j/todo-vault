import assert from "node:assert/strict";
import test from "node:test";

import { parseUriList } from "../src/renderer/src/drops.js";
import { parseUserFolders, syncedRootsFromEnv } from "../src/main/synced-roots.js";

test("parseUriList takes the URLs out of a drag and drops the rest", () => {
  // RFC 2483 shape: comments, CRLF, and a trailing blank line.
  const payload = "# comment\r\nhttps://contoso-my.sharepoint.com/:x:/g/personal/sam/EaBc\r\n\r\n";
  assert.deepEqual(parseUriList(payload), [
    "https://contoso-my.sharepoint.com/:x:/g/personal/sam/EaBc",
  ]);

  assert.deepEqual(parseUriList("https://a.test/1\nhttps://b.test/2"), [
    "https://a.test/1",
    "https://b.test/2",
  ]);

  // Chrome sends the same URL twice — once as uri-list, once as the title line
  // in some sources — and two identical links is not what the gesture meant.
  assert.deepEqual(parseUriList("https://a.test/1\nhttps://a.test/1"), ["https://a.test/1"]);

  // A scheme the main process would refuse to open should never become a link
  // that is dead the moment it is clicked.
  assert.deepEqual(parseUriList("file:///C:/Users/sam/plan.xlsx"), []);
  assert.deepEqual(parseUriList("javascript:alert(1)"), []);

  // A plain-text drag that carried no URL at all.
  assert.deepEqual(parseUriList("just some words"), []);
  assert.deepEqual(parseUriList(""), []);
});

test("syncedRootsFromEnv reads the OneDrive variables and dedupes them", () => {
  // `OneDrive` duplicates whichever account is primary, so the common case has
  // the same path under two names.
  assert.deepEqual(
    syncedRootsFromEnv({
      OneDrive: "C:\\Users\\sam\\OneDrive - Contoso",
      OneDriveCommercial: "C:\\Users\\sam\\OneDrive - Contoso",
      OneDriveConsumer: "C:\\Users\\sam\\OneDrive",
    }),
    ["C:\\Users\\sam\\OneDrive - Contoso", "C:\\Users\\sam\\OneDrive"],
  );

  assert.deepEqual(syncedRootsFromEnv({}), []);
  // An empty variable is not a root — treating "" as one would match every path.
  assert.deepEqual(syncedRootsFromEnv({ OneDrive: "", OneDriveCommercial: "   " }), []);
});

test("parseUserFolders pulls UserFolder values out of reg query output", () => {
  const output = [
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Business1",
    "    UserFolder    REG_SZ    C:\\Users\\sam\\OneDrive - Contoso",
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Personal",
    "    UserFolder    REG_EXPAND_SZ    C:\\Users\\sam\\OneDrive",
    "",
  ].join("\r\n");

  assert.deepEqual(parseUserFolders(output), [
    "C:\\Users\\sam\\OneDrive - Contoso",
    "C:\\Users\\sam\\OneDrive",
  ]);

  // The value can contain the same run of spaces that separates the columns,
  // which is why the split is on the type token rather than on whitespace.
  assert.deepEqual(
    parseUserFolders("    UserFolder    REG_SZ    C:\\Users\\sam\\OneDrive  -  Contoso"),
    ["C:\\Users\\sam\\OneDrive  -  Contoso"],
  );

  // Other values under the same key must not be mistaken for folders.
  assert.deepEqual(parseUserFolders("    DisplayName    REG_SZ    Sam"), []);
  assert.deepEqual(parseUserFolders(""), []);
});
