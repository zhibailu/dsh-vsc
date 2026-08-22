import { spawn, execFile, type ChildProcess } from "node:child_process";
import * as vscode from "vscode";

let child: ChildProcess | undefined;

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

/**
 * Start `dsh web` as a DETACHED hidden background process (no terminal window).
 * - detached + stdio:'ignore' + unref: survives VS Code closing, so the harness
 *   stays a shared service (the browser GUI keeps working).
 * - windowsHide: no console window appears.
 * - GITHUB_TOKEN resolved (process env, then Windows user env).
 * Stop it with the `dsh.stop` command (taskkill /T kills the whole tree).
 */
export async function startHarness(port: number, log: vscode.OutputChannel): Promise<void> {
  if (isRunning()) return;
  const env = await resolveSpawnEnv();
  const cmd = `dsh web --no-open --port ${port}`;
  log.appendLine(`$ ${cmd} (detached, hidden)`);
  log.appendLine(
    env.GITHUB_TOKEN
      ? `GITHUB_TOKEN: ${env.GITHUB_TOKEN.length} chars (${process.env.GITHUB_TOKEN ? "process env" : "Windows user env fallback"})`
      : "GITHUB_TOKEN: MISSING — dsh web will fail to boot (mcp-github config)"
  );
  child = spawn(cmd, {
    shell: true,
    windowsHide: true,
    detached: true,
    stdio: "ignore",
    env,
  });
  child.on("exit", (code) => {
    log.appendLine(`auto-started dsh web exited (code ${code})`);
    child = undefined;
  });
  child.on("error", (err) => log.appendLine(`dsh web spawn error: ${err.message}`));
  child.unref();
}

/** Kill the auto-started harness (and its whole process tree). */
export function stopHarness(): void {
  if (!child || child.exitCode !== null) return;
  const pid = child.pid;
  execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {
    /* settled either way */
  });
  child = undefined;
}
