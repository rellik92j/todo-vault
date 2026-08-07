import assert from "node:assert/strict";
import test from "node:test";

import { shortcutScript, wscriptPath } from "./shortcut.mjs";

const REPO = "C:\\Users\\me\\Desktop\\files";
const WSCRIPT = "C:\\Windows\\System32\\wscript.exe";

test("the shortcut targets the script host, not the script", () => {
  // A .lnk pointing straight at launch.vbs is resolved through the .vbs file
  // association, which is not reliably wscript — an administrator or a stray
  // "Open with" can leave it opening an editor, and then double-clicking the
  // shortcut shows Notepad rather than starting the app.
  const script = shortcutScript(REPO, WSCRIPT);

  assert.ok(script.includes(`$s.TargetPath = '${WSCRIPT}'`));
  assert.ok(script.includes(`$s.Arguments = '"${REPO}\\scripts\\launch.vbs"'`));
});

test("the launcher path stays quoted inside the argument string", () => {
  // Arguments reaches wscript as a command line rather than as an argv, so an
  // unquoted path breaks at the first space — and the default clone lives under
  // a profile directory that frequently has one.
  const script = shortcutScript("C:\\Users\\Ada Lovelace\\todo-vault", WSCRIPT);

  assert.ok(script.includes(`'"C:\\Users\\Ada Lovelace\\todo-vault\\scripts\\launch.vbs"'`));
});

test("the desktop is asked for, not assembled from the home directory", () => {
  // OneDrive's Known Folder Move redirects Desktop into the synced folder, so
  // ~/Desktop is stale or absent on a machine with it enabled.
  const script = shortcutScript(REPO, WSCRIPT);

  assert.ok(script.includes("[Environment]::GetFolderPath('Desktop')"));
  assert.ok(!script.includes("USERPROFILE"));
});

test("a quote in a path cannot end the PowerShell literal early", () => {
  const script = shortcutScript("C:\\Users\\O'Brien\\todo-vault", WSCRIPT);

  assert.ok(script.includes("C:\\Users\\O''Brien\\todo-vault"));
});

test("a dollar sign in a path is not expanded", () => {
  // Single-quoted literals are what stops this; a double-quoted one would turn
  // the folder into an empty variable and point the shortcut somewhere else.
  const script = shortcutScript("D:\\$vaults\\todo-vault", WSCRIPT);

  assert.ok(script.includes(`$s.WorkingDirectory = 'D:\\$vaults\\todo-vault'`));
});

test("the icon comes from the Electron binary, since the repo has no .ico", () => {
  const script = shortcutScript(REPO, WSCRIPT);

  assert.ok(
    script.includes(`$s.IconLocation = '${REPO}\\node_modules\\electron\\dist\\electron.exe,0'`),
  );
});

test("wscript is resolved under SystemRoot rather than assumed to be on C:", () => {
  assert.equal(wscriptPath({ SystemRoot: "D:\\Windows" }), "D:\\Windows\\System32\\wscript.exe");
  assert.equal(wscriptPath({}), "C:\\Windows\\System32\\wscript.exe");
});
