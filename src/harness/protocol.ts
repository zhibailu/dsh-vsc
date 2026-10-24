/**
 * Wire protocol for the DSH host API — **0.2.1 line (Typert Remote)**.
 *
 * Verified live against @deepseek-ai/dsh 0.2.1-rc.3 (2026-10-24); every shape
 * below is transcribed from the package's own `lib/typert.remote-client.d.ts`
 * (generated from the Host FaceModel) plus a live probe of the running harness.
 *
 * Transport (unchanged envelope, new names):
 *   unary : POST /api/<endpoint>  body {type:'client-request', rpcId, method, payload:{args}}
 *           -> {type:'server-response', rpcId, result:{ok,value}|{ok:false,error}}
 *   stream: WS /api/remote.mux    up {type:'open',streamId,endpoint,payload:{args}} | {type:'cancel',streamId}
 *                                 down {type:'item',streamId,value} | {type:'end',streamId} | {type:'error',...}
 *   auth  : GET /connect?token=<launchToken>&interactions=answer -> 302 + Set-Cookie (HttpOnly)
 *           every /api/* request and the WS handshake must carry that cookie.
 *
 * Two things a 0.1.x client gets wrong here: endpoint names are slash-separated
 * (there is NO dot-name compatibility alias — `session.models` answers 404), and
 * every argument rides `payload.args`, keyed by the Host's literal parameter
 * names (`session/list` really is `_request`, with the underscore).
 */

/** Wire request envelope. */
export interface ClientRequest {
  type: "client-request";
  rpcId: string;
  method: string;
  payload: { args: Record<string, unknown> };
}

/** Wire response envelope. */
export interface ServerResponse {
  type: "server-response";
  rpcId: string;
  result: RpcResult<unknown>;
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError };

export interface RpcError {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/** Canonical endpoint names (0.2.1 slash form). */
export const METHODS = {
  sessionList: "session/list",
  sessionPage: "session/page",
  sessionProjections: "session/projections",
  sessionCreate: "session/create",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionModelCatalog: "session/modelCatalog",
  sessionSelectModel: "session/selectModel",
  sessionUpdateQueue: "session/updateQueue",
  sessionAttachment: "session/attachment",
  workspaceCreate: "workspace/create",
  workspaceArchiveSession: "workspace/archiveSession",
  workspaceInitializeDefault: "workspace/initializeDefault",
  commandsList: "commands/list",
  commandsExecute: "commands/execute",
  agentPresetsList: "agentPresets/list",
  settingsDescribe: "settings/describe",
  settingsMutate: "settings/mutate",
  remoteEventResult: "$events/result",
} as const;

/** Transport constants (paths + the gateway-internal stream endpoints). */
export const TRANSPORT = {
  /** Launch-token exchange; mints the API cookie. */
  connectPath: "/connect",
  /** The one physical WebSocket carrying every logical Remote stream. */
  remoteMuxPath: "/api/remote.mux",
  /** Gateway-internal logical stream: forwarded Host events + answerable waterfalls. */
  eventsEndpoint: "$events",
  /** Projection control stream (host-wide). */
  controlEndpoint: "session/control",
  /** Workspace + session-visibility stream (host-wide). */
  workspaceFollowEndpoint: "workspace/follow",
  /** Per-session durable event + assistant-stream follow. */
  sessionFollowEndpoint: "session/follow",
} as const;

/* ------------------------------------------------------------------ sessions */

/**
 * `SessionAddress` is NOT a bare id: the wire rejects `{request:{sessionId}}`
 * with `gateway/input-invalid`. Subagent children are addressed via the parent.
 */
export type SessionAddress =
  | { kind: "session"; sessionId: string }
  | { kind: "subagent"; parentSessionId: string; childSessionId: string; mode: "one-shot" | "continuable" | "unknown" };

/** One `session/list` row. Titles/usage/stats are NOT here — they are projections. */
export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  /** Whether the Session currently owns a live Agent. */
  agentAvailable?: boolean;
  /** `migration-required` means the log needs a format migration before use. */
  formatStatus?: "current" | "migration-required";
  parentSessionId?: string;
  origin?: "subagent";
  cwd?: string;
  /** Projection hints (cache descriptor) — read values via session/projections. */
  projections?: { kind?: string; asOfSeq?: number; values?: Record<string, unknown> };
}

/** One durable session event as it appears on the wire. */
export interface SessionWireEvent {
  type: string;
  seq: number;
  time: number;
  data?: unknown;
  surfaceOp?: string | { op: "replace"; startSeq: number; endSeq: number };
}

/** Journal entry wrapper: the follow stream and pages both use it. */
export interface SessionEventEntry {
  type: "event";
  event: SessionWireEvent;
}

/** One backwards page of a session log (records come back chronological). */
export interface SessionPage {
  records: SessionEventEntry[];
  hasMore: boolean;
}

/** Projection snapshot with its log cut. */
export interface SessionProjectionBaseline {
  asOfSeq: number;
  values: Record<string, unknown>;
}

export type SessionProjectionsValue =
  | (SessionProjectionBaseline & { kind: "sequenced" })
  | { kind: "migration-required"; values: Record<string, unknown> }
  | null;

/** Session header carried on the opening snapshot. `version` is the log format. */
export interface SessionWireHeader {
  version: number;
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  isSeeded?: boolean;
  origin?: "subagent";
  delegationDepth?: number;
  agentPreset?: string;
}

/** Raw LLM streaming frames (process-local; no seq, droppable on reconnect). */
export type SessionAssistantStreamFrame =
  | { type: "start"; attemptId: string; revision: number; turn: number; step: number; startedAfterSeq: number }
  | { type: "chunk"; attemptId: string; revision: number; index: number; time: number; chunk: unknown }
  | {
      type: "end";
      attemptId: string;
      revision: number;
      index: number;
      outcome: { kind: "committed"; eventType: string; seq: number } | { kind: "abandoned" };
    };

/** Opening window, then ordered durable events, then optional assistant frames. */
export type SessionFollowFrame =
  | {
      type: "snapshot";
      header: SessionWireHeader;
      cursor: number;
      records: SessionEventEntry[];
      hasMore: boolean;
      projections: SessionProjectionBaseline;
      assistantStream?: { revision: number; activeAttempt?: unknown };
    }
  | SessionEventEntry
  | { type: "assistant-stream"; frame: SessionAssistantStreamFrame };

/* ------------------------------------------------------------------ prompts */

export type PromptContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string; name?: string };

/** Durable image reference. 0.2.1 adds `originalDimensions` when rescaled. */
export interface ImageAttachmentRef {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
  originalDimensions?: { width: number; height: number };
}

export interface SessionAttachmentValue {
  attachment: ImageAttachmentRef;
  data: string;
}

/** session.updateQueue action (edit/remove/steer a queued message). */
export type QueueAction =
  | { kind: "remove" }
  | { kind: "steer" }
  | { kind: "edit"; content: { type: string; text?: string }[] };

/* -------------------------------------------------- models / presets / spaces */

/** session/modelCatalog value (0.2.1: `default` + `routableProviders`, not `current`/`routable`). */
export interface ModelCatalog {
  default?: { provider: string; model: string; reasoningEffort?: string };
  routableProviders?: string[];
  groups: {
    id: string;
    name: string;
    models: {
      id: string;
      name: string;
      description?: string;
      reasoning?: { efforts: { id: string; name: string; description?: string }[]; defaultEffort?: string };
    }[];
  }[];
  failures?: { id: string; name: string; message: string }[];
}

/** agentPresets/list row — 0.2.1 carries no display copy. */
export interface AgentPresetRow {
  id: string;
  order?: number;
  isDefault?: boolean;
}

/** workspace row (also nested inside `WorkspaceValue.workspace`). */
export interface WorkspaceView {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** workspace follow frames: baseline rows, then per-workspace changes. */
export type WorkspaceFollowFrame =
  | { type: "baseline"; value: { items: WorkspaceView[]; archivedSessionIds?: string[] } }
  | { type: string; [key: string]: unknown };

/* ------------------------------------------------- forwarded Remote Events */

/** `$events` stream frames (host → client). */
export type RemoteEventFrame =
  | { type: "ready"; clientId: string; host: { home: string } }
  | { type: "emit"; event: string; args: unknown[] }
  | { type: "cancel"; eventId: string; event?: string }
  | { type: "waterfall"; eventId: string; event: string; agentId?: string; request: Record<string, unknown> };

/**
 * Answer body for `$events/result`. `next` = decline this waterfall and let the
 * next listener answer (what a bridge that cannot handle a kind should say).
 */
export type RemoteEventOutcome =
  | { kind: "next" }
  | { kind: "result"; value?: unknown }
  | { kind: "rejected"; error: { name: string; message: string; code?: string; details?: unknown } };

/* ---------------------------------------------------------------- settings */

export interface SettingsSecretView {
  path: string[];
  set: boolean;
}

export interface SettingsNamespaceView {
  ns: string;
  schema: unknown;
  value: unknown;
  base?: unknown;
  user?: unknown;
  applies: "live" | "restart";
  secrets: SettingsSecretView[];
  revision: number;
  autoGenerate?: boolean;
}

export type SettingsPathOp = { op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] };

export interface SettingsDescribeView {
  writable: boolean;
  hasDocument: boolean;
  namespaces: SettingsNamespaceView[];
}
