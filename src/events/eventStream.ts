import * as vscode from "vscode";

/** A session event from the mux stream (the DSH web app's own event shape). */
export interface SessionEvent {
  type: string;
  seq?: number;
  data?: Record<string, unknown>;
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
      };
      ws.onmessage = (msg) => this.handleFrame(msg.data);
      ws.onclose = () => this.scheduleReconnect();
      ws.onerror = () => {
        /* onclose follows */
      };
    } catch (error) {
      this.onError(String(error));
      this.scheduleReconnect();
    }
  }

  private handleFrame(raw: unknown): void {
    let frame: { payload?: unknown } | null = null;
    try {
      frame = JSON.parse(String(raw)) as { payload?: unknown };
    } catch {
      return;
    }
    const inner = (frame && typeof frame === "object" && "payload" in frame ? frame.payload : frame) as {
      type?: string;
      sessionId?: unknown;
      event?: SessionEvent;
      error?: unknown;
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
        this.onSessionEvent(sessionId, event as SessionEvent);
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
