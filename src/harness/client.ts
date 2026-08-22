import { randomUUID } from "node:crypto";
import { METHODS, type ClientRequest, type ServerResponse, type RpcError, type HostDescription, type PromptContentPart, type SessionSummary } from "./protocol";

/** A business-level RPC failure (result.ok === false). */
export class RpcErrorResult extends Error {
  constructor(public readonly rpcError: RpcError) {
    super(`${rpcError.code}: ${rpcError.message}`);
    this.name = "RpcErrorResult";
  }
}

/**
 * Thin RPC client for a running DSH web harness.
 * Implements the same protocol the browser frontend uses — no DSH-internal
 * packages, ~80 lines, works from any Node ≥ 18 host (fetch is global).
 */
export class HarnessClient {
  constructor(public readonly base: string) {}

  async call<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const request: ClientRequest = {
      type: "client-request",
      rpcId: randomUUID(),
      method,
      payload,
    };
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      throw new Error(`dsh api ${method}: transport failed (${(error as Error).message})`);
    }
    if (!res.ok) throw new Error(`dsh api ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as ServerResponse;
    if (!body.result.ok) throw new RpcErrorResult(body.result.error);
    return body.result.value as T;
  }

  describe(signal?: AbortSignal): Promise<HostDescription> {
    return this.call<HostDescription>(METHODS.hostDescribe, {}, signal);
  }

  listSessions(signal?: AbortSignal): Promise<{ items: SessionSummary[] }> {
    return this.call<{ items: SessionSummary[] }>(METHODS.sessionList, {}, signal);
  }

  prompt(sessionId: string, content: PromptContentPart[], mode: "queue" | "steer" = "queue"): Promise<{ accepted: true }> {
    return this.call<{ accepted: true }>(METHODS.sessionPrompt, { sessionId, mode, content });
  }

  /** One history page: raw events + hasMore. */
  history(
    sessionId: string,
    beforeSeq?: number,
    maxMessages = 30,
    signal?: AbortSignal
  ): Promise<{ events: { event: SessionEventLike }[]; hasMore: boolean }> {
    return this.call<{ events: { event: SessionEventLike }[]; hasMore: boolean }>(
      METHODS.sessionHistory,
      { sessionId, beforeSeq, maxMessages },
      signal
    );
  }

  createSession(): Promise<{ sessionId: string }> {
    return this.call<{ sessionId: string }>(METHODS.sessionCreate, {});
  }

  cancel(sessionId: string): Promise<{ accepted: true }> {
    return this.call<{ accepted: true }>(METHODS.sessionCancel, { sessionId });
  }

  /** Cheap liveness probe: host.describe within a timeout. */
  async isAlive(timeoutMs = 1500): Promise<HostDescription | null> {
    try {
      return await this.describe(AbortSignal.timeout(timeoutMs));
    } catch {
      return null;
    }
  }
}

/** Minimal session-event shape (wire passthrough). */
export interface SessionEventLike {
  type: string;
  seq?: number;
  data?: Record<string, unknown>;
  surfaceOp?: string;
}
