import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { HarnessClient } from "../harness/client";
import type { PromptContentPart, QueueAction } from "../harness/protocol";
import type { HostMessage, PanelEvent, PanelSession, TodoItem, ToolLineDiff, WebviewMessage } from "./protocol";
import { countMetaDiff, countToolArgsDiff } from "../editor/diffCount";
import { INTENT_CHOICES, sendAsk } from "../editor/askSelection";

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
  /** Current permission presets of the active session (permissions projection,
   *  seeded from history tail + refreshed by session/projection pushes).
   *  Wire values: read-only / workspace-write / danger-full-access. */
  private permissions: { options: { value: string; name?: string }[]; currentValue?: string } | null = null;
  /**
   * Pending file-mutation calls (callId → name+args), kept so the tool/result
   * can refine the bridge-computed diff with the tool's own meta.diffs hunks.
   */
  private pendingArgs = new Map<string, { name: string; args: Record<string, unknown>; path?: string }>();
  private readonly maxPendingArgs = 400;
  /** Context block of a pending in-panel ask card (set by showAskCard). */
  private askContext: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
    private readonly getClient: () => HarnessClient | null,
    private readonly onSessionEvent: (cb: (sessionId: string, event: PanelEvent) => void) => void
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const html = this.renderHtml();
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "media")],
    };
    webviewView.webview.html = html;
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
        // the web GUI's task bar exactly). The `permissions` unit carries the
        // session's permission presets (header 权限 select). Other projection
        // frames fall through to the generic event path below.
        const data = (event.data ?? {}) as { key?: unknown; value?: unknown };
        if (data.key === "todos") {
          this.todos = Array.isArray(data.value) ? (data.value as TodoItem[]) : [];
          this.post({ type: "todos", sessionId, items: this.todos });
          return;
        }
        if (data.key === "permissions") {
          const value = data.value as { options?: { value: string; name?: string }[]; currentValue?: string } | undefined;
          if (value && Array.isArray(value.options)) {
            this.permissions = { options: value.options, currentValue: value.currentValue };
            this.postPermissions();
          }
          return;
        }
      }
      // Bridge-computed per-call line diffs ride alongside the raw event so
      // the panel can show "+N-M" on the tool card immediately (and refine it
      // once the tool's own result-time hunks land).
      if (event.type === "tool/call") {
        this.handleToolCallDiff(sessionId, event);
      } else if (event.type === "tool/result") {
        this.handleToolResultDiff(sessionId, event);
      }
      // Answerable interaction frames (approval/requested, question/requested)
      // carry their envelope rpcId — forward them as a dedicated interaction
      // message so the panel can render a decision card and answer via
      // /api/respond (the raw event is ALSO posted below; the panel ignores
      // it for interaction kinds). Settled frames close the card.
      if (event.type === "approval/requested" || event.type === "question/requested") {
        this.handleInteraction(sessionId, event);
      } else if (event.type === "approval/resolved" || event.type === "question/resolved") {
        const rpcId = event.rpcId ?? "";
        if (rpcId) this.post({ type: "interactionSettled", sessionId, rpcId });
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

  /**
   * Show an in-panel "ask about selection" card (preferred path for
   * dsh.askSelection): the editor context block is rendered inside the
   * sidebar with the intent choices, so the whole flow stays in the panel
   * instead of a VS Code quick-pick. The pick is answered via askPick /
   * askCancel and shipped by sendAsk().
   */
  showAskCard(contextBlock: string): void {
    this.askContext = contextBlock;
    this.post({ type: "ask", context: contextBlock, choices: INTENT_CHOICES });
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
          agentPreset: item.agentPreset,
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
          agentPreset: undefined,
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
        this.postPermissions();
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
        this.postPermissions();
        break;
      case "getModels":
        await this.postModels();
        break;
      case "selectModel": {
        if (!this.activeSessionId) break;
        try {
          await this.client.selectModel(this.activeSessionId, message.provider, message.model, message.reasoningEffort);
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
      case "askPick": {
        const context = this.askContext;
        this.askContext = null;
        if (!context || !this.client) {
          this.post({ type: "error", message: "Ask 卡片已失效，请重新选中代码再试。" });
          break;
        }
        const choice = INTENT_CHOICES.find((c) => c.id === message.choiceId);
        let instruction: string;
        if (choice && choice.id !== "custom") {
          instruction = choice.label;
        } else {
          const custom = (message.customText ?? "").trim();
          if (!custom) {
            this.post({ type: "error", message: "请输入指令。" });
            break;
          }
          instruction = custom;
        }
        try {
          await sendAsk(this.client, context, instruction);
        } catch (error) {
          this.post({ type: "error", message: `发送失败 — ${(error as Error).message}` });
        }
        break;
      }
      case "askCancel":
        this.askContext = null;
        break;
      case "respondApproval": {
        if (!this.client) {
          this.post({ type: "error", message: "harness 未连接" });
          break;
        }
        try {
          await this.client.respond(message.rpcId, {
            sessionId: message.sessionId,
            approvalId: message.approvalId,
            outcome: message.outcome,
          });
        } catch (error) {
          this.post({ type: "error", message: `审批应答失败: ${(error as Error).message}` });
        }
        break;
      }
      case "respondQuestion": {
        if (!this.client) {
          this.post({ type: "error", message: "harness 未连接" });
          break;
        }
        try {
          await this.client.respond(message.rpcId, {
            sessionId: message.sessionId,
            answer: { answers: message.answers },
          });
        } catch (error) {
          this.post({ type: "error", message: `选择题应答失败: ${(error as Error).message}` });
        }
        break;
      }
      case "getPermissions":
        this.postPermissions();
        break;
      case "selectPermission": {
        if (!this.activeSessionId) break;
        try {
          // Same admission path as the web composer's /permission picker:
          // run the slash command against the session's agent.
          const outcome = await this.client?.commandExecute(this.activeSessionId, `/permission ${message.permission}`);
          if (outcome === undefined || (outcome as { matched?: boolean }).matched === false) {
            this.post({ type: "error", message: `切换权限失败: host 未提供 /permission 命令` });
          }
        } catch (error) {
          this.post({ type: "error", message: `切换权限失败: ${(error as Error).message}` });
        }
        break;
      }
      case "openFile": {
        let abs = message.path;
        if (!path.isAbsolute(abs)) {
          const folder = vscode.workspace.workspaceFolders?.[0];
          if (folder) abs = path.join(folder.uri.fsPath, abs);
        }
        void vscode.window
          .showTextDocument(vscode.Uri.file(abs), { preview: true })
          .then(
            () => undefined,
            (error) => this.post({ type: "error", message: `打开文件失败: ${(error as Error).message}` })
          );
        break;
      }
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

  /** Load a history page ending before `beforeSeq` (tail when undefined).
   *  Older pages are prepends (isOlder: true) so the webview can append them
   *  above the current messages without rebuilding the list. */
  private async loadHistory(sessionId: string, beforeSeq?: number): Promise<void> {
    if (!this.client || !sessionId) return;
    try {
      const { events, projections, hasMore } = await this.client.history(sessionId, beforeSeq, 30);
      const mapped = events.map((entry) => entry.event as PanelEvent);
      // Per-call "+N-M" diffs for this page, shipped inside the history frame
      // so the panel has them in hand while folding the page in.
      const toolDiffs = this.diffEntriesForPage(mapped);
      // Task bar mirrors the web GUI: it renders the host-computed `todos`
      // projection (current turn's todo list; null after a turn/start reset),
      // NOT the raw log. Seed it from the tail page's projections block so a
      // freshly opened session shows the same state as the web tab.
      if (beforeSeq === undefined) {
        const todos = projections?.values?.todos;
        this.todos = Array.isArray(todos) ? todos : [];
        this.post({ type: "todos", sessionId, items: this.todos });
        // Permission presets ride the same projections block (web GUI's
        // 权限 select): seed the header select from the tail page.
        const perms = projections?.values?.permissions;
        if (perms) {
          this.permissions = { options: perms.options ?? [], currentValue: perms.currentValue };
          this.postPermissions();
        }
      }
      this.post({
        type: "history",
        sessionId,
        events: mapped,
        hasMore: hasMore === true,
        isOlder: beforeSeq !== undefined,
        toolDiffs: Object.keys(toolDiffs).length > 0 ? toolDiffs : undefined,
      });
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

  /**
   * Forward an answerable interaction frame (approval/requested or
   * question/requested) to the panel as a dedicated `interaction` message.
   * The panel answers by echoing `rpcId` through respondApproval /
   * respondQuestion; the host then calls /api/respond.
   */
  private handleInteraction(sessionId: string, event: PanelEvent): void {
    const rpcId = event.rpcId;
    if (!rpcId) return; // unreachable frame — cannot answer it
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "approval/requested") {
      this.post({
        type: "interaction",
        sessionId,
        rpcId,
        kind: "approval",
        approvalId: String(data.approvalId ?? ""),
        toolName: String(data.toolName ?? ""),
        callId: data.callId !== undefined ? String(data.callId) : undefined,
        reason: data.reason !== undefined ? String(data.reason) : undefined,
      });
      return;
    }
    if (event.type === "question/requested") {
      const raw = Array.isArray(data.questions) ? (data.questions as Record<string, unknown>[]) : [];
      this.post({
        type: "interaction",
        sessionId,
        rpcId,
        kind: "question",
        questions: raw.map((q) => ({
          id: String(q.id ?? ""),
          question: String(q.question ?? ""),
          detail: q.detail !== undefined ? String(q.detail) : undefined,
          header: q.header !== undefined ? String(q.header) : undefined,
          multiSelect: q.multiSelect === true,
          options: Array.isArray(q.options)
            ? (q.options as Record<string, unknown>[]).map((o) => ({
                label: String(o.label ?? ""),
                description: o.description !== undefined ? String(o.description) : undefined,
              }))
            : undefined,
          intent:
            q.intent && typeof q.intent === "object"
              ? {
                  kind: String((q.intent as Record<string, unknown>).kind ?? ""),
                  approve: String((q.intent as Record<string, unknown>).approve ?? ""),
                }
              : undefined,
        })),
      });
    }
  }

  /* ---------- bridge-computed per-tool line diffs ("+N-M") ---------- */

  /** Resolve a possibly-relative tool path against the first workspace root. */
  private resolveToolPath(raw: string): string | null {
    if (!raw || raw.trim().length === 0) return null;
    if (path.isAbsolute(raw)) return raw;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return null;
    return path.join(folder.uri.fsPath, raw);
  }

  /** Pre-write content of a file (best effort; the harness usually applies
   *  the mutation after emitting tool/call, so this is the old version). */
  private readOldFile(raw: string): string | null {
    const abs = this.resolveToolPath(raw);
    if (!abs) return null;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return null;
      return fs.readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  }

  private parseToolArgs(argumentsText: unknown): Record<string, unknown> {
    try {
      const parsed = JSON.parse(String(argumentsText ?? "{}")) as Record<string, unknown>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private rememberPendingArgs(callId: string, name: string, args: Record<string, unknown>, filePath?: string): void {
    this.pendingArgs.set(callId, { name, args, path: filePath });
    if (this.pendingArgs.size > this.maxPendingArgs) {
      const oldest = this.pendingArgs.keys().next().value;
      if (oldest !== undefined) this.pendingArgs.delete(oldest);
    }
  }

  /** tool/call: count from the arguments alone (visible while still running). */
  private handleToolCallDiff(sessionId: string, event: PanelEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const name = String(data.name ?? "");
    const callId = String(data.callId ?? "");
    if (!name || !callId) return;
    const args = this.parseToolArgs(data.arguments);
    const diff = countToolArgsDiff(name, args, (p) => this.readOldFile(p));
    if (diff) {
      const rawPath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
      const filePath = this.resolveToolPath(rawPath) ?? (rawPath || undefined);
      this.rememberPendingArgs(`${sessionId}:${callId}`, name, args, filePath);
      this.post({ type: "toolDiff", sessionId, callId, added: diff.added, deleted: diff.deleted, path: filePath });
    }
  }

  /** tool/result: refine with the tool's own result-time hunks (meta.diffs). */
  private handleToolResultDiff(sessionId: string, event: PanelEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const msg = (data.message ?? {}) as Record<string, unknown>;
    let callId = String(data.callId ?? "");
    if (!callId && Array.isArray(msg.content)) {
      for (const block of msg.content as Record<string, unknown>[]) {
        if (block && block.type === "tool-result" && block.toolCallId) {
          callId = String(block.toolCallId);
          break;
        }
      }
    }
    if (!callId) return;
    const pending = this.pendingArgs.get(`${sessionId}:${callId}`);
    if (!pending) return;
    this.pendingArgs.delete(`${sessionId}:${callId}`);
    const refined = countMetaDiff(data.meta, pending.name, pending.args);
    if (refined) {
      this.post({ type: "toolDiff", sessionId, callId, added: refined.added, deleted: refined.deleted, path: pending.path });
    }
  }

  /**
   * History path: recompute the per-call diffs for one page and ship them as a
   * map (the panel merges it before applying the page's events). tool/result
   * hunks win over arg-based counts, matching the live path.
   */
  private diffEntriesForPage(events: PanelEvent[]): Record<string, ToolLineDiff> {
    const entries: Record<string, ToolLineDiff> = {};
    const pending = new Map<string, { name: string; args: Record<string, unknown>; path?: string }>();
    for (const ev of events) {
      const data = (ev.data ?? {}) as Record<string, unknown>;
      if (ev.type === "tool/call") {
        const name = String(data.name ?? "");
        const callId = String(data.callId ?? "");
        if (!name || !callId) continue;
        const args = this.parseToolArgs(data.arguments);
        const rawPath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
        const filePath = this.resolveToolPath(rawPath) ?? (rawPath || undefined);
        pending.set(callId, { name, args, path: filePath });
        const diff = countToolArgsDiff(name, args, (p) => this.readOldFile(p));
        if (diff) entries[callId] = { ...diff, path: filePath };
      } else if (ev.type === "tool/result") {
        const msg = (data.message ?? {}) as Record<string, unknown>;
        let callId = String(data.callId ?? "");
        if (!callId && Array.isArray(msg.content)) {
          for (const block of msg.content as Record<string, unknown>[]) {
            if (block && block.type === "tool-result" && block.toolCallId) {
              callId = String(block.toolCallId);
              break;
            }
          }
        }
        if (!callId) continue;
        const call = pending.get(callId);
        if (!call) continue;
        const refined = countMetaDiff(data.meta, call.name, call.args);
        if (refined) entries[callId] = { ...refined, path: call.path };
      }
    }
    return entries;
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

  private async postPermissions(): Promise<void> {
    // Post the cached permissions projection (seeded from history tail,
    // refreshed by session/projection pushes). Header labels come from the
    // known three presets (web GUI semantics: 仅可查看 / 可写入工作区 / 完全权限).
    if (!this.permissions || this.permissions.options.length === 0) {
      this.post({ type: "permissions", options: [], current: undefined });
      return;
    }
    const LABELS: Record<string, string> = {
      "read-only": "仅可查看",
      "workspace-write": "可写入工作区",
      "danger-full-access": "完全权限",
    };
    this.post({
      type: "permissions",
      options: this.permissions.options.map((o) => ({
        value: o.value,
        label: LABELS[o.value] ?? o.name ?? o.value,
      })),
      current: this.permissions.currentValue,
    });
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
