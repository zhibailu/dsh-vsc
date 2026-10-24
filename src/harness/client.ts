import { randomUUID } from "node:crypto";
import {
  METHODS,
  TRANSPORT,
  type AgentPresetRow,
  type ClientRequest,
  type ModelCatalog,
  type PromptContentPart,
  type QueueAction,
  type RpcError,
  type ServerResponse,
  type SessionAttachmentValue,
  type SessionPage,
  type SessionProjectionsValue,
  type SessionSummary,
  type SettingsDescribeView,
  type SettingsNamespaceView,
  type SettingsPathOp,
  type WorkspaceView,
} from "./protocol";

/** A business-level RPC failure (result.ok === false). */
export class RpcErrorResult extends Error {
  constructor(public readonly rpcError: RpcError) {
    super(`${rpcError.code}: ${rpcError.message}`);
    this.name = "RpcErrorResult";
  }
}

/** The harness answered 401: this client holds no valid API cookie yet. */
export class HarnessAuthRequired extends Error {
  constructor() {
    super("dsh web 要求认证：缺少有效的 API cookie");
    this.name = "HarnessAuthRequired";
  }
}

const SESSION_ADDRESS = (sessionId: string) => ({ kind: "session" as const, sessionId });

/**
 * Thin RPC client for a running DSH web harness — 0.2.1 Typert Remote wire.
 *
 * Two transports live here: unary RPC (`POST /api/<endpoint>`) and the one
 * piece of session state a unary caller needs (the log cut used by
 * `session/page`). Streams live in `src/events/eventStream.ts`.
 *
 * Auth: 0.2.1 fences every `/api/*` request behind a signed cookie minted by
 * `GET /connect?token=<launchToken>&interactions=answer`. The token is
 * per-process random (never written to disk), so it can only come from the
 * launch output of the harness we spawned — see `launcher.ts` — or from the
 * user's own `dsh web` URL.
 */
export class HarnessClient {
  private cookie: string | undefined;

  constructor(public readonly base: string, cookie?: string) {
    this.cookie = cookie;
  }

  /** The `Cookie` request header value, shared with the event stream's WS handshake. */
  get cookieHeader(): string | undefined {
    return this.cookie;
  }

  /**
   * Exchange a launch token for the API cookie. `interactions=answer` declares
   * that this client answers approval/question waterfalls (the panel does), so
   * the Host publishes answerable requests to it.
   */
  async connect(token: string, signal?: AbortSignal): Promise<void> {
    const url = `${this.base}${TRANSPORT.connectPath}?token=${encodeURIComponent(token)}&interactions=answer`;
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", signal });
    } catch (error) {
      throw new Error(`dsh connect: transport failed (${(error as Error).message})`);
    }
    if (res.status !== 302 && res.status !== 303 && res.status !== 204) {
      throw new Error(`dsh connect: HTTP ${res.status}（token 无效或已被替换）`);
    }
    const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    const raw = list[0] ?? res.headers.get("set-cookie") ?? "";
    const pair = raw.split(";")[0]?.trim();
    if (!pair || !pair.includes("=")) throw new Error("dsh connect: 未收到认证 cookie");
    this.cookie = pair;
  }

  /** Whether a cookie is held (does not prove it is still valid). */
  get authenticated(): boolean {
    return this.cookie !== undefined;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cookie) headers.cookie = this.cookie;
    return headers;
  }

  async call<T>(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const request: ClientRequest = { type: "client-request", rpcId: randomUUID(), method, payload: { args } };
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/${method}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      throw new Error(`dsh api ${method}: transport failed (${(error as Error).message})`);
    }
    if (res.status === 401) throw new HarnessAuthRequired();
    if (!res.ok) throw new Error(`dsh api ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as ServerResponse;
    if (!body.result.ok) throw new RpcErrorResult(body.result.error);
    return body.result.value as T;
  }

  /**
   * Cheap liveness probe. Any HTTP answer — including the auth 401 — proves a
   * harness is listening; 0.2.1 has no `host.describe` to ask.
   */
  async isAlive(timeoutMs = 1500): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: this.cookie ? { cookie: this.cookie } : {},
      });
      return res.status > 0;
    } catch {
      return false;
    }
  }

  listSessions(signal?: AbortSignal): Promise<{ items: SessionSummary[] }> {
    // NOTE: the wire parameter really is `_request` (underscore) for this verb.
    return this.call<{ items: SessionSummary[] }>(METHODS.sessionList, { _request: {} }, signal);
  }

  /**
   * One backwards page of a session log. `throughSeq` is REQUIRED and must be
   * the log cut the follow snapshot reported; records come back chronological
   * even though paging walks backwards via `beforeSeq`.
   */
  page(
    sessionId: string,
    throughSeq: number,
    beforeSeq?: number,
    maxMessages = 30,
    signal?: AbortSignal
  ): Promise<SessionPage> {
    const request: Record<string, unknown> = { address: SESSION_ADDRESS(sessionId), throughSeq, maxMessages };
    if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
    return this.call<SessionPage>(METHODS.sessionPage, { request }, signal);
  }

  /** Projection snapshot (the log cut `session/page` needs when no stream is open). */
  projections(sessionId: string): Promise<SessionProjectionsValue> {
    return this.call<SessionProjectionsValue>(METHODS.sessionProjections, {
      request: { sessionId },
    });
  }

  /** `requestId` is client-minted and persisted on the accepted user message. */
  prompt(
    sessionId: string,
    content: PromptContentPart[],
    mode: "queue" | "steer" = "queue"
  ): Promise<{ accepted: true }> {
    return this.call<{ accepted: true }>(METHODS.sessionPrompt, {
      request: { requestId: randomUUID(), sessionId, mode, content },
    });
  }

  createSession(opts?: { workspaceId?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }> {
    const request: Record<string, string> = {};
    if (opts?.workspaceId) request.workspaceId = opts.workspaceId;
    if (opts?.agentPreset) request.agentPreset = opts.agentPreset;
    return this.call(METHODS.sessionCreate, { request });
  }

  /** Register (or idempotently resolve) a directory as a DSH workspace. */
  workspaceCreate(path: string): Promise<{ workspace: WorkspaceView; created?: boolean }> {
    return this.call(METHODS.workspaceCreate, { request: { path } });
  }

  /** Default workspace for the Host's home — the fallback when no folder is open. */
  workspaceInitializeDefault(): Promise<{ workspace: WorkspaceView } | undefined> {
    return this.call(METHODS.workspaceInitializeDefault, {});
  }

  /** Archive a session (DSH's delete: hides it from session/workspace lists). */
  archiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }> {
    return this.call(METHODS.workspaceArchiveSession, { request: { sessionId } });
  }

  cancel(sessionId: string): Promise<{ accepted: true }> {
    return this.call(METHODS.sessionCancel, { request: { sessionId } });
  }

  /** Resolve one logged image ref into its bytes (base64, inline — no multipart). */
  sessionAttachment(sessionId: string, attachmentId: string): Promise<SessionAttachmentValue> {
    return this.call(METHODS.sessionAttachment, { request: { sessionId, attachmentId } });
  }

  modelCatalog(): Promise<ModelCatalog> {
    return this.call(METHODS.sessionModelCatalog, {});
  }

  selectModel(
    sessionId: string,
    provider: string,
    model: string,
    reasoningEffort?: string
  ): Promise<{ selected?: { provider: string; model: string } }> {
    const request: Record<string, unknown> = { sessionId, provider, model };
    if (reasoningEffort) request.reasoningEffort = reasoningEffort;
    return this.call(METHODS.sessionSelectModel, { request });
  }

  updateQueue(sessionId: string, itemId: string, action: QueueAction): Promise<{ accepted: true }> {
    return this.call(METHODS.sessionUpdateQueue, { request: { sessionId, itemId, action } });
  }

  /** Agent presets. 0.2.1 rows carry only id/order/isDefault — no display copy. */
  agentPresets(): Promise<{ presets: AgentPresetRow[] }> {
    return this.call(METHODS.agentPresetsList, {});
  }

  /** Slash-command catalog for a session (flat positional args, note `agentId`). */
  commandList(sessionId: string): Promise<{ name: string; description?: string; input?: { hint?: string; images?: boolean } }[]> {
    return this.call(METHODS.commandsList, { agentId: sessionId });
  }

  /** Execute one slash-command line. `submittedAttachments` is required (pass []). */
  commandExecute(
    sessionId: string,
    line: string
  ): Promise<{ commandId?: string; result?: { kind: string; text?: string }; matched?: boolean } | undefined> {
    return this.call(METHODS.commandsExecute, { agentId: sessionId, line, submittedAttachments: [] });
  }

  /** All registered settings namespaces (redacted values + schemas). */
  settingsDescribe(signal?: AbortSignal): Promise<SettingsDescribeView> {
    return this.call(METHODS.settingsDescribe, {}, signal);
  }

  /** Path-addressed edits to one namespace's user layer (optimistic revision guard). */
  settingsMutate(
    ns: string,
    ops: SettingsPathOp[],
    expectedRevision?: number,
    signal?: AbortSignal
  ): Promise<SettingsNamespaceView> {
    // `expectedRevision` must be OMITTED when unknown — the wire rejects null
    // (`gateway/input-invalid: wire field "expectedRevision" failed boundary
    // validation`, measured).
    const args: Record<string, unknown> = { ns, ops };
    if (expectedRevision !== undefined) args.expectedRevision = expectedRevision;
    return this.call(METHODS.settingsMutate, args, signal);
  }

  /**
   * Answer one forwarded Remote Event waterfall (`approval/request`,
   * `user-questions/request`). `eventId` and `clientId` come from the `$events`
   * stream this client's bridge opened; `{kind:'next'}` declines and lets the
   * next listener answer.
   */
  answerRemoteEvent(
    clientId: string,
    eventId: string,
    outcome: { kind: "next" } | { kind: "result"; value?: unknown }
  ): Promise<unknown> {
    return this.call(METHODS.remoteEventResult, { clientId, eventId, outcome });
  }
}
