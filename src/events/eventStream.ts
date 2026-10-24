import * as vscode from "vscode";
import WebSocket from "ws";
import {
  TRANSPORT,
  type RemoteEventFrame,
  type SessionFollowFrame,
  type SessionWireHeader,
  type WorkspaceView,
} from "../harness/protocol";

/** A session event in the shape the panel already renders. */
export interface SessionEvent {
  type: string;
  seq?: number;
  /** Unix epoch ms stamped by the harness on every durable log entry. */
  time?: number;
  data?: Record<string, unknown>;
  /**
   * Correlation id for an answerable frame. 0.2.1 replaces the old envelope
   * rpcId with the forwarded-event `eventId`; the panel echoes whichever id it
   * was handed, so this field keeps its meaning.
   */
  rpcId?: string;
}

/** One forwarded waterfall the panel can answer (approval / question). */
export interface AnswerableEvent {
  eventId: string;
  event: string;
  sessionId: string;
  request: Record<string, unknown>;
}

interface LogicalStream {
  kind: "events" | "control" | "workspace" | "follow";
  sessionId?: string;
}

/** Reconnect backoff, ms. */
const backoff = (attempt: number): number => Math.min(500 * 2 ** Math.min(attempt, 5), 15000);

/**
 * WS client for the 0.2.1 Remote transport.
 *
 * ONE physical socket (`/api/remote.mux`) carries independently cancellable
 * LOGICAL streams, each addressed by a `streamId` this client mints:
 *
 *   $events                forwarded Host events + answerable waterfalls
 *   session/control        host-wide projection baseline + deltas
 *   workspace/follow       workspace rows (and the archived-session set)
 *   session/follow         ONE followed session: snapshot + durable events +
 *                          raw assistant stream frames
 *
 * Everything is normalized here into the event vocabulary the panel has always
 * rendered (`turn/start`, `tool/call`, `assistant/chunk`, `session/projection`,
 * `session/queue`, `session/title`, …), so the renderer never learns that the
 * transport changed.
 *
 * Auth: the WS handshake carries the same signed cookie as the HTTP RPC
 * (minted by `/connect?token=…&interactions=answer`).
 */
export class HarnessEventStream implements vscode.Disposable {
  private ws: WebSocket | null = null;
  private disposed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  /** streamId → what that logical stream is for. */
  private readonly streams = new Map<string, LogicalStream>();
  /** streamId of the currently followed session stream. */
  private followStreamId: string | null = null;
  private wantedSessionId: string | null = null;
  /** Latest log cut per session (what `session/page` needs as `throughSeq`). */
  private readonly cursors = new Map<string, number>();
  private readonly headers = new Map<string, SessionWireHeader>();

  /** Forwarded-event client id (needed to answer waterfalls). */
  remoteClientId?: string;

  onSessionEvent: (sessionId: string, event: SessionEvent) => void = () => {};
  /** An answerable waterfall arrived (approval/request, user-questions/request). */
  onAnswerable: (event: AnswerableEvent) => void = () => {};
  /** A previously delivered waterfall was cancelled or answered elsewhere. */
  onAnswerableSettled: (eventId: string) => void = () => {};
  /** Forwarded Host events (`api-session/added`, `api-session/status`, …). */
  onHostEvent: (event: string, args: unknown[]) => void = () => {};
  /** Workspace rows from the follow baseline. */
  onWorkspaces: (items: WorkspaceView[]) => void = () => {};
  onError: (message: string) => void = () => {};
  /** Fired when a (re)connection succeeds — status bar can flip back online. */
  onOpen: () => void = () => {};
  /** Fired when the connection drops — the harness may be down; host decides. */
  onDisconnect: () => void = () => {};

  constructor(
    private readonly base: string,
    private readonly cookie: () => string | undefined
  ) {}

  /** Log cut of a followed session (undefined until its snapshot lands). */
  cursorFor(sessionId: string): number | undefined {
    return this.cursors.get(sessionId);
  }

  /** Header (log format version, cwd, origin) of a followed session. */
  headerFor(sessionId: string): SessionWireHeader | undefined {
    return this.headers.get(sessionId);
  }

  /** Switch which session is followed; the previous follow stream is cancelled. */
  followSession(sessionId: string | null): void {
    if (sessionId === this.wantedSessionId) return;
    this.wantedSessionId = sessionId;
    this.closeFollow();
    if (sessionId && this.isOpen()) this.openFollow(sessionId);
  }

  start(): void {
    this.connect();
  }

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private wsUrl(): string {
    return `${this.base.replace(/^http/, "ws")}${TRANSPORT.remoteMuxPath}`;
  }

  private connect(): void {
    if (this.disposed) return;
    const cookie = this.cookie();
    try {
      const ws = new WebSocket(this.wsUrl(), cookie ? { headers: { cookie } } : {});
      this.ws = ws;
      ws.on("open", () => {
        this.retries = 0;
        this.streams.clear();
        this.followStreamId = null;
        // Host-wide streams first: their baselines seed every session.
        this.openStream("control", TRANSPORT.controlEndpoint, {});
        this.openStream("workspace", TRANSPORT.workspaceFollowEndpoint, {});
        this.openStream("events", TRANSPORT.eventsEndpoint, {});
        if (this.wantedSessionId) this.openFollow(this.wantedSessionId);
        this.onOpen();
      });
      ws.on("message", (data: WebSocket.RawData) => this.handleFrame(data));
      ws.on("close", () => {
        if (this.disposed) return;
        this.streams.clear();
        this.followStreamId = null;
        this.remoteClientId = undefined;
        this.onDisconnect();
        this.scheduleReconnect();
      });
      ws.on("error", (error: Error) => {
        this.onError(error.message);
        /* `close` follows */
      });
    } catch (error) {
      this.onError(String(error));
      this.onDisconnect();
      this.scheduleReconnect();
    }
  }

  private send(message: Record<string, unknown>): void {
    try {
      if (this.isOpen()) this.ws?.send(JSON.stringify(message));
    } catch (error) {
      this.onError(`send failed: ${(error as Error).message}`);
    }
  }

  private openStream(kind: LogicalStream["kind"], endpoint: string, args: Record<string, unknown>, sessionId?: string): string {
    const streamId = `${kind}-${Math.random().toString(16).slice(2, 10)}`;
    this.streams.set(streamId, { kind, sessionId });
    this.send({ type: "open", streamId, endpoint, payload: { args } });
    return streamId;
  }

  private openFollow(sessionId: string): void {
    this.followStreamId = this.openStream(
      "follow",
      TRANSPORT.sessionFollowEndpoint,
      { request: { address: { kind: "session", sessionId }, assistantStream: true } },
      sessionId
    );
  }

  private closeFollow(): void {
    if (!this.followStreamId) return;
    this.send({ type: "cancel", streamId: this.followStreamId });
    this.streams.delete(this.followStreamId);
    this.followStreamId = null;
  }

  private handleFrame(raw: WebSocket.RawData): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const kind = frame.type;
    if (kind === "error") {
      const error = frame.error as { message?: unknown } | undefined;
      this.onError(`remote stream error: ${String(error?.message ?? JSON.stringify(frame.error))}`);
      return;
    }
    if (kind === "end") {
      const streamId = String(frame.streamId ?? "");
      const logical = this.streams.get(streamId);
      if (logical?.kind === "follow") this.followStreamId = null;
      this.streams.delete(streamId);
      return;
    }
    if (kind !== "item") return;
    const logical = this.streams.get(String(frame.streamId ?? ""));
    if (!logical) return;
    const value = frame.value as Record<string, unknown> | undefined;
    if (!value) return;
    switch (logical.kind) {
      case "events":
        this.handleForwardedEvent(value);
        return;
      case "control":
        this.handleControlFrame(value);
        return;
      case "workspace":
        this.handleWorkspaceFrame(value);
        return;
      case "follow":
        this.handleFollowFrame(logical.sessionId ?? "", value);
        return;
    }
  }

  /* ------------------------------------------------ forwarded Host events */

  private handleForwardedEvent(value: Record<string, unknown>): void {
    const type = value.type;
    if (type === "ready") {
      this.remoteClientId = typeof value.clientId === "string" ? value.clientId : undefined;
      return;
    }
    if (type === "emit") {
      const event = String(value.event ?? "");
      const args = Array.isArray(value.args) ? value.args : [];
      if (event) this.onHostEvent(event, args);
      return;
    }
    if (type === "cancel") {
      const eventId = String(value.eventId ?? "");
      if (eventId) this.onAnswerableSettled(eventId);
      return;
    }
    if (type === "waterfall") {
      const event = String(value.event ?? "");
      const eventId = String(value.eventId ?? "");
      const request = (value.request ?? {}) as Record<string, unknown>;
      const sessionId = String(request.sessionId ?? value.agentId ?? "");
      if (event && eventId) this.onAnswerable({ eventId, event, sessionId, request });
    }
  }

  /* --------------------------------------------------- session/control */

  private handleControlFrame(value: Record<string, unknown>): void {
    if (value.type === "baseline") {
      const projections = (value.value as { projections?: Record<string, Record<string, unknown>> } | undefined)?.projections;
      if (!projections) return;
      for (const [sessionId, baseline] of Object.entries(projections)) {
        const cut = typeof baseline.asOfSeq === "number" ? baseline.asOfSeq : undefined;
        if (cut !== undefined) this.cursors.set(sessionId, cut);
        const values = (baseline.values ?? {}) as Record<string, unknown>;
        for (const [key, unit] of Object.entries(values)) this.emitProjection(sessionId, key, unit);
      }
      return;
    }
    if (value.type === "projection") {
      const sessionId = String(value.sessionId ?? "");
      const key = String(value.key ?? "");
      if (!sessionId || !key) return;
      if (typeof value.seq === "number") this.cursors.set(sessionId, value.seq);
      this.emitProjection(sessionId, key, value.value);
    }
  }

  /** Normalize one projection unit into the panel's own event vocabulary. */
  private emitProjection(sessionId: string, key: string, unit: unknown): void {
    if (key === "title") {
      const title = typeof unit === "string" ? unit : undefined;
      if (title !== undefined) this.onSessionEvent(sessionId, { type: "session/title", data: { title } });
      return;
    }
    if (key === "inbox") {
      // 0.2.1 publishes the pending queue as a projection; the panel still
      // renders `session/queue` rows, so map it back to that shape.
      const inbox = (unit ?? {}) as { "next-turn"?: unknown[]; "next-step"?: unknown[] };
      const rows = [...(Array.isArray(inbox["next-turn"]) ? inbox["next-turn"] : []), ...(Array.isArray(inbox["next-step"]) ? inbox["next-step"] : [])];
      this.onSessionEvent(sessionId, {
        type: "session/queue",
        data: { items: rows.map((row) => ({ id: (row as { id?: unknown }).id, placement: "queued", message: { content: (row as { content?: unknown }).content } })) },
      });
      return;
    }
    this.onSessionEvent(sessionId, { type: "session/projection", data: { key, value: unit } });
  }

  /* -------------------------------------------------- workspace/follow */

  private handleWorkspaceFrame(value: Record<string, unknown>): void {
    if (value.type !== "baseline") {
      // `upsert` / archive changes: the session list and the archived set can
      // both move, so the host re-reads them (cheap) rather than modelling the
      // frame here.
      this.onHostEvent("workspace/changed", [value]);
      return;
    }
    const items = (value.value as { items?: WorkspaceView[] } | undefined)?.items;
    if (Array.isArray(items)) this.onWorkspaces(items);
  }

  /* --------------------------------------------------- session/follow */

  private handleFollowFrame(sessionId: string, value: Record<string, unknown>): void {
    const type = value.type;
    if (type === "snapshot") {
      const cursor = typeof value.cursor === "number" ? value.cursor : undefined;
      if (cursor !== undefined) this.cursors.set(sessionId, cursor);
      const header = value.header as SessionWireHeader | undefined;
      if (header) this.headers.set(sessionId, header);
      // The snapshot's records are NOT replayed as live events: the provider
      // renders history from session/page so paging stays identical to 0.1.x.
      // Only the projection block is pushed through, so the header selects and
      // the task bar are correct before the first history page arrives.
      const projections = (value.projections as { values?: Record<string, unknown> } | undefined)?.values;
      if (projections) {
        for (const [key, unit] of Object.entries(projections)) this.emitProjection(sessionId, key, unit);
      }
      return;
    }
    if (type === "event") {
      const event = value.event as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown; surfaceOp?: unknown } | undefined;
      if (!event || typeof event.type !== "string") return;
      if (typeof event.seq === "number") this.cursors.set(sessionId, event.seq);
      this.onSessionEvent(sessionId, {
        type: event.type,
        seq: typeof event.seq === "number" ? event.seq : undefined,
        time: typeof event.time === "number" ? event.time : undefined,
        data: (event.data ?? {}) as Record<string, unknown>,
        surfaceOp: event.surfaceOp as never,
      } as SessionEvent & { surfaceOp?: unknown });
      return;
    }
    if (type === "assistant-stream") {
      const frame = value.frame as { type?: unknown; time?: unknown; chunk?: unknown } | undefined;
      if (!frame || frame.type !== "chunk") return; // start/end carry no panel-visible text
      this.onSessionEvent(sessionId, {
        type: "assistant/chunk",
        time: typeof frame.time === "number" ? frame.time : Date.now(),
        data: { chunk: frame.chunk },
      });
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.retries++;
    this.retryTimer = setTimeout(() => this.connect(), backoff(this.retries));
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
    this.streams.clear();
  }
}
