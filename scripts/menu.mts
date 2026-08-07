/**
 * A numbered launcher for the workspace's everyday commands.
 *
 *   npm run menu
 *
 * Every entry runs a single npm script, deliberately. Where a command is
 * really a sequence — a production preview has to build the core *first* — the
 * sequence belongs in package.json, where it also holds for anyone typing the
 * command directly. So this is a way to find and run those scripts, not a
 * second place their order is defined.
 *
 * What it does own is the entries that take input: the vault CLI and the
 * seeder. TypeScript rather than a .cmd file so it typechecks with everything
 * else and runs the same on any platform, and so their argument handling is a
 * real tokenizer rather than a batch-file quoting accident.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

import { REPO_ROOT, bold, cyan, dim, green, isMain, npmCli, red, yellow } from "./shared.mjs";

/**
 * tsx's JavaScript entry, run through `process.execPath` rather than as
 * `node_modules/.bin/tsx`. Same reason npm gets the same treatment: that path
 * is a batch shim on Windows, and Node will not spawn one without `shell: true`
 * — see `npmCli` in ./shared.mts for the whole argument.
 */
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

/** Null means npm's entry point was not found; main() decides what that means. */
const NPM_CLI = npmCli();

const CORE_CLI = "packages/core/src/cli.ts";
const SEED_SCRIPT = "packages/core/scripts/seed-vault.ts";

/**
 * The built server, not the source. Claude spawns this itself, outside npm and
 * outside tsx, so it has to be plain JavaScript — which is also why `[C]` warns
 * when the file is missing rather than letting someone paste a config that can
 * never start.
 */
const MCP_ENTRY = "packages/core/dist/mcp-server.js";

// ---------------------------------------------------------------- presentation

function clear(): void {
  if (process.stdout.isTTY) process.stdout.write("\u001b[2J\u001b[H");
}

function write(s: string): void {
  process.stdout.write(s);
}

// -------------------------------------------------------------------- commands

type Step =
  | { kind: "npm"; args: string[] }
  | { kind: "tsx"; script: string; args: string[] };

function describe(step: Step): string {
  return step.kind === "npm"
    ? `npm ${step.args.join(" ")}`
    : `tsx ${step.script}${step.args.length ? ` ${step.args.join(" ")}` : ""}`;
}

function spawnStep(step: Step): Promise<number> {
  // No branch needs a shell, so arguments reach the child as a real argv with
  // their quoting intact and no step has to keep them space-free.
  let command: string;
  let args: string[];

  if (step.kind === "tsx") {
    command = process.execPath;
    args = [TSX_CLI, path.join(REPO_ROOT, step.script), ...step.args];
  } else if (NPM_CLI) {
    command = process.execPath;
    args = [NPM_CLI, ...step.args];
  } else {
    command = "npm";
    args = step.args;
  }

  write(`${dim("$")} ${bold(describe(step))}\n\n`);

  return new Promise((settle) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: "inherit" });

    // The child owns the terminal now, and a Ctrl+C in a console reaches every
    // process attached to it. Without this the menu would die alongside the dev
    // server it launched; ignoring the signal here lets the child take it and
    // hands control back to the menu when it exits.
    const ignore = (): void => {};
    process.on("SIGINT", ignore);

    const done = (code: number): void => {
      process.off("SIGINT", ignore);
      settle(code);
    };

    child.on("exit", (code, signal) => done(signal ? 130 : (code ?? 0)));
    child.on("error", (err: Error) => {
      write(red(`\ncould not start ${command}: ${err.message}\n`));
      done(127);
    });
  });
}

/** Runs steps in order and stops at the first failure, the way `&&` would. */
async function runSteps(steps: Step[]): Promise<number> {
  for (const step of steps) {
    const code = await spawnStep(step);
    if (code !== 0) return code;
  }
  return 0;
}

// ----------------------------------------------------------------------- input

/**
 * One keypress, no Enter. Resolves only for keys in `valid`; `null` accepts any.
 *
 * Raw mode is the reason this is fiddly: it turns off the terminal's own Ctrl+C
 * handling, so SIGINT never fires and the interrupt has to be recognised as the
 * byte 0x03. It also has to be fully torn down before anything else touches
 * stdin, or the menu and a child process end up competing for the same keys.
 */
function readKey(valid: Set<string> | null): Promise<string> {
  const stdin = process.stdin;

  if (!stdin.isTTY) return readKeyFromLine(valid);

  return new Promise((settle) => {
    const detach = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (chunk: string): void => {
      if (chunk === "\u0003") {
        detach();
        write("\n");
        process.exit(0);
      }
      const key = chunk.trim().toLowerCase();
      // Anything unrecognised — arrow keys, stray escape sequences — is simply
      // not an answer, so keep waiting rather than treating it as one.
      if (valid && !valid.has(key)) return;
      detach();
      settle(valid ? key : chunk);
    };

    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** Piped or redirected stdin: no raw mode available, so read a line instead. */
async function readKeyFromLine(valid: Set<string> | null): Promise<string> {
  const answer = (await ask("")).toLowerCase();
  if (!valid || valid.has(answer)) return answer;
  // Unreadable or unrecognised input with nobody there to correct it: leave,
  // rather than redrawing a menu no one is going to answer.
  return "0";
}

let pipedInput: readline.Interface | null = null;
let stdinEnded = false;
const pipedLines: string[] = [];
let awaitingLine: ((line: string) => void) | null = null;

/**
 * Queues every line arriving on a non-TTY stdin.
 *
 * A readline interface starts flowing as soon as it is created and emits a
 * `line` event per line as fast as the stream delivers them. `rl.question()`
 * only captures the line that arrives *while it is pending*, so with a pipe —
 * where the whole input is usually available at once — every line after the
 * first is emitted into the void and later prompts read nothing. Draining into
 * a queue decouples arrival from consumption, which is what makes the menu
 * scriptable (`printf '8\nagenda week\n' | npm run menu`) and testable at all.
 */
function pipedReader(): void {
  if (pipedInput) return;

  pipedInput = readline.createInterface({ input: process.stdin });

  const deliver = (line: string): void => {
    if (awaitingLine) {
      const resolve = awaitingLine;
      awaitingLine = null;
      resolve(line);
    } else {
      pipedLines.push(line);
    }
  };

  pipedInput.on("line", deliver);
  pipedInput.once("close", () => {
    stdinEnded = true;
    // Anything still waiting would otherwise hang forever, and with no handles
    // left Node would exit mid-menu without a word.
    if (awaitingLine) deliver("");
  });
}

function readPipedLine(): Promise<string> {
  pipedReader();
  const queued = pipedLines.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (stdinEnded) return Promise.resolve("");
  return new Promise((resolve) => {
    awaitingLine = resolve;
  });
}

async function ask(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    write(prompt);
    return (await readPipedLine()).trim();
  }

  // A TTY never ends underneath us, so a per-prompt interface is safe here —
  // and closing it each time keeps readline's stdin listeners from colliding
  // with the raw-mode key handling above.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } catch {
    return "";
  } finally {
    rl.close();
    process.stdin.pause();
  }
}

/**
 * Splits a typed command line into argv, honouring quotes.
 *
 * `vault new --project ENG --summary "Two words"` is the case that matters: a
 * plain `.split(/\s+/)` turns that summary into two arguments and the CLI sees
 * a malformed flag.
 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let quoted = false;

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      // `quoted` keeps a deliberate empty string (`--flag ""`) as an argument.
      if (current || quoted) {
        out.push(current);
        current = "";
        quoted = false;
      }
      continue;
    }
    current += ch;
  }
  if (current || quoted) out.push(current);
  return out;
}

/**
 * Unwraps a path that arrived wrapped in quotes.
 *
 * Explorer's "Copy as path" hands you `"C:\Users\...\Vault"`, quotes included,
 * and pasting that is the most likely way anyone supplies a non-default vault
 * on Windows. Left alone, the leading quote stops `path.resolve` recognising
 * the string as absolute, so it is joined onto the repo root instead —
 * producing a plausible-looking `VAULT_DIR` that points nowhere.
 *
 * Deliberately not `tokenize`. That splits on whitespace outside quotes, which
 * is right for an argument list and wrong for a single path: an *unquoted*
 * `C:\Users\me\OneDrive - Acme, LLC\Vault` would come back as five tokens, and
 * taking the first would truncate it at `OneDrive`. Trading one silent
 * corruption for another is not a fix. So: strip a matched pair of surrounding
 * quotes, and otherwise take the line exactly as typed, spaces and all.
 */
export function unquotePath(input: string): string {
  const trimmed = input.trim();
  const quote = trimmed[0];

  if ((quote === '"' || quote === "'") && trimmed.length >= 2 && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

// ------------------------------------------------------- the Claude MCP config

/**
 * Builds the `mcpServers` block that points a Claude at this checkout.
 *
 * Both paths arrive absolute and leave with forward slashes, on Windows too.
 * Backslashes are legal in JSON only when doubled, and this block exists to be
 * pasted and then hand-edited — someone moving their vault will retype the
 * value, and `C:\Users\...` survives that where `C:\\Users\\...` does not.
 * Node opens either on Windows, so the forgiving form is the correct one.
 *
 * Pure, and exported, so a test can assert the entry point is
 * `packages/core/dist/mcp-server.js`. The README carried the wrong path here
 * for a long time and nothing was in a position to notice.
 */
export function connectionSnippet(repoRoot: string, vaultDir: string): string {
  const slashes = (p: string): string => p.replaceAll("\\", "/");

  const config = {
    mcpServers: {
      "todo-vault": {
        command: "node",
        args: [slashes(path.join(repoRoot, MCP_ENTRY))],
        env: {
          VAULT_DIR: slashes(vaultDir),
          VAULT_GIT: "1",
        },
      },
    },
  };

  return JSON.stringify(config, null, 2);
}

/**
 * Where Claude Desktop keeps its config on this platform.
 *
 * Windows resolves for real; the others are printed in `~` form because this is
 * a line to read and follow, not a path anything here opens. If `APPDATA` is
 * somehow unset the literal is still a useful thing to paste into Explorer.
 */
function desktopConfigPath(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? "%APPDATA%", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return "~/Library/Application Support/Claude/claude_desktop_config.json";
  }
  return "~/.config/Claude/claude_desktop_config.json";
}

// ------------------------------------------------------------------- the menu

interface Entry {
  key: string;
  label: string;
  hint: string;
  group: string;
  run: () => Promise<number>;
}

const ENTRIES: Entry[] = [
  {
    key: "1",
    group: "Run",
    label: "Dev app",
    hint: "builds core, then Vite dev server + HMR — day-to-day editing",
    run: () => runSteps([{ kind: "npm", args: ["run", "dev"] }]),
  },
  {
    key: "2",
    group: "Run",
    label: "Prod preview",
    hint: "builds core, then production bundles over file:// — closest to what ships",
    run: () => runSteps([{ kind: "npm", args: ["run", "preview"] }]),
  },
  {
    key: "3",
    group: "Run",
    label: "Prod preview (reuse last build)",
    hint: "launches without rebuilding — only correct if nothing changed since",
    run: () => runSteps([{ kind: "npm", args: ["run", "preview:skip-build"] }]),
  },
  {
    key: "4",
    group: "Run",
    label: "MCP server",
    hint: "stdio server over the vault; Ctrl+C returns here",
    run: () => runSteps([{ kind: "npm", args: ["run", "mcp"] }]),
  },
  {
    key: "5",
    group: "Check",
    label: "Test",
    hint: "both workspaces",
    run: () => runSteps([{ kind: "npm", args: ["test"] }]),
  },
  {
    key: "6",
    group: "Check",
    label: "Typecheck",
    hint: "both workspaces, plus these scripts",
    run: () => runSteps([{ kind: "npm", args: ["run", "typecheck"] }]),
  },
  {
    key: "7",
    group: "Check",
    label: "Build",
    hint: "both workspaces; first run downloads Electron (~350 MB)",
    run: () => runSteps([{ kind: "npm", args: ["run", "build"] }]),
  },
  {
    key: "8",
    group: "Vault",
    label: "Vault CLI…",
    hint: "asks for arguments, e.g. agenda week",
    run: runVaultCli,
  },
  {
    key: "9",
    group: "Vault",
    label: "Doctor",
    hint: "validate every file in the vault and report problems",
    run: () => runSteps([{ kind: "tsx", script: CORE_CLI, args: ["doctor"] }]),
  },
  {
    key: "s",
    group: "Vault",
    label: "Seed example vault",
    hint: "the worked example; overwriting asks first",
    run: runSeed,
  },
  {
    key: "u",
    group: "Setup",
    label: "Update",
    hint: "git pull --ff-only, then reinstall and rebuild core",
    run: () => runSteps([{ kind: "npm", args: ["run", "update"] }]),
  },
  {
    key: "i",
    group: "Setup",
    label: "Install dependencies",
    hint: "npm install only — no pull, no build",
    run: () => runSteps([{ kind: "npm", args: ["install"] }]),
  },
  {
    key: "d",
    group: "Setup",
    label: "Desktop shortcut",
    hint: "double-click to start the built app, no terminal — re-run if the repo moves",
    run: () => runSteps([{ kind: "npm", args: ["run", "shortcut"] }]),
  },
  {
    key: "c",
    group: "Setup",
    label: "Connect Claude…",
    hint: "prints the MCP config, paths filled in — for Desktop, Cowork and Code",
    run: runConnect,
  },
];

/**
 * The vault directory is deliberately not resolved here. `cli.ts` already
 * defaults to `$VAULT_DIR ?? ./vault`, and duplicating that would give the menu
 * a second opinion that could drift from the real one.
 */
async function runVaultCli(): Promise<number> {
  write(`${bold("Vault CLI")}  ${dim("— arguments only; run with no arguments for help")}\n`);
  write(`${dim("  examples:  agenda week    list --project ENG    show ENG-1")}\n\n`);
  const args = tokenize(await ask(`${cyan("vault")} `));
  return runSteps([{ kind: "tsx", script: CORE_CLI, args: args.length ? args : ["--help"] }]);
}

async function runSeed(): Promise<number> {
  write(`${bold("Seed the example vault")}\n\n`);
  const target = (await ask(`${cyan("target directory")} ${dim("[./vault]")} `)) || "./vault";

  write(
    `\n${yellow("Overwriting")} clears items/, projects/, attachments/, .trash and\n` +
      `.counters.json in ${bold(target)}, and does not commit — anything written\n` +
      `since that vault's last commit is unrecoverable.\n\n`,
  );
  const confirm = await ask(`Type ${bold("FORCE")} to overwrite, or Enter to seed only if empty: `);
  const args = confirm === "FORCE" ? [target, "--force"] : [target];

  return runSteps([{ kind: "tsx", script: SEED_SCRIPT, args }]);
}

/**
 * Prints a config block with this machine's real paths already in it, and says
 * which file each Claude reads. It does not write any of them.
 *
 * Reporting rather than editing is deliberate. A real
 * `claude_desktop_config.json` holds other MCP servers, OAuth credentials and
 * Cowork preferences beside the key we care about; merging into it means
 * reserialising the whole file, which reorders and reformats everything the
 * user wrote. The uninstaller settled on the same rule from the other end.
 */
async function runConnect(): Promise<number> {
  if (!existsSync(path.join(REPO_ROOT, MCP_ENTRY))) {
    write(
      `${yellow("The server is not built yet.")} ${bold(MCP_ENTRY)}\n` +
        `does not exist. A config pointing at a missing file fails quietly — Claude\n` +
        `shows no error, the vault tools simply never appear — so build it first\n` +
        `with ${bold("npm run build")}, or option ${bold("[7]")}. The block below is still correct;\n` +
        `it just will not work until that file is there.\n\n`,
    );
  }

  write(
    `${dim("Which vault should Claude open? Answer with a path, or Enter for the default.")}\n` +
      `${dim("Quotes are fine — paste straight from Explorer's Copy as path.")}\n\n`,
  );
  const answer = unquotePath(await ask(`${cyan("vault directory")} ${dim("[./vault]")} `));
  const vaultDir = path.resolve(REPO_ROOT, answer || "./vault");

  if (!existsSync(vaultDir)) {
    write(`\n${yellow("Note:")} ${vaultDir} does not exist yet — seed it with ${bold("[S]")}, or\n`);
    write(`create it in the app, before expecting anything back from these tools.\n`);
  }

  write(`\n${bold("Paste this into whichever Claude you use:")}\n\n`);
  write(`${connectionSnippet(REPO_ROOT, vaultDir)}\n\n`);
  write(`  ${dim("─".repeat(58))}\n\n`);

  write(`${bold("Claude Desktop — and Cowork")}\n`);
  write(`  ${cyan(desktopConfigPath())}\n`);
  write(
    `  Cowork has no MCP config of its own: it reads this same file and bridges\n` +
      `  the server into its VM through Desktop. One entry serves both.\n` +
      `  ${yellow("Quit Desktop fully")} and reopen it — closing to the tray is not enough,\n` +
      `  because the file is only read at startup.\n\n`,
  );

  write(`${bold("Claude Code")}\n`);
  write(`  ${cyan(path.join(REPO_ROOT, ".mcp.json"))}\n`);
  write(
    `  Project-scoped, and gitignored precisely because it holds the absolute\n` +
      `  paths above — safe to create, it will not be committed. ${dim("claude mcp add")} can\n` +
      `  register the same server instead, if you prefer.\n`,
  );

  return 0;
}

function render(): void {
  clear();
  write(`\n  ${bold("todo-vault")} ${dim("— workspace commands")}\n`);
  write(`  ${dim("─".repeat(58))}\n`);

  let group = "";
  for (const entry of ENTRIES) {
    if (entry.group !== group) {
      group = entry.group;
      write(`\n  ${dim(group)}\n`);
    }
    const key = cyan(`[${entry.key.toUpperCase()}]`);
    write(`   ${key} ${entry.label.padEnd(34)} ${dim(entry.hint)}\n`);
  }

  write(`\n   ${cyan("[0]")} Exit\n`);
  write(`\n  ${dim("─".repeat(58))}\n`);
  write(`  Choose an option ${dim("(single keypress, Ctrl+C to quit)")}: `);
}

async function main(): Promise<void> {
  if (!existsSync(TSX_CLI)) {
    write(red(`\ntsx not found at ${TSX_CLI}\nRun \`npm install\` first.\n\n`));
    process.exitCode = 1;
    return;
  }

  // Only Windows: elsewhere a bare `npm` spawns from PATH without a shell.
  if (NPM_CLI === null && process.platform === "win32") {
    write(red(`\nnpm's entry point was not found beside ${process.execPath}.\n`));
    write(red("Start the menu with `npm run menu` so npm can point at itself.\n\n"));
    process.exitCode = 1;
    return;
  }

  const keys = new Set([...ENTRIES.map((e) => e.key), "0"]);

  for (;;) {
    render();
    const key = await readKey(keys);

    if (key === "0") {
      write("\n\n");
      pipedInput?.close();
      return;
    }

    const entry = ENTRIES.find((e) => e.key === key);
    if (!entry) continue;

    clear();
    write(`\n  ${bold(entry.label)}\n\n`);
    const code = await entry.run();

    write(
      code === 0
        ? `\n${green("✓")} ${entry.label} finished.\n`
        : `\n${red("✗")} ${entry.label} exited with code ${code}.\n`,
    );
    write(dim("  Press any key to return to the menu…"));
    await readKey(null);
  }
}

// Only when run as a command. Importing this module — the tokenizer tests do —
// must not launch a menu into the test runner's stdout.
if (isMain(import.meta.url)) {
  main().catch((err: unknown) => {
    write(red(`\n${err instanceof Error ? err.stack ?? err.message : String(err)}\n`));
    process.exitCode = 1;
  });
}
