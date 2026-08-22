import * as vscode from "vscode";
import { NativePanelProvider } from "./panel/NativePanelProvider";
import { renderEmbedHtml } from "./panel/embed";
import { DshStatusBar } from "./status";
import { HarnessClient } from "./harness/client";
import { configuredBase, discover, portOf } from "./harness/discover";
import { startHarness, stopHarness } from "./harness/launcher";
import { HarnessEventStream } from "./events/eventStream";
import { ChangeTracker } from "./editor/changeTracker";
import { askSelection } from "./editor/askSelection";
import { reviewFiles } from "./editor/diff";
import type { PanelEvent } from "./panel/protocol";

const POLL_MS = 1000;
const START_TIMEOUT_MS = 30000;
const RIGHT_VIEW = "dsh.sidebar.right";

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
  let autoStarted = false;

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
      void ensureRunning();
    }),
    vscode.commands.registerCommand("dsh.stop", () => {
      stopHarness();
      status.setOffline();
      log.appendLine("dsh web stopped (auto-started instance)");
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

  async function ensureRunning(): Promise<void> {
    const base = configuredBase();
    const port = portOf(base);
    status.setStarting(port);
    await startHarness(port, log);
    await waitUntilAlive(base, START_TIMEOUT_MS);
    await refresh();
  }

  async function refresh(): Promise<void> {
    const d = await discover();
    if (d.alive) {
      client = new HarnessClient(d.base);
      status.setOnline(d.version ?? "?");
      log.appendLine(`harness connected at ${d.base} (version ${d.version})`);
      panel.setClient(client, d.version);
      ensureStream(d.base);
      return;
    }
    client = null;
    panel.setClient(null);
    log.appendLine(`no harness at ${d.base}`);
    const autoStart = vscode.workspace.getConfiguration("dshVsc").get<boolean>("autoStart", true);
    if (autoStart && !autoStarted) {
      autoStarted = true;
      await ensureRunning();
    } else {
      status.setOffline();
    }
  }

  function ensureStream(base: string): void {
    if (stream) return;
    stream = new HarnessEventStream(base);
    stream.onSessionEvent = (sessionId, event) => {
      tracker.handleEvent(sessionId, event);
      panelListeners.forEach((cb) => cb(sessionId, event as PanelEvent));
    };
    stream.onError = (message) => log.appendLine(`event stream: ${message}`);
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

export function deactivate(): void {
  // Do not kill the harness: it is a shared service, not owned by this extension.
}
