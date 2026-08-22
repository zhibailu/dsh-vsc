import * as vscode from "vscode";
import * as fs from "node:fs";

/**
 * Embed shell rendering for the optional "advanced web view" (dsh.openWebView).
 * The shell iframe-loads the real DSH Web GUI; CSP host must be port-less
 * (`http://host:*` — `host:port:*` is an INVALID CSP source, silently ignored).
 */
export function renderEmbedHtml(
  webview: vscode.Webview,
  base: string,
  context: vscode.ExtensionContext
): string {
  const shellPath = vscode.Uri.joinPath(context.extensionUri, "dist", "media", "shell.html");
  let html = fs.readFileSync(shellPath.fsPath, "utf8");
  html = html
    .replaceAll("__DSH_URL__", escapeHtml(base))
    .replaceAll("__DSH_HOST__", cspHostOf(base));
  return html;
}

function cspHostOf(base: string): string {
  try {
    const parsed = new URL(base);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return "http://127.0.0.1";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
