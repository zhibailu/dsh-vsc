/**
 * Native sidebar panel — webview ↔ extension-host message protocol.
 * The panel is plain JS (inline in panel.html); these types drive the host side.
 */

/** A raw session event forwarded to the panel (wire passthrough). */
export interface PanelEvent {
  type: string;
  seq?: number;
  /** Unix epoch ms stamped by the harness on every durable log entry. */
  time?: number;
  data?: Record<string, unknown>;
  surfaceOp?: string;
}

/** One bridge-computed line diff for a tool call ("+N-M"). */
export interface ToolLineDiff {
  added: number;
  deleted: number;
  /** Resolved absolute path (when resolvable) or the raw tool argument. */
  path?: string;
}

/** One todo item — the `todos` projection unit (dsh-tool-todo / dsh-session types). */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** Host → webview messages. */
export type HostMessage =
  | {
      type: "state";
      connected: boolean;
      version?: string;
      phase?: "searching" | "starting" | "online" | "offline";
      sessions: PanelSession[];
      activeSessionId: string | null;
    }
  | { type: "event"; sessionId: string; event: PanelEvent }
  | { type: "history"; sessionId: string; events: PanelEvent[]; hasMore: boolean; isOlder?: boolean; toolDiffs?: Record<string, ToolLineDiff> }
  | { type: "running"; sessionId: string; running: boolean }
  | { type: "pickedFile"; path: string }
  | { type: "index"; files: string[]; dirs: string[] }
  | { type: "models"; current?: { provider: string; model: string }; groups: { id: string; name: string; models: { id: string; name: string }[] }[] }
  | { type: "queue"; sessionId: string; items: { id: string; placement: string; text: string }[] }
  | { type: "commands"; items: { name: string; description?: string; input?: { hint?: string; images?: boolean } }[] }
  | { type: "cmdResult"; text: string; ok: boolean }
  | { type: "todos"; sessionId: string; items: TodoItem[] }
  | { type: "toolDiff"; sessionId: string; callId: string; added: number; deleted: number; path?: string }
  | { type: "error"; message: string };

/** Webview → host messages. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "selectSession"; sessionId: string }
  | { type: "newSession" }
  | { type: "deleteSession"; sessionId: string }
  | { type: "send"; text: string; mode?: "queue" | "steer"; attachments?: { mediaType: string; data: string; name?: string }[] }
  | { type: "loadOlder"; beforeSeq: number }
  | { type: "cancel" }
  | { type: "refresh" }
  | { type: "refreshFiles" }
  | { type: "getModels" }
  | { type: "selectModel"; provider: string; model: string }
  | { type: "copyText"; text: string }
  | { type: "openFile"; path: string }
  | { type: "queueSteer"; itemId: string }
  | { type: "queueRemove"; itemId: string };

export interface PanelSession {
  sessionId: string;
  running: boolean;
  blank: boolean;
  updatedAt: number;
  title?: string;
  /** tokenUsage projection (aggregate over the durable log). */
  usage?: {
    uncachedInputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
  };
  /** sessionStats projection — the web composer's status line source. */
  stats?: {
    turns?: number;
    steps?: number;
    llmMs?: number;
    toolMs?: number;
    ttftMs?: number;
    ttftSteps?: number;
    decodeMs?: number;
    decodeTokens?: number;
  };
  /** contextPressure projection — context occupancy ring source. */
  context?: {
    projectedTokens?: number;
    pressureTokens?: number;
    contextWindow?: number;
  };
}
