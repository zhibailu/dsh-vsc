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
  projections?: { values?: { title?: string | null } };
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
} as const;
