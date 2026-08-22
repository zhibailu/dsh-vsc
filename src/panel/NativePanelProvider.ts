import * as vscode from "vscode";
import * as fs from "node:fs";
import { HarnessClient } from "../harness/client";
import type { HostMessage, PanelEvent, PanelSession, WebviewMessage } from "./protocol";

/**
 * Phase 1 — native sidebar chat panel.
 * Renders the conversation natively (VS Code themed), driven by the mux event
 * stream + session.history, with prompt via session.prompt. This replaces the
 * embedded DSH webview as the main surface (embed moves to dsh.openWebView).
 */
export class NativePanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "dsh.sidebar.right";

  private view?: vscode.WebviewView;
  private client: HarnessClient | null = null;
  private activeSessionId: string | null = null;
  private sessions: PanelSession[] = [];
  private titles = new Map<string, string>();
  private connected = false;
  private version?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
    private readonly getClient: () => HarnessClient | null,
    private readonly onSessionEvent: (cb: (sessionId: string, event: PanelEvent) => void) => void
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "media")],
    };
    webviewView.webview.html = this.renderHtml();
    webviewView.webview.onDidReceiveMessage((message) => {
      void this.onMessage(message as WebviewMessage);
    });
    // Route mux events into this panel (filtered by active session host-side).
    this.onSessionEvent((sessionId, event) => {
      this.trackRunning(sessionId, event);
      if (sessionId === this.activeSessionId) {
        this.post({ type: "event", sessionId, event });
      }
    });
  }

  /** Called by extension.ts when harness connectivity changes. */
  setClient(client: HarnessClient | null, version?: string): void {
    this.client = client;
    this.connected = client !== null;
    this.version = version;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.client) {
      this.post({ type: "state", connected: false, sessions: [], activeSessionId: null });
      return;
    }
    try {
      const { items } = await this.client.listSessions();
      this.sessions = items
        .filter((item) => !item.blank)
        .map((item) => ({
          sessionId: item.sessionId,
          running: item.running,
          blank: item.blank,
          updatedAt: item.updatedAt,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      if (this.sessions.length > 0 && !this.sessions.some((s) => s.sessionId === this.activeSessionId)) {
        this.activeSessionId = this.sessions[0].sessionId;
      }
      this.postState();
      if (this.activeSessionId) {
        await this.loadHistory(this.activeSessionId, undefined);
      }
    } catch (error) {
      this.post({ type: "error", message: `会话列表失败: ${(error as Error).message}` });
    }
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    if (!this.client) {
      this.post({ type: "error", message: "harness 未连接" });
      return;
    }
    switch (message.type) {
      case "ready":
        this.postState();
        if (this.activeSessionId) {
          await this.loadHistory(this.activeSessionId, undefined);
        }
        break;
      case "selectSession":
        this.activeSessionId = message.sessionId;
        await this.loadHistory(message.sessionId, undefined);
        this.postState();
        break;
      case "newSession": {
        try {
          const { sessionId } = await this.client.createSession();
          this.activeSessionId = sessionId;
          await this.refresh();
        } catch (error) {
          this.post({ type: "error", message: `新建会话失败: ${(error as Error).message}` });
        }
        break;
      }
      case "send": {
        const text = message.text.trim();
        if (!text) return;
        let sessionId = this.activeSessionId;
        if (!sessionId) {
          try {
            const created = await this.client.createSession();
            sessionId = created.sessionId;
            this.activeSessionId = sessionId;
          } catch (error) {
            this.post({ type: "error", message: `新建会话失败: ${(error as Error).message}` });
            return;
          }
        }
        try {
          await this.client.prompt(sessionId, [{ type: "text", text }], "queue");
          this.post({ type: "running", sessionId, running: true });
          await this.refresh();
        } catch (error) {
          this.post({ type: "error", message: `发送失败: ${(error as Error).message}` });
        }
        break;
      }
      case "loadOlder":
        await this.loadHistory(this.activeSessionId ?? "", message.beforeSeq);
        break;
      case "cancel":
        if (this.activeSessionId) {
          try {
            await this.client.cancel(this.activeSessionId);
            this.post({ type: "running", sessionId: this.activeSessionId, running: false });
          } catch (error) {
            this.post({ type: "error", message: `停止失败: ${(error as Error).message}` });
          }
        }
        break;
      case "refresh":
        await this.refresh();
        break;
    }
  }

  /** Load a history page ending before `beforeSeq` (tail when undefined). */
  private async loadHistory(sessionId: string, beforeSeq?: number): Promise<void> {
    if (!this.client || !sessionId) return;
    try {
      const { events } = await this.client.history(sessionId, beforeSeq, 30);
      this.post({ type: "history", sessionId, events: events.map((entry) => entry.event as PanelEvent), hasMore: false });
    } catch (error) {
      this.post({ type: "error", message: `读取历史失败: ${(error as Error).message}` });
    }
  }

  /** Derive per-session running state from turn events. */
  private trackRunning(sessionId: string, event: PanelEvent): void {
    if (event.type === "turn/start") {
      this.post({ type: "running", sessionId, running: true });
    } else if (event.type === "turn/end") {
      this.post({ type: "running", sessionId, running: false });
    } else if (event.type === "session/title") {
      const title = (event.data as { title?: string } | undefined)?.title;
      if (typeof title === "string") {
        this.titles.set(sessionId, title);
        if (sessionId === this.activeSessionId) this.postState();
      }
    }
  }

  private postState(): void {
    this.post({
      type: "state",
      connected: this.connected,
      version: this.version,
      sessions: this.sessions.map((s) => ({ ...s, title: this.titles.get(s.sessionId) })),
      activeSessionId: this.activeSessionId,
    });
  }

  private post(message: HostMessage): void {
    try {
      void this.view?.webview.postMessage(message);
    } catch {
      /* panel disposed */
    }
  }

  private renderHtml(): string {
    const panelPath = vscode.Uri.joinPath(this.context.extensionUri, "dist", "media", "native", "panel.html");
    return fs.readFileSync(panelPath.fsPath, "utf8");
  }
}
