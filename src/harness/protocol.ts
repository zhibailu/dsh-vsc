/**
 * Wire protocol for the DSH host API.
 * Verified against @deepseek-ai/dsh-host-apiproxy (types/api/rpc.d.ts, rpc-map.d.ts, sessions.d.ts).
 *
 * Request:   POST /api/<method>             body {type:'client-request', rpcId, method, payload}
 * Response:  HTTP 200 body                  {type:'server-response', rpcId, result}
 * Events:    WS /api/events.mux (sessions)  WS /api/events.host (host-level)
 * Trust:     Host header fence; loopback default. No token exchange.
 */

/** Wire request envelope. */
export interface ClientRequest {
  type: "client-request";
  rpcId: string;
  method: string;
  payload: unknown;
}

/** Wire response envelope. */
export interface ServerResponse {
  type: "server-response";
  rpcId: string;
  result: RpcResult<unknown>;
}

export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RpcError };

export interface RpcError {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/** host.describe value. */
export interface HostDescription {
  version: string;
  cwd: string;
  provider: string;
  model: string;
  attachedSessions: number;
  home: string;
  canOpenPath: boolean;
  /**
   * Live consumers of /api/events.mux (each browser tab and each extension
   * client counts as one; the caller's own stream is included). Added by
   * scripts/patch-dsh-client-count.ps1 — absent when the patch is not applied
   * (e.g. dsh updated but the patch not re-run). `undefined` = unknown.
   */
  clientCount?: number;
}

/** session.list item. */
export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: string;
  origin?: "subagent";
  cwd?: string;
  agentPreset?: string;
  /** Projection block; `values.title` carries the session title when known. */
  projections?: {
    values?: {
      title?: string | null;
      tokenUsage?: {
        uncachedInputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        outputTokens?: number;
      } | null;
      sessionStats?: {
        turns?: number;
        steps?: number;
        llmMs?: number;
        toolMs?: number;
        ttftMs?: number;
        ttftSteps?: number;
        decodeMs?: number;
        decodeTokens?: number;
      } | null;
      contextPressure?: {
        projectedTokens?: number;
        pressureTokens?: number;
        contextWindow?: number;
      } | null;
    };
  };
}

/** session.prompt content part (text only for the bridge; images later). */
export type PromptContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string; name?: string };

/** Canonical endpoint names (wire paths use dot notation). */
export const METHODS = {
  hostDescribe: "host.describe",
  sessionList: "session.list",
  sessionHistory: "session.history",
  sessionCreate: "session.create",
  sessionPrompt: "session.prompt",
  sessionCancel: "session.cancel",
  sessionModels: "session.models",
  sessionSelectModel: "session.selectModel",
  sessionUpdateQueue: "session.updateQueue",
  workspaceList: "workspace.list",
  workspaceCreate: "workspace.create",
  workspaceArchiveSession: "workspace.archiveSession",
  commandsList: "commands/list",
  commandsExecute: "commands/execute",
} as const;

/** workspace.list / workspace.create row (DSH workspace domain view). */
export interface WorkspaceView {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** session.updateQueue action (edit/remove/steer a queued message). */
export type QueueAction =
  | { kind: "remove" }
  | { kind: "steer" }
  | { kind: "edit"; content: { type: string; text?: string }[] };

/** session.models response value (provider groups + current selection). */
export interface ModelCatalog {
  current?: { provider: string; model: string; reasoningEffort?: string };
  routable: boolean;
  groups: { id: string; name: string; models: { id: string; name: string; description?: string }[] }[];
  failures: { id: string; name: string; message: string }[];
}
