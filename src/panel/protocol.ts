/**
 * Native sidebar panel — webview ↔ extension-host message protocol.
 * The panel is plain JS (inline in panel.html); these types drive the host side.
 */

/** A raw session event forwarded to the panel (wire passthrough). */
export interface PanelEvent {
  type: string;
  seq?: number;
  data?: Record<string, unknown>;
  surfaceOp?: string;
}

/** Host → webview messages. */
export type HostMessage =
  | {
      type: "state";
      connected: boolean;
      version?: string;
      sessions: PanelSession[];
      activeSessionId: string | null;
    }
  | { type: "event"; sessionId: string; event: PanelEvent }
  | { type: "history"; sessionId: string; events: PanelEvent[]; hasMore: boolean }
  | { type: "running"; sessionId: string; running: boolean }
  | { type: "pickedFile"; path: string }
  | { type: "error"; message: string };

/** Webview → host messages. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "selectSession"; sessionId: string }
  | { type: "newSession" }
  | { type: "send"; text: string }
  | { type: "loadOlder"; beforeSeq: number }
  | { type: "cancel" }
  | { type: "refresh" }
  | { type: "pickFile"; query: string };

export interface PanelSession {
  sessionId: string;
  running: boolean;
  blank: boolean;
  updatedAt: number;
  title?: string;
}
