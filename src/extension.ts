import * as vscode from "vscode";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativePanelProvider } from "./panel/NativePanelProvider";
import { renderEmbedHtml } from "./panel/embed";
import { DshStatusBar } from "./status";
import { HarnessClient } from "./harness/client";
import { configuredBase, discover, portOf } from "./harness/discover";
import { startHarness, stopHarness, isRunning as harnessRunning, readPidRecord, HARNESS_PID_FILE } from "./harness/launcher";
import { HarnessEventStream } from "./events/eventStream";
import { ChangeTracker } from "./editor/changeTracker";
import { askSelection } from "./editor/askSelection";
import { reviewFiles } from "./editor/diff";
import type { PanelEvent } from "./panel/protocol";

const POLL_MS = 1000;
const START_TIMEOUT_MS = 30000;
const RIGHT_VIEW = "dsh.sidebar.right";
const MAX_SPAWN_FAILURES = 3; // consecutive auto-spawn failures before giving up this session
const OFFLINE_RECHECK_MS = 15000; // slow poll while down-but-not-our-job (user may start one manually)
const DISCONNECT_RECHECK_MS = 3000; // grace before probing after the event stream drops

// Module-level handoff for deactivate(): the exit path runs outside activate's
// closure, so it needs its own reference to the connected client to ask the
// harness "how many clients are attached?" before deciding whether to stop an
// instance we spawned.
let exitClient: HarnessClient | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("DSH Bridge");
  const status = new DshStatusBar();
  const makeLog = (message: string): void => {
    log.appendLine(message);
    console.log("[dsh-vsc]", message); // lands in the exthost log for headless diagnosis
  };
  const tracker = new ChangeTracker();
  const panelListeners = new Set<(sessionId: string, event: PanelEvent) => void>();
  let client: HarnessClient | null = null;
  let stream: HarnessEventStream | null = null;
  // Lifecycle state. `autoStarted` is gone: the watch loop owns auto-start.
  let connecting = false; // a spawn+wait is in flight; prevents double work
  let userStopped = false; // `dsh.stop` asked us not to respawn; cleared by start / reload
  let autoRetryDisabled = false; // too many consecutive spawn failures this session
  let consecutiveSpawnFailures = 0;
  let checkTimer: NodeJS.Timeout | null = null;

  const panel = new NativePanelProvider(context, makeLog, () => client, (cb) => panelListeners.add(cb));

  log.appendLine("dsh-vsc activated");

  tracker.onBatch((batch) => {
    status.setChanges(tracker.latestFiles().length);
    log.appendLine(`agent turn ${batch.turn} changed ${batch.files.length} file(s): ${batch.files.join(", ")}`);
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(RIGHT_VIEW, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    status,
    tracker,
    vscode.commands.registerCommand("dsh.openSidebar", () => {
      void vscode.commands.executeCommand(`${RIGHT_VIEW}.focus`);
    }),
    vscode.commands.registerCommand("dsh.start", () => {
      // Explicit start: clear every "don't respawn" latch and retry for real.
      userStopped = false;
      autoRetryDisabled = false;
      consecutiveSpawnFailures = 0;
      void ensureRunning();
    }),
    vscode.commands.registerCommand("dsh.stop", () => {
      if (harnessRunning()) {
        stopHarness();
        userStopped = true;
        status.setOffline();
        log.appendLine("dsh web stopped (auto-started instance); not respawning until dsh:start or window reload");
      } else {
        void vscode.window.showInformationMessage(
          "DSH Bridge：当前服务不是本扩展启动的（可能是你手动运行的 dsh web）。扩展无权停止它；要彻底停掉请关掉对应的终端。"
        );
      }
    }),
    vscode.commands.registerCommand("dsh.refreshStatus", () => {
      void refresh();
    }),
    vscode.commands.registerCommand("dsh.openWebView", () => openWebView(context, log)),
    vscode.commands.registerCommand("dsh.askSelection", () => askSelection(() => client)),
    vscode.commands.registerCommand("dsh.reviewChanges", () => reviewFiles(tracker.latestFiles()))
  );

  void refresh();

  // Dev-host autotest hook (only when launched with DSH_VSC_AUTOTEST=1): open the
  // right sidebar a few seconds after startup so resolveWebviewView runs and its
  // diagnostics land in the exthost log.
  if (process.env.DSH_VSC_AUTOTEST === "1") {
    setTimeout(() => {
      log.appendLine("[autotest] opening sidebar");
      void vscode.commands.executeCommand(`${RIGHT_VIEW}.focus`);
    }, 4000);
  }

  async function ensureRunning(): Promise<boolean> {
    if (connecting) return false;
    // Idempotent start: if something already answers, just (re)connect.
    const before = await discover();
    if (before.alive) {
      await refresh();
      return true;
    }
    connecting = true;
    try {
      const base = configuredBase();
      const port = portOf(base);
      status.setStarting(port);
      panel.setPhase("starting");
      // Same data root as the web GUI (~/.dsh): the extension is a shared
      // client, so "one runs, the other watches" means ONE history. Port
      // ownership is the natural exclusivity — the extension's own instance
      // takes the same port the web GUI would use, so the two can never
      // co-write the same log.
      await startHarness(port, log);
      await waitUntilAlive(base, START_TIMEOUT_MS);
    } finally {
      connecting = false;
    }
    const d = await discover();
    if (d.alive) {
      consecutiveSpawnFailures = 0;
      await refresh(); // connects, updates the panel, opens the stream
      return true;
    }
    consecutiveSpawnFailures++;
    if (consecutiveSpawnFailures >= MAX_SPAWN_FAILURES) {
      autoRetryDisabled = true;
      status.setOffline();
      log.appendLine(
        `DSH 服务连续 ${MAX_SPAWN_FAILURES} 次启动失败，本次会话不再自动重试（可执行命令 dsh: Start Web Harness 手动重试）`
      );
    } else {
      scheduleHarnessCheck(Math.min(2000 * 2 ** (consecutiveSpawnFailures - 1), 30000));
    }
    return false;
  }

  /** Debounced harness probe: reconnect if it came back, respawn if it died. */
  function scheduleHarnessCheck(delayMs: number): void {
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      checkTimer = null;
      void checkHarness();
    }, delayMs);
  }

  async function checkHarness(): Promise<void> {
    if (connecting) return;
    const d = await discover();
    if (d.alive) {
      await refresh();
      return;
    }
    status.setOffline();
    log.appendLine(`no harness at ${d.base}`);
    const autoStart = vscode.workspace.getConfiguration("dshVsc").get<boolean>("autoStart", true);
    if (autoStart && !userStopped && !autoRetryDisabled) {
      void ensureRunning();
    } else {
      // Not our job to respawn right now — keep watching in case the user
      // starts one manually (then the panel recovers on its own).
      scheduleHarnessCheck(OFFLINE_RECHECK_MS);
    }
  }

  async function refresh(): Promise<void> {
    const d = await discover();
    if (d.alive) {
      client = new HarnessClient(d.base);
      exitClient = client;
      status.setOnline(d.version ?? "?");
      log.appendLine(`harness connected at ${d.base} (version ${d.version})`);
      panel.setClient(client, d.version);
      ensureStream(d.base);
      return;
    }
    client = null;
    exitClient = null;
    panel.setClient(null);
    await checkHarness();
  }

  function ensureStream(base: string): void {
    if (stream) return;
    stream = new HarnessEventStream(base);
    stream.onSessionEvent = (sessionId, event) => {
      tracker.handleEvent(sessionId, event);
      panelListeners.forEach((cb) => cb(sessionId, event as PanelEvent));
    };
    stream.onError = (message) => log.appendLine(`event stream: ${message}`);
    stream.onOpen = () => {
      // Reconnected (possibly to a fresh harness we respawned): flip status online.
      void discover().then((d) => {
        if (d.alive) status.setOnline(d.version ?? "?");
      });
    };
    stream.onDisconnect = () => {
      // Stream dropped. The stream itself keeps retrying; give it a grace
      // period, then check whether the harness is actually gone and respawn.
      // Only bother while we were connected: once refresh() found the harness
      // down (client === null) the slow OFFLINE_RECHECK poll owns recovery.
      if (client) scheduleHarnessCheck(DISCONNECT_RECHECK_MS);
    };
    stream.start();
    context.subscriptions.push({
      dispose: () => {
        stream?.dispose();
        stream = null;
      },
    });
  }

  async function waitUntilAlive(base: string, timeoutMs: number): Promise<void> {
    const probe = new HarnessClient(base);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await probe.isAlive(800)) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    log.appendLine(`timed out waiting for harness at ${base}`);
  }
}

/** Optional full DSH web GUI as an editor tab (the embed, demoted from main surface). */
function openWebView(context: vscode.ExtensionContext, log: vscode.OutputChannel): void {
  const panel = vscode.window.createWebviewPanel("dsh.webview", "DSH (Web)", vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "media")],
  });
  try {
    panel.webview.html = renderEmbedHtml(panel.webview, configuredBase(), context);
  } catch (error) {
    log.appendLine(`openWebView render failed: ${(error as Error).message}`);
  }
}

const DEACTIVATE_LOG = join(tmpdir(), "dsh-vsc-deactivate.log");

function logDeactivate(line: string): void {
  try {
    fs.appendFileSync(DEACTIVATE_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never break shutdown */
  }
}

/**
 * Reference-counted shutdown: only ever stop the harness THIS extension
 * spawned, and only when no other client is attached to it.
 *
 * - Shared harness (not ours): never killed — the browser GUI or the user's
 *   own `dsh web` may be using it; we only note it stays alive.
 * - Auto-started harness (ours): ask host.describe for clientCount (patched
 *   DSH; see scripts/patch-dsh-client-count.ps1). If another client (e.g. a
 *   browser tab attached to our instance) is still connected, leave it
 *   running and log where its PID record lives. Otherwise (clientCount
 *   unknown because the patch is absent, or <= 1 = only us) stop it and
 *   remove the pid record, so no orphaned windowless dsh keeps running.
 */
export function deactivate(): Promise<void> {
  logDeactivate("deactivate called");
  const owned = harnessRunning();
  const record = readPidRecord();
  logDeactivate(`owned=${owned} pidRecord=${JSON.stringify(record)}`);
  if (!owned) {
    logDeactivate("shared or no harness — nothing to stop");
    return Promise.resolve();
  }
  // Ask the harness how many clients are attached. clientCount is
  // undefined when the DSH patch is missing (zod strips unknown keys), so
  // treat undefined as "no other client known" — the process is ours and
  // windowless, an orphan is worse than stopping it.
  const probe = exitClient ?? new HarnessClient(configuredBase());
  let settled = false;
  let stopDone = Promise.resolve();
  const stopOwned = (why: string): void => {
    if (settled) return;
    settled = true;
    logDeactivate(why);
    stopDone = stopHarness().then((result) => {
      logDeactivate(`stopHarness -> ${JSON.stringify(result)}`);
    });
  };
  void probe
    .describe(AbortSignal.timeout(2000))
    .then((desc) => {
      const n = desc.clientCount;
      logDeactivate(`clientCount=${String(n)}`);
      if (n !== undefined && n > 1) {
        settled = true;
        logDeactivate(`keep running (${n} clients attached) — pid record: ${HARNESS_PID_FILE}`);
        return;
      }
      stopOwned(`no other client (clientCount=${String(n)}) — stopping owned instance`);
    })
    .catch(() => {
      stopOwned("clientCount probe failed — stopping owned instance");
    });
  // Timeout fallback: can't ask, but the instance is ours — stop it.
  // Guarded by `settled` so a late describe answer cannot double-kill.
  setTimeout(() => stopOwned("clientCount probe timed out — stopping owned instance"), 2500);
  // Wait for any actual stop to finish before VS Code tears down, so the
  // taskkill lands. If the probe is still in flight, that's fine — the
  // timeout branch will stop it; we just wait on the (possibly pending) stop.
  return stopDone;
}
