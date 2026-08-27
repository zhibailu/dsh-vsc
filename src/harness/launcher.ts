import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

let child: ChildProcess | undefined;
let launcher: { node: string; script: string } | null = null;

/**
 * Persistent record of the harness this extension auto-started, so a detached
 * background instance is never "invisible": the file names the PID, port and
 * start time, and deactivate clears it. Re-run of the shutdown logic reads it
 * to decide whether a still-alive process is ours to stop.
 */
export const HARNESS_PID_FILE = join(tmpdir(), "dsh-vsc-harness.pid");

export interface HarnessPidRecord {
  pid: number;
  port: number;
  startedAt: string;
  args: string[];
}

export function writePidRecord(record: HarnessPidRecord): void {
  try {
    writeFileSync(HARNESS_PID_FILE, JSON.stringify(record, null, 2), "utf8");
  } catch {
    /* a missing pid file must never break lifecycle */
  }
}

export function clearPidRecord(): void {
  try {
    rmSync(HARNESS_PID_FILE, { force: true });
  } catch {
    /* noop */
  }
}

export function readPidRecord(): HarnessPidRecord | null {
  try {
    if (!existsSync(HARNESS_PID_FILE)) return null;
    return JSON.parse(readFileSync(HARNESS_PID_FILE, "utf8")) as HarnessPidRecord;
  } catch {
    return null;
  }
}

/** Whether our spawned harness child is still alive. */
export function isRunning(): boolean {
  return child !== undefined && child.exitCode === null;
}

/**
 * Build the child env: inherit the parent, but ensure GITHUB_TOKEN is present.
 * The web profile fails the whole boot when GITHUB_TOKEN is missing (mcp-github
 * config becomes invalid), so fall back to the persistent Windows user env
 * when the process env lacks it (e.g. VS Code launched from a stale session).
 */
async function resolveSpawnEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!env.GITHUB_TOKEN) {
    const userToken = await readWindowsUserEnv("GITHUB_TOKEN");
    if (userToken) env.GITHUB_TOKEN = userToken;
  }
  return env;
}

function readWindowsUserEnv(name: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("reg", ["query", "HKCU\\Environment", "/v", name], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve(undefined);
      const match = new RegExp(`${name}\\s+REG_\\S+\\s+(.+)`).exec(stdout);
      resolve(match ? match[1].trim() : undefined);
    });
  });
}

function runWhereAll(name: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("where.exe", [name], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(
        stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      );
    });
  });
}

async function resolveNodePath(): Promise<string | undefined> {
  const hits = await runWhereAll("node");
  const exe = hits.find((h) => h.toLowerCase().endsWith(".exe"));
  if (exe) return exe;
  for (const candidate of ["C:\\Program Files\\nodejs\\node.exe", "C:\\Program Files (x86)\\nodejs\\node.exe"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve the real dsh entry script. We must NOT launch through `dsh`/`npx`
 * shims: npm .cmd shims chain `cmd.exe → dsh.cmd → cmd.exe`, and the inner cmd
 * opens its own visible console even when the outer spawn used windowsHide.
 * Spawning `node lib/bin.js` directly with windowsHide (CREATE_NO_WINDOW)
 * keeps the whole harness tree windowless (the MCP SDK already hides its own
 * server children).
 */
async function resolveDshScript(): Promise<string | undefined> {
  // Prefer the .cmd shim (e.g. %APPDATA%\npm\dsh.cmd); `where` may list a
  // bare extensionless `dsh` first, which is not executable by CreateProcess.
  const hits = await runWhereAll("dsh");
  const shim = hits.find((h) => h.toLowerCase().endsWith(".cmd"));
  if (shim) {
    try {
      const content = readFileSync(shim, "utf8");
      // The shim references the script as e.g. "%dp0%\node_modules\@deepseek-ai\dsh\lib\bin.js"
      const m = /((?:node_modules\\)?@deepseek-ai\\dsh\\lib\\bin\.js)/.exec(content);
      if (m) {
        let rel = m[1].replace(/\//g, "\\");
        if (!rel.startsWith("node_modules")) rel = "node_modules\\" + rel;
        const candidate = join(shim.replace(/[^\\/]+$/, ""), rel);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      /* fall through to npm prefix */
    }
  }
  // Fallback: derive from the global npm prefix. execFile CANNOT launch a .cmd
  // directly (CreateProcess EINVAL), so go through cmd.exe /c.
  const comspec = process.env.ComSpec || "cmd.exe";
  const prefix = await new Promise<string | undefined>((resolve) => {
    execFile(comspec, ["/c", "npm", "prefix", "-g"], { windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined);
    });
  });
  if (prefix) {
    const candidate = join(prefix, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function resolveLauncher(): Promise<{ node: string; script: string } | null> {
  if (launcher) return launcher;
  try {
    const node = await resolveNodePath();
    const script = await resolveDshScript();
    if (!node || !script) return null;
    launcher = { node, script };
    return launcher;
  } catch (error) {
    // Never let a resolution failure hang or crash the watch loop.
    return null;
  }
}

/**
 * Start `dsh web` as a DETACHED, WINDOWLESS background process (no console,
 * no cmd shim). Direct `node bin.js` spawn with windowsHide = CREATE_NO_WINDOW:
 * - detached + stdio:'ignore' + unref: the harness is owned by this extension
 *   and is closed when VS Code exits (deactivate → stopHarness).
 * - no console anywhere in the tree, so there is nothing to close and nothing
 *   to kill by accident.
 * - GITHUB_TOKEN resolved (process env, then Windows user env).
 * - Uses the SAME data root as the web GUI (~/.dsh): the extension is a shared
 *   client, so "one runs, the other watches" means ONE history. Port ownership
 *   is the natural exclusivity — our instance takes the same port the web GUI
 *   would use (default 3080), so the two can never co-write the same log.
 * Stop it with the `dsh.stop` command or by closing VS Code
 * (taskkill /T kills the whole tree).
 */
export async function startHarness(port: number, log: vscode.OutputChannel): Promise<void> {
  if (isRunning()) return;
  const env = await resolveSpawnEnv();
  const l = await resolveLauncher();
  if (!l) {
    log.appendLine("cannot resolve node/dsh for the silent launch — PATH missing `node` or the `dsh` shim; run `dsh web` manually for now");
    return;
  }
  const args = ["web", "--no-open", "--port", String(port)];
  log.appendLine(`$ ${l.node} ${l.script} ${args.join(" ")} (direct node, windowless, detached, shared ~/.dsh)`);
  log.appendLine(
    env.GITHUB_TOKEN
      ? `GITHUB_TOKEN: ${env.GITHUB_TOKEN.length} chars (${process.env.GITHUB_TOKEN ? "process env" : "Windows user env fallback"})`
      : "GITHUB_TOKEN: MISSING — dsh web will fail to boot (mcp-github config)"
  );
  child = spawn(l.node, [l.script, ...args], {
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: "ignore",
    env,
  });
  writePidRecord({ pid: child.pid ?? 0, port, startedAt: new Date().toISOString(), args: [l.script, ...args] });
  child.on("exit", (code) => {
    log.appendLine(`auto-started dsh web exited (code ${code})`);
    child = undefined;
    clearPidRecord();
  });
  child.on("error", (err) => log.appendLine(`dsh web spawn error: ${err.message}`));
  child.unref();
}

/** Kill the auto-started harness (and its whole process tree). Only ever
 *  touches the process THIS extension spawned; a pre-existing/shared harness
 *  is never killed. Resolves with what actually happened. */
export function stopHarness(): Promise<{ killed: boolean; pid?: number; error?: string }> {
  if (!child || child.exitCode !== null) {
    clearPidRecord();
    return Promise.resolve({ killed: false });
  }
  const pid = child.pid;
  child = undefined;
  return new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
      clearPidRecord();
      resolve(error ? { killed: false, pid, error: error.message } : { killed: true, pid });
    });
  });
}
