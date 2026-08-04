/**
 * A numbered launcher for the workspace's everyday commands.
 *
 *   npm run menu
 *
 * The commands themselves already exist as npm scripts; this exists because
 * two of them are not single commands. Launching a production preview means
 * building the core *first* — `npm run start -w @todo-vault/desktop` on its own
 * rebuilds the desktop bundle around whatever `packages/core/dist` happened to
 * contain last time, and the result looks like a clean build while carrying a
 * stale core. Encoding the sequence in a menu entry is the difference between
 * that being a rule you remember and a rule you cannot break.
 *
 * TypeScript rather than a .cmd file so it typechecks with everything else and
 * runs the same on any platform, and so the argument handling below is a real
 * tokenizer rather than a batch-file quoting accident.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * tsx's own entry, invoked as a script through `process.execPath` rather than
 * as `node_modules/.bin/tsx`. On Windows that bin is a `.cmd` shim, and since
 * the CVE-2024-27980 fix Node refuses to spawn `.cmd` without `shell: true` —
 * which is exactly the mode that mangles arguments containing spaces. Going
 * through node directly keeps the vault CLI's `--summary "two words"` intact.
 */
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const CORE_CLI = "packages/core/src/cli.ts";
const SEED_SCRIPT = "packages/core/scripts/seed-vault.ts";

// ---------------------------------------------------------------- presentation

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = paint("1");
const dim = paint("2");
const cyan = paint("36");
const green = paint("32");
const red = paint("31");
const yellow = paint("33");

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
  // npm on Windows is `npm.cmd`, which needs a shell (see TSX_CLI above). With
  // `shell: true` Node joins argv with spaces and does *not* quote, so every
  // npm step here must keep its arguments space-free — they are all fixed
  // literals below, and user input goes through the `tsx` branch instead.
  const onWindows = process.platform === "win32";
  const command = step.kind === "npm" ? (onWindows ? "npm.cmd" : "npm") : process.execPath;
  const args =
    step.kind === "npm" ? step.args : [TSX_CLI, path.join(REPO_ROOT, step.script), ...step.args];
  const shell = step.kind === "npm" && onWindows;

  write(`${dim("$")} ${bold(describe(step))}\n\n`);

  return new Promise((settle) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: "inherit", shell });

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
    run: () =>
      runSteps([
        { kind: "npm", args: ["run", "build", "-w", "todo-vault"] },
        { kind: "npm", args: ["run", "start", "-w", "@todo-vault/desktop"] },
      ]),
  },
  {
    key: "3",
    group: "Run",
    label: "Prod preview (reuse last build)",
    hint: "launches without rebuilding — only correct if nothing changed since",
    run: () =>
      runSteps([
        { kind: "npm", args: ["run", "start", "-w", "@todo-vault/desktop", "--", "--skipBuild"] },
      ]),
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
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err: unknown) => {
    write(red(`\n${err instanceof Error ? err.stack ?? err.message : String(err)}\n`));
    process.exitCode = 1;
  });
}
