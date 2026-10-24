import * as vscode from "vscode";
import { HarnessClient } from "./client";

export interface DiscoveryResult {
  base: string;
  alive: boolean;
  version?: string;
  port: number;
}

/**
 * Resolve the harness base URL: user config → DSH_WEB_URL → default.
 * The default is 3080 — the web GUI's harness: the extension connects as a
 * SHARED client and never starts or kills it. If nothing answers at the
 * configured URL, the lifecycle loop auto-starts the extension's own instance
 * on that same port (see extension.ts ensureRunning) and records it in
 * %TEMP%\dsh-vsc-harness.pid.
 *
 * 0.2.1 note: `host.describe` no longer exists, so discovery is a bare
 * liveness probe — any HTTP answer (including the auth 401) means a harness is
 * listening. The version string is therefore unknown and left undefined.
 */
export function configuredBase(): string {
  const fromConfig = vscode.workspace.getConfiguration("dshVsc").get<string>("url");
  const fromEnv = process.env.DSH_WEB_URL;
  return (fromConfig?.trim() || fromEnv?.trim() || "http://127.0.0.1:3080").replace(/\/+$/, "");
}

/** Port implied by a base URL (default 3080). */
export function portOf(base: string): number {
  try {
    const parsed = new URL(base);
    return parsed.port ? Number(parsed.port) : 3080;
  } catch {
    return 3080;
  }
}

/** Probe the configured harness. */
export async function discover(): Promise<DiscoveryResult> {
  const base = configuredBase();
  const port = portOf(base);
  const alive = await new HarnessClient(base).isAlive();
  return { base, alive, port };
}
