import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { HarnessClient } from "../harness/client";
import type { PromptContentPart, QueueAction } from "../harness/protocol";
import type { HostMessage, PanelEvent, PanelSession, TodoItem, WebviewMessage } from "./protocol";

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
  private phase: "searching" | "starting" | "online" | "offline" = "searching";
  /** Live todo list of the active session (todos projection, realtime mux push). */
  private todos: TodoItem[] = [];

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
      if (sessionId !== this.activeSessionId) return;
      if (event.type === "session/queue") {
        // Queue state snapshot — render the pending-send rows above the input.
        const data = (event.data ?? {}) as { items?: { id?: unknown; placement?: unknown; message?: { content?: { type?: string; text?: string }[] } }[] };
        this.post({
          type: "queue",
          sessionId,
          items: (data.items ?? []).map((it) => ({
            id: String(it.id ?? ""),
            placement: String(it.placement ?? "queued"),
            text: (it.message?.content ?? [])
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text as string)
              .join(""),
          })),
        });
        return;
      }
      if (event.type === "session/projection") {
        // Realtime projection push — the `todos` unit carries the current
        // turn's whole task list, reset to null on every turn/start (mirrors
        // the web GUI's task bar exactly). Other projection frames fall
        // through to the generic event path below.
        const data = (event.data ?? {}) as { key?: unknown; value?: unknown };
        if (data.key === "todos") {
          this.todos = Array.isArray(data.value) ? (data.value as TodoItem[]) : [];
          this.post({ type: "todos", sessionId, items: this.todos });
          return;
        }
      }
      this.post({ type: "event", sessionId, event });
    });
    // Keep the @ file index fresh.
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.buildFileIndex()),
      vscode.workspace.onDidCreateFiles(() => void this.buildFileIndex()),
      vscode.workspace.onDidDeleteFiles(() => void this.buildFileIndex())
    );
  }

  /** Called by extension.ts when harness connectivity changes. */
  setClient(client: HarnessClient | null, version?: string): void {
    this.client = client;
    this.connected = client !== null;
    this.version = version;
    this.phase = client ? "online" : "offline";
    void this.refresh();
  }

  /** Loading-phase hint from the extension (searching / starting). */
  setPhase(phase: "searching" | "starting" | "online" | "offline"): void {
    this.phase = phase;
    this.postState();
  }

  async refresh(): Promise<void> {
    if (!this.client) {
      this.post({ type: "state", connected: false, sessions: [], activeSessionId: null });
      return;
    }
    try {
      const [list, workspaces] = await Promise.all([
        this.client.listSessions(),
        this.client.workspaceList(),
      ]);
      const archived = new Set(workspaces.archivedSessionIds);
      const { items } = list;
      let sessions = items
        .filter((item) => !item.blank && !archived.has(item.sessionId))
        .map((item) => ({
          sessionId: item.sessionId,
          running: item.running,
          blank: item.blank,
          updatedAt: item.updatedAt,
          title: item.projections?.values?.title ?? undefined,
          usage: item.projections?.values?.tokenUsage ?? undefined,
          stats: item.projections?.values?.sessionStats ?? undefined,
          context: item.projections?.values?.contextPressure ?? undefined,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      // A freshly created session is blank until its first prompt; keep it
      // visible as the active session instead of silently reverting.
      if (this.activeSessionId && !sessions.some((s) => s.sessionId === this.activeSessionId)) {
        sessions.unshift({
          sessionId: this.activeSessionId,
          running: false,
          blank: true,
          updatedAt: Date.now(),
          title: "新会话",
          usage: undefined,
          stats: undefined,
          context: undefined,
        });
      }
      this.sessions = sessions;
      if (this.sessions.length > 0 && !this.sessions.some((s) => s.sessionId === this.activeSessionId)) {
        this.activeSessionId = this.sessions[0].sessionId;
      }
      this.postState();
      if (this.activeSessionId) {
        await this.loadHistory(this.activeSessionId, undefined);
        await this.postModels();
        await this.postCommands();
      }
    } catch (error) {
      this.post({ type: "error", message: `会话列表失败: ${(error as Error).message}` });
    }
  }

  private async postCommands(): Promise<void> {
    if (!this.client || !this.activeSessionId) return;
    try {
      const items = await this.client.commandList(this.activeSessionId);
      this.post({ type: "commands", items });
    } catch (error) {
      this.log(`commands: ${(error as Error).message}`);
    }
  }

  /**
   * Resolve the current VS Code workspace folder to a DSH workspace id
   * (registering the path idempotently). No folder open → undefined, and new
   * sessions then fall back to the host's default workspace.
   */
  private async resolveWorkspaceId(): Promise<string | undefined> {
    try {
      if (!this.client) return undefined;
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) return undefined;
      const { workspace } = await this.client.workspaceCreate(folders[0].uri.fsPath);
      return workspace.workspaceId;
    } catch (error) {
      this.log(`workspace: ${(error as Error).message}`);
      return undefined;
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
        await this.buildFileIndex();
        break;
      case "selectSession":
        this.activeSessionId = message.sessionId;
        // State first: the panel drops history frames for any session that is
        // not its current activeSessionId, so switch the panel's identity
        // before shipping history, or the page gets wiped to "no messages".
        this.postState();
        await this.loadHistory(message.sessionId, undefined);
        await this.postModels();
        await this.postCommands();
        break;
      case "getModels":
        await this.postModels();
        break;
      case "selectModel": {
        if (!this.activeSessionId) break;
        try {
          await this.client.selectModel(this.activeSessionId, message.provider, message.model);
          await this.postModels();
        } catch (error) {
          this.post({ type: "error", message: `切换模型失败: ${(error as Error).message}` });
        }
        break;
      }
      case "newSession": {
        try {
          const workspaceId = await this.resolveWorkspaceId();
          const { sessionId } = await this.client.createSession(workspaceId ? { workspaceId } : {});
          this.activeSessionId = sessionId;
          await this.refresh();
        } catch (error) {
          this.post({ type: "error", message: `新建会话失败: ${(error as Error).message}` });
        }
        break;
      }
      case "deleteSession": {
        if (!this.activeSessionId) break;
        try {
          await this.client.archiveSession(message.sessionId);
          if (this.activeSessionId === message.sessionId) this.activeSessionId = null;
          await this.refresh();
        } catch (error) {
          this.post({ type: "error", message: `删除会话失败: ${(error as Error).message}` });
        }
        break;
      }
      case "copyText":
        void vscode.env.clipboard.writeText(message.text).then(
          () => undefined,
          (error) => this.post({ type: "error", message: `复制失败: ${(error as Error).message}` })
        );
        break;
      case "queueSteer":
      case "queueRemove": {
        if (!this.activeSessionId) break;
        const action: QueueAction = message.type === "queueSteer" ? { kind: "steer" } : { kind: "remove" };
        try {
          await this.client.updateQueue(this.activeSessionId, message.itemId, action);
        } catch (error) {
          this.post({ type: "error", message: `队列操作失败: ${(error as Error).message}` });
        }
        break;
      }
      case "send": {
        const text = message.text.trim();
        const content: PromptContentPart[] = [];
        for (const a of message.attachments ?? []) {
          content.push({ type: "image", mediaType: a.mediaType, data: a.data, name: a.name });
        }
        if (text) content.push({ type: "text", text });
        if (content.length === 0) return;
        const mode = message.mode ?? "queue";
        let sessionId = this.activeSessionId;
        if (!sessionId) {
          try {
            const workspaceId = await this.resolveWorkspaceId();
            const created = await this.client.createSession(workspaceId ? { workspaceId } : {});
            sessionId = created.sessionId;
            this.activeSessionId = sessionId;
          } catch (error) {
            this.post({ type: "error", message: `新建会话失败: ${(error as Error).message}` });
            return;
          }
        }
        // A leading-slash line is a real slash command — dispatch it through the
        // commands domain instead of sending it to the agent as plain text.
        if (mode === "queue" && text && text.startsWith("/") && content.length === 1) {
          try {
            const outcome = await this.client.commandExecute(sessionId, text);
            this.post({
              type: "cmdResult",
              text: outcome?.result?.text ?? `命令已执行：${text}`,
              ok: outcome?.result?.kind !== "error",
            });
            await this.refresh();
          } catch (error) {
            this.post({ type: "error", message: `命令执行失败: ${(error as Error).message}` });
          }
          return;
        }
        try {
          await this.client.prompt(sessionId, content, mode);
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
      case "refreshFiles":
        await this.buildFileIndex();
        break;
    }
  }

  /**
   * Build a workspace file index (files + all ancestor dirs) once and push it
   * to the panel for LOCAL, millisecond @ filtering. Folders sort before files.
   */
  private async buildFileIndex(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.post({ type: "index", files: [], dirs: [] });
      return;
    }
    const root = folders[0].uri.fsPath;
    let uris: vscode.Uri[] = [];
    try {
      uris = await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,dist,.git,out,build,coverage,.vscode-test,.vscode-test-ext}/**",
        500
      );
      uris = uris.filter((uri) => !/\.vsix$/i.test(uri.fsPath));
    } catch {
      /* empty list */
    }
    const files = uris
      .map((uri) => path.relative(root, uri.fsPath).replaceAll("\\", "/"))
      .sort((a, b) => a.localeCompare(b));
    const dirSet = new Set<string>();
    for (const file of files) {
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) {
        dirSet.add(parts.slice(0, i).join("/"));
      }
    }
    const dirs = [...dirSet].sort((a, b) => a.localeCompare(b));
    this.post({ type: "index", files, dirs });
  }

  /** Load a history page ending before `beforeSeq` (tail when undefined). */
  private async loadHistory(sessionId: string, beforeSeq?: number): Promise<void> {
    if (!this.client || !sessionId) return;
    try {
      const { events, projections } = await this.client.history(sessionId, beforeSeq, 30);
      const mapped = events.map((entry) => entry.event as PanelEvent);
      // Task bar mirrors the web GUI: it renders the host-computed `todos`
      // projection (current turn's todo list; null after a turn/start reset),
      // NOT the raw log. Seed it from the tail page's projections block so a
      // freshly opened session shows the same state as the web tab.
      if (beforeSeq === undefined) {
        const todos = projections?.values?.todos;
        this.todos = Array.isArray(todos) ? todos : [];
        this.post({ type: "todos", sessionId, items: this.todos });
      }
      this.post({ type: "history", sessionId, events: mapped, hasMore: false });
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

  private async postModels(): Promise<void> {
    if (!this.client || !this.activeSessionId) return;
    try {
      const catalog = await this.client.models(this.activeSessionId);
      this.post({
        type: "models",
        current: catalog.current,
        groups: catalog.groups.map((g) => ({
          id: g.id,
          name: g.name,
          models: g.models.map((m) => ({ id: m.id, name: m.name })),
        })),
      });
    } catch (error) {
      // Model catalog is advisory; fail silently rather than spamming errors.
      this.log(`models: ${(error as Error).message}`);
    }
  }

  private postState(): void {
    this.post({
      type: "state",
      connected: this.connected,
      version: this.version,
      phase: this.phase,
      // live title event wins; otherwise the projection title from session.list
      sessions: this.sessions.map((s) => ({ ...s, title: this.titles.get(s.sessionId) ?? s.title })),
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
    let html = fs.readFileSync(panelPath.fsPath, "utf8");
    try {
      const whaleUri = this.view?.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "dist", "media", "dsh-whale.svg")
      );
      html = html.replaceAll("__WHALE_URI__", whaleUri?.toString() ?? "");
    } catch {
      /* keep the placeholder; the loading view degrades to text */
    }
    return html;
  }
}
