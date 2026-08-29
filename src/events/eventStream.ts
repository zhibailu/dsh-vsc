import * as vscode from "vscode";

/** A session event from the mux stream (the DSH web app's own event shape). */
export interface SessionEvent {
  type: string;
  seq?: number;
  /** Unix epoch ms stamped by the harness on every durable log entry. */
  time?: number;
  data?: Record<string, unknown>;
  /**
   * Wire envelope id of a server-request frame. Answerable frames
   * (approval/requested, question/requested) must be answered by echoing
   * this rpcId via /api/respond — it lives OUTSIDE the payload, so it is
   * forwarded separately (never inside data).
   */
  rpcId?: string;
}

/**
 * M3 — WS client for the harness mux event stream (/api/events.mux).
 * Same protocol the browser frontend uses; auto-reconnects with backoff.
 */
export class HarnessEventStream implements vscode.Disposable {
  private ws: WebSocket | null = null;
  private disposed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retries = 0;

  constructor(private readonly base: string) {}

  onSessionEvent: (sessionId: string, event: SessionEvent) => void = () => {};
  onError: (message: string) => void = () => {};
  /** Fired when a (re)connection succeeds — status bar can flip back online. */
  onOpen: () => void = () => {};
  /** Fired when the connection drops — the harness may be down; host decides. */
  onDisconnect: () => void = () => {};

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;
    try {
      const url = `${this.base.replace(/^http/, "ws")}/api/events.mux`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.retries = 0;
        this.onOpen();
      };
      ws.onmessage = (msg) => this.handleFrame(msg.data);
      ws.onclose = () => {
        if (this.disposed) return;
        this.onDisconnect();
        this.scheduleReconnect();
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    } catch (error) {
      this.onError(String(error));
      this.onDisconnect();
      this.scheduleReconnect();
    }
  }

  private handleFrame(raw: unknown): void {
    let frame: { payload?: unknown; rpcId?: unknown } | null = null;
    try {
      frame = JSON.parse(String(raw)) as { payload?: unknown; rpcId?: unknown };
    } catch {
      return;
    }
    // Mux frames are ServerRequest-shaped on the wire:
    //   { type:"server-request", rpcId, method, payload:{...} }
    // Answerable frames (approval/requested, question/requested) need the
    // envelope rpcId echoed back through /api/respond — surface it alongside
    // the event so consumers can answer (never bury it in data).
    const wireRpcId = typeof frame?.rpcId === "string" && frame.rpcId.length > 0 ? frame.rpcId : undefined;
    const inner = (frame && typeof frame === "object" && "payload" in frame ? frame.payload : frame) as {
      type?: string;
      sessionId?: unknown;
      event?: SessionEvent;
      error?: unknown;
      items?: unknown;
    } | null;
    if (!inner || typeof inner !== "object") return;
    if (inner.type === "stream/error") {
      this.onError(JSON.stringify(inner.error));
      return;
    }
    if (inner.type === "session/event") {
      const sessionId = String(inner.sessionId ?? "");
      const event = inner.event;
      if (sessionId && event && typeof event.type === "string") {
        this.onSessionEvent(sessionId, { ...(event as SessionEvent), rpcId: wireRpcId });
      }
      return;
    }
    // Direct mux frames (session/queue, session/jobs, session/subscribed,
    // approval/*, question/*, ...) arrive as their own type with sessionId and
    // data fields at the top level — surface them as session events carrying
    // the frame payload, so consumers see the whole session control plane.
    if (typeof inner.type === "string" && inner.sessionId !== undefined) {
      const sessionId = String(inner.sessionId);
      if (sessionId) {
        const { sessionId: _sid, type, ...rest } = inner;
        this.onSessionEvent(sessionId, { type, data: rest as Record<string, unknown>, rpcId: wireRpcId });
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.retries++;
    const delay = Math.min(500 * 2 ** Math.min(this.retries, 5), 15000);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
  }
}
