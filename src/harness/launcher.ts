import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import * as vscode from "vscode";

let child: ChildProcess | undefined;
let launcher: { node: string; script: string } | null = null;

/**
 * Launch token printed by `dsh web` when it boots
 * (`dsh web: http://127.0.0.1:<port>/?token=<token>`).
 *
 * DSH 0.2.1 fences every `/api/*` request and the WS handshake behind a signed
 * cookie that can only be minted from this token, and the token is a
 * per-process `randomBytes` value that is NEVER written to disk
 * (`processLaunchToken` in dsh-client-connection). So a client that launched the
 * harness can only authenticate by reading the launch output — which is why
 * startHarness keeps stdout piped instead of "ignore".
 */
let launchToken: string | undefined;

/** Token of the harness this extension started (undefined when it did not). */
export function readLaunchToken(): string | undefined {
  return launchToken;
}

export function clearLaunchToken(): void {
  launchToken = undefined;
}

/** Pull the token out of one line of `dsh web` output. */
function captureLaunchToken(line: string): void {
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(line);
  if (match) launchToken = match[1];
}

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

/**
 * Whether the harness is "ours" and still alive.
 *
 * Two sources of truth:
 * 1. The live ChildProcess handle (`child`) — set when THIS module spawned it.
 * 2. The persistent pid record (`%TEMP%\dsh-vsc-harness.pid`) — survives
 *    extension reloads, where `child` is wiped (module re-import) but the
 *    detached instance we spawned keeps running.
 *
 * After a reload the pid record is the ONLY proof an instance is ours; without
 * this fallback `dsh.stop` / deactivate would say "not ours" and leave an
 * orphan harness on the port forever (observed in deactivate logs: owned=false
 * with a live pid record).
 */
export function isRunning(): boolean {
  if (child !== undefined && child.exitCode === null) return true;
  return isPidRecordAlive();
}

/** True when the pid record names a process that is still alive. */
function isPidRecordAlive(): boolean {
  const rec = readPidRecord();
  if (!rec || rec.pid <= 0) return false;
  try {
    process.kill(rec.pid, 0); // signal 0 = existence probe, no side effects
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the child env: inherit the parent, but ensure GITHUB_TOKEN is present.
 *
 * A missing GITHUB_TOKEN does NOT stop the boot — `dsh web` comes up and the
 * mcp-github server starts with an empty string (measured). The damage is
 * silent: every GitHub tool call 401s. So fill it in when we can.
 *
 * On Windows the persistent registry value is the safety net (survives a VS
 * Code launched from a stale session). On Linux there is no registry — the
 * harness resolves the token itself from `$DSH_HOME/.env` via the mcp-github
 * patch row, so nothing is injected here.
 *
 * NOTE (0.2.1): the runtime overlay — and with it the NODE_OPTIONS `--import`
 * injection — is retired. Every delta it used to carry is now shipped by DSH
 * itself (windowless subprocess spawn, STARTF_USESHOWWINDOW|SW_HIDE in
 * dsh-win32-process) or no longer exists (dsh-host-apiproxy `clientCount`).
 */
async function resolveSpawnEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!env.GITHUB_TOKEN && process.platform === "win32") {
    const userToken = await readWindowsUserEnv("GITHUB_TOKEN");
    if (userToken) env.GITHUB_TOKEN = userToken;
  }
  return env;
}

function readWindowsUserEnv(name: string): Promise<string | undefined> {
  // WSL *can* reach reg.exe through interop, so this would "work" from a Linux
  // extension host too — but it would hand the harness a token belonging to the
  // Windows side of a different machine namespace. Refuse explicitly.
  if (process.platform !== "win32") return Promise.resolve(undefined);
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

/** Entry script of the harness on both platforms. */
const DSH_ENTRY = join("@deepseek-ai", "dsh", "lib", "bin.js");

/**
 * Directories probed for a Linux node/dsh install, highest priority first.
 *
 * The extension host's PATH is NOT the terminal's PATH: it is the Linux default
 * plus the Windows interop mounts, so it never carries `~/.local/node/bin`
 * (Ubuntu's .bashrc returns early for non-interactive shells, so PATH edits
 * written there never reach it). Probe the known install roots directly.
 *
 * Interop entries are harmless here: /mnt/c/... holds `node.exe`, never a bare
 * `node`, so the existsSync probes below cannot pick a Windows binary.
 */
function posixBinDirs(): string[] {
  const home = homedir();
  const dirs = [join(home, ".local", "node", "bin")];
  try {
    const nvmRoot = join(home, ".nvm", "versions", "node");
    for (const version of readdirSync(nvmRoot)) dirs.push(join(nvmRoot, version, "bin"));
  } catch {
    /* no nvm */
  }
  dirs.push("/usr/local/bin", "/usr/bin", "/bin");
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry) dirs.push(entry);
  }
  return dirs;
}

function resolveNodePathPosix(): string | undefined {
  for (const dir of posixBinDirs()) {
    const candidate = join(dir, "node");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Locate `lib/bin.js`. Two derivations, because neither covers every layout:
 * the prefix of the node that will run it (`<prefix>/bin/node` →
 * `<prefix>/lib/node_modules/...`, which covers ~/.local/node, /usr/local, /usr
 * and nvm), and the realpath of the `dsh` shim (npm's global bin is a symlink
 * straight at bin.js).
 */
function resolveDshScriptPosix(nodePath: string): string | undefined {
  const candidates = [join(dirname(dirname(nodePath)), "lib", "node_modules", DSH_ENTRY)];
  for (const dir of posixBinDirs()) {
    const shim = join(dir, "dsh");
    if (!existsSync(shim)) continue;
    try {
      candidates.push(realpathSync(shim));
    } catch {
      /* broken symlink — the prefix-derived candidate still stands */
    }
  }
  return candidates.find((candidate) => candidate.endsWith(DSH_ENTRY) && existsSync(candidate));
}

async function resolveNodePath(): Promise<string | undefined> {
  if (process.platform !== "win32") return resolveNodePathPosix();
  const hits = await runWhereAll("node");
  const exe = hits.find((h) => h.toLowerCase().endsWith(".exe"));
  if (exe) return exe;
  for (const candidate of ["C:\\Program Files\\nodejs\\node.exe", "C:\\Program Files (x86)\\nodejs\\node.exe"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve the real dsh entry script.
 *
 * On Windows we must NOT launch through `dsh`/`npx` shims: npm .cmd shims chain
 * `cmd.exe → dsh.cmd → cmd.exe`, and the inner cmd opens its own visible console
 * even when the outer spawn used windowsHide. Spawning `node lib/bin.js`
 * directly with windowsHide (CREATE_NO_WINDOW) keeps the whole harness tree
 * windowless (the MCP SDK already hides its own server children).
 *
 * On Linux the same "spawn node + bin.js directly" rule holds, but it is
 * reached a different way — see resolveDshScriptPosix.
 */
async function resolveDshScript(nodePath: string): Promise<string | undefined> {
  if (process.platform !== "win32") return resolveDshScriptPosix(nodePath);
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
    const script = node ? await resolveDshScript(node) : undefined;
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
    log.appendLine(
      process.platform === "win32"
        ? "cannot resolve node/dsh for the silent launch — PATH missing `node` or the `dsh` shim; run `dsh web` manually for now"
        : "cannot resolve node/dsh for the silent launch — no Linux node + dsh lib/bin.js found (probed ~/.local/node/bin, ~/.nvm/versions/node/*/bin, /usr/local/bin, /usr/bin and PATH); run `dsh web` manually for now"
    );
    return;
  }
  // Runtime overlay is retired on the 0.2.1 line: nothing to inject, nothing
  // to verify. The official tree is consumed exactly as npm published it.
  const args = ["web", "--no-open", "--port", String(port)];
  // `dsh web` takes its workspace from the process cwd, and sessions bucket by
  // that absolute path — so an inherited cwd decides which history the user
  // sees. The extension host's cwd is NOT the open folder: measured on WSL it
  // is `/mnt/d/Microsoft VS Code`, which would file every session under a
  // bucket nobody ever opens. Pin it to the first workspace folder, and fall
  // back to HOME when the window has no folder open at all (an empty window
  // still activates the extension). Windows keeps the inherited cwd —
  // unchanged behaviour there.
  const cwd =
    process.platform === "win32"
      ? undefined
      : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir());
  log.appendLine(`$ ${l.node} ${l.script} ${args.join(" ")} (direct node, windowless, detached, shared ~/.dsh)`);
  log.appendLine(`cwd: ${cwd ?? "<inherited>"}`);
  log.appendLine(
    env.GITHUB_TOKEN
      ? `GITHUB_TOKEN: ${env.GITHUB_TOKEN.length} chars (${process.env.GITHUB_TOKEN ? "process env" : "Windows user env fallback"})`
      : "GITHUB_TOKEN: not in the launching env — the harness resolves it from $DSH_HOME/.env (mcp-github patch row)"
  );
  child = spawn(l.node, [l.script, ...args], {
    shell: false,
    windowsHide: true,
    detached: true,
    // stdout MUST be piped: `dsh web` prints its one-shot authenticated URL
    // there, and that line is the only source of the 0.2.1 launch token.
    stdio: ["ignore", "pipe", "pipe"],
    env,
    cwd,
  });
  launchToken = undefined;
  const drain = (stream: NodeJS.ReadableStream | null, prefix: string): void => {
    if (!stream) return;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const text = line.trim();
        if (!text) continue;
        captureLaunchToken(text);
        log.appendLine(`${prefix}${text}`);
      }
    });
  };
  drain(child.stdout, "dsh: ");
  drain(child.stderr, "dsh(err): ");
  writePidRecord({ pid: child.pid ?? 0, port, startedAt: new Date().toISOString(), args: [l.script, ...args] });
  child.on("exit", (code) => {
    log.appendLine(`auto-started dsh web exited (code ${code})`);
    child = undefined;
    launchToken = undefined;
    clearPidRecord();
  });
  child.on("error", (err) => log.appendLine(`dsh web spawn error: ${err.message}`));
  child.unref();
}

/** Kill the auto-started harness (and its whole process tree). Only ever
 *  touches the process THIS extension spawned (live handle, or the pid record
 *  left behind by a previous session after an extension reload); a
 *  pre-existing/shared harness is never killed. Resolves with what actually
 *  happened. */
export function stopHarness(): Promise<{ killed: boolean; pid?: number; error?: string }> {
  let pid: number | undefined;
  if (child !== undefined && child.exitCode === null) {
    pid = child.pid;
    child = undefined;
  } else {
    // Reload case: `child` was wiped but the pid record may still name the
    // instance we spawned. Adopt it (if the process is still alive) so the
    // orphan can be cleaned up.
    const rec = readPidRecord();
    if (rec && rec.pid > 0) {
      try {
        process.kill(rec.pid, 0);
        pid = rec.pid;
      } catch {
        /* record is stale — process already dead */
      }
    }
  }
  if (pid === undefined) {
    clearPidRecord();
    return Promise.resolve({ killed: false });
  }
  const target = pid;
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(target), "/T", "/F"], { windowsHide: true }, (error) => {
        clearPidRecord();
        resolve(error ? { killed: false, pid: target, error: error.message } : { killed: true, pid: target });
      });
      return;
    }
    // POSIX: the child was spawned detached, so it leads its own process group.
    // Signalling the NEGATIVE pid takes the whole tree down (node + npx + the
    // MCP server children) — the same job `taskkill /T` does on Windows.
    for (const signalTarget of [-target, target]) {
      try {
        process.kill(signalTarget, "SIGTERM");
        clearPidRecord();
        resolve({ killed: true, pid: target });
        return;
      } catch {
        /* fall through to the plain-pid form */
      }
    }
    clearPidRecord();
    resolve({ killed: false, pid: target, error: `no live process for pid ${target}` });
  });
}
