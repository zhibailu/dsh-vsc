import * as vscode from "vscode";
import { SidebarProvider } from "./panel/SidebarProvider";
import { DshStatusBar } from "./status";
import { HarnessClient } from "./harness/client";
import { configuredBase, discover, portOf } from "./harness/discover";
import { startHarness, stopHarness } from "./harness/launcher";
import { HarnessEventStream } from "./events/eventStream";
import { ChangeTracker } from "./editor/changeTracker";
import { askSelection } from "./editor/askSelection";
import { reviewFiles } from "./editor/diff";

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
  const sidebar = new SidebarProvider(context, makeLog);
  const tracker = new ChangeTracker();
  let client: HarnessClient | null = null;
  let stream: HarnessEventStream | null = null;
  let autoStarted = false;

  log.appendLine("dsh-vsc activated");

  tracker.onBatch((batch) => {
    status.setChanges(tracker.latestFiles().length);
    log.appendLine(`agent turn ${batch.turn} changed ${batch.files.length} file(s): ${batch.files.join(", ")}`);
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(RIGHT_VIEW, sidebar, {
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
    sidebar.setBase(d.base);
    if (d.alive) {
      client = new HarnessClient(d.base);
      status.setOnline(d.version ?? "?");
      log.appendLine(`harness connected at ${d.base} (version ${d.version})`);
      ensureStream(d.base);
      return;
    }
    client = null;
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
    stream.onSessionEvent = (sessionId, event) => tracker.handleEvent(sessionId, event);
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
    const client = new HarnessClient(base);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await client.isAlive(800)) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    log.appendLine(`timed out waiting for harness at ${base}`);
  }
}

export function deactivate(): void {
  // Do not kill the harness: it is a shared service, not owned by this extension.
}
