// 唯一主干入口
import * as vscode from "vscode";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativePanelProvider } from "./panel/NativePanelProvider";
import { renderEmbedHtml } from "./panel/embed";
import { DshStatusBar } from "./status";
import { HarnessClient } from "./harness/client";
import { configuredBase, discover, portOf } from "./harness/discover";
import {
  startHarness,
  stopHarness,
  isRunning as harnessRunning,
  readLaunchToken,
  readPidRecord,
  HARNESS_PID_FILE,
} from "./harness/launcher";
import { HarnessEventStream } from "./events/eventStream";
import { ChangeTracker } from "./editor/changeTracker";
import { buildSelectionContext } from "./editor/askSelection";
import { reviewFiles } from "./editor/diff";
import type { PanelEvent } from "./panel/protocol";

const POLL_MS = 1000;
const START_TIMEOUT_MS = 30000;
const RIGHT_VIEW = "dsh.sidebar.right";
const MAX_SPAWN_FAILURES = 3; // consecutive auto-spawn failures before giving up this session
const OFFLINE_RECHECK_MS = 15000; // slow poll while down-but-not-our-job (user may start one manually)
const DISCONNECT_RECHECK_MS = 3000; // grace before probing after the event stream drops

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
    vscode.commands.registerCommand("dsh.askSelection", () => {
      // Preferred path: in-panel ask card (right sidebar). Falls back to the
      // legacy quick-pick flow when the panel was never opened.
      void (async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
          void vscode.window.showWarningMessage("DSH: 请先在编辑器里选中要询问的代码。");
          return;
        }
        if (!client) {
          const choice = await vscode.window.showWarningMessage("DSH: harness 未连接。", "启动 harness");
          if (choice === "启动 harness") void vscode.commands.executeCommand("dsh.start");
          return;
        }
        const block = await buildSelectionContext();
        if (block === null) return;
        // Focus the sidebar first so the card is visible, then post it.
        void vscode.commands.executeCommand(`${RIGHT_VIEW}.focus`).then(() => {
          panel.showAskCard(block);
        });
      })();
    }),
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
      const next = new HarnessClient(d.base);
      const ok = await authenticate(next, d.base);
      client = next;
      status.setOnline(d.version ?? "0.2.1");
      log.appendLine(
        `harness connected at ${d.base}${ok ? "" : " (UNAUTHENTICATED — panel actions will fail with 401)"}`
      );
      panel.setClient(client, d.version);
      ensureStream(d.base);
      return;
    }
    client = null;
    panel.setClient(null);
    await checkHarness();
  }

  /** Bases we already asked the user about (the token changes per boot, so a
   *  cancelled prompt must not reopen on every poll). */
  const authPrompted = new Set<string>();

  /** Accept a bare token or a full `…?token=…` URL. */
  function tokenFrom(input: string): string | undefined {
    const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(input);
    if (match) return match[1];
    const bare = input.trim();
    return /^[A-Za-z0-9_-]{16,}$/.test(bare) ? bare : undefined;
  }

  /**
   * DSH 0.2.1 fenced every `/api/*` call and the WS handshake behind a signed
   * cookie minted from the process launch token. A harness WE started hands its
   * token over on stdout (launcher.ts captures it); one the user started
   * themselves can only be reached with a token they paste.
   *
   * @returns whether the client now holds a cookie.
   */
  async function authenticate(next: HarnessClient, base: string): Promise<boolean> {
    if (next.authenticated) return true;
    // Our own instance: the token arrives asynchronously on the child's stdout.
    let launched = readLaunchToken();
    for (let i = 0; launched === undefined && harnessRunning() && i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      launched = readLaunchToken();
    }
    const configured = vscode.workspace.getConfiguration("dshVsc").get<string>("token")?.trim();
    const candidates: { token: string; source: "launch" | "config" }[] = [];
    if (launched) candidates.push({ token: launched, source: "launch" });
    const fromConfig = configured ? tokenFrom(configured) : undefined;
    if (fromConfig) candidates.push({ token: fromConfig, source: "config" });
    for (const candidate of candidates) {
      try {
        await next.connect(candidate.token);
        log.appendLine(`auth: cookie minted from the ${candidate.source} token`);
        return true;
      } catch (error) {
        log.appendLine(`auth: ${candidate.source} token rejected — ${(error as Error).message}`);
      }
    }
    if (authPrompted.has(base)) return false;
    authPrompted.add(base);
    const input = await vscode.window.showInputBox({
      title: "DSH 需要认证（0.2.1 起）",
      prompt: `请粘贴 ${base} 启动时打印的那条 URL（含 token=…）或 token 本身。本扩展自己启动的服务不需要这一步。`,
      placeHolder: "http://127.0.0.1:3080/?token=…",
      ignoreFocusOut: true,
    });
    if (!input) return false;
    const manual = tokenFrom(input);
    if (!manual) {
      log.appendLine("auth: pasted value carries no recognisable token");
      return false;
    }
    try {
      await next.connect(manual);
      await vscode.workspace.getConfiguration("dshVsc").update("token", manual, vscode.ConfigurationTarget.Global);
      log.appendLine("auth: cookie minted from the user-supplied token (saved to dshVsc.token)");
      return true;
    } catch (error) {
      log.appendLine(`auth: user token rejected — ${(error as Error).message}`);
      return false;
    }
  }

  function ensureStream(base: string): void {
    if (stream) {
      panel.attachStream(stream);
      return;
    }
    // The stream carries the SAME cookie as the RPC client (0.2.1 fences both).
    stream = new HarnessEventStream(base, () => client?.cookieHeader);
    stream.onSessionEvent = (sessionId, event) => {
      tracker.handleEvent(sessionId, event);
      panelListeners.forEach((cb) => cb(sessionId, event as PanelEvent));
    };
    // Forwarded waterfalls (approval / question) answer through `$events/result`.
    stream.onAnswerable = (answerable) => panel.handleAnswerable(answerable);
    stream.onAnswerableSettled = (eventId) => panel.handleAnswerableSettled(eventId);
    // Session-list truth on 0.2.1: add/remove/status/activity arrive here, not
    // on a mux session-collection frame. A cheap list refresh keeps the sidebar
    // exact without polling.
    stream.onHostEvent = (event) => {
      if (event.startsWith("api-session/") || event === "workspace/changed") void panel.refresh();
    };
    stream.onWorkspaces = (items) => {
      const archived = (items as unknown as { archivedSessionIds?: string[] }).archivedSessionIds;
      panel.setArchivedSessionIds(Array.isArray(archived) ? archived : undefined);
      void panel.refresh();
    };
    stream.onError = (message) => log.appendLine(`event stream: ${message}`);
    stream.onOpen = () => {
      // Reconnected (possibly to a fresh harness we respawned): flip status online.
      void discover().then((d) => {
        if (d.alive) status.setOnline(d.version ?? "0.2.1");
      });
      panel.attachStream(stream);
    };
    stream.onDisconnect = () => {
      // Stream dropped. The stream itself keeps retrying; give it a grace
      // period, then check whether the harness is actually gone and respawn.
      // Only bother while we were connected: once refresh() found the harness
      // down (client === null) the slow OFFLINE_RECHECK poll owns recovery.
      if (client) scheduleHarnessCheck(DISCONNECT_RECHECK_MS);
    };
    stream.start();
    panel.attachStream(stream);
    context.subscriptions.push({
      dispose: () => {
        stream?.dispose();
        stream = null;
        panel.attachStream(null);
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
 * Shutdown: only ever stop the harness THIS extension spawned.
 *
 * - Shared harness (not ours): never killed — the browser GUI or the user's own
 *   `dsh web` may be using it; we only note it stays alive.
 * - Auto-started harness (ours): stop it and remove the pid record.
 *
 * DSH 0.2.1 removed `host.describe` outright — there is no `host` namespace and
 * no `clientCount` anywhere on the wire, so the old "another client is still
 * attached, leave it running" probe has no source left. Our instance is
 * detached + windowless and its pid record names it, so an orphan is strictly
 * worse than stopping it: stop what we started.
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
  logDeactivate(`stopping owned instance (pid record: ${HARNESS_PID_FILE})`);
  return stopHarness().then((result) => {
    logDeactivate(`stopHarness -> ${JSON.stringify(result)}`);
  });
}
