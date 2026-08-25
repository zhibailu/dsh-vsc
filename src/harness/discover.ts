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
 * The default is 3081 — the extension's OWN instance, started and stopped
 * with VS Code. The browser GUI's web harness typically lives on 3080 and is
 * never touched. Point dshVsc.url at an existing harness (e.g. 3080) to use
 * it in shared mode: the extension then only connects and never kills it.
 */
export function configuredBase(): string {
  const fromConfig = vscode.workspace.getConfiguration("dshVsc").get<string>("url");
  const fromEnv = process.env.DSH_WEB_URL;
  return (fromConfig?.trim() || fromEnv?.trim() || "http://127.0.0.1:3081").replace(/\/+$/, "");
}

/** Port implied by a base URL (default 3081). */
export function portOf(base: string): number {
  try {
    const parsed = new URL(base);
    return parsed.port ? Number(parsed.port) : 3081;
  } catch {
    return 3081;
  }
}

/** Probe the configured harness. */
export async function discover(): Promise<DiscoveryResult> {
  const base = configuredBase();
  const port = portOf(base);
  const desc = await new HarnessClient(base).isAlive();
  return desc
    ? { base, alive: true, version: desc.version, port }
    : { base, alive: false, port };
}
