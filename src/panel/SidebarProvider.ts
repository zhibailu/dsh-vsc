import * as vscode from "vscode";
import * as fs from "node:fs";

/**
 * Sidebar webview: embeds the real DSH Web GUI in an iframe.
 * The UI is DSH's own (sessions, models, MCP tools, HMR — all identical to
 * the browser). This extension adds what the web GUI lacks: native VS Code
 * bridges (context injection, diff review, file jumps).
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "dsh.sidebar";

  private view?: vscode.WebviewView;
  private base = "http://127.0.0.1:3080";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void = () => {}
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "media")],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview, this.base);
    webviewView.webview.onDidReceiveMessage((message) => {
      const msg = message as { type?: string; what?: string; extra?: string; url?: string };
      if (msg?.type === "diag") {
        this.log(`[webview] ${msg.what}${msg.extra ? ` (${msg.extra})` : ""} url=${msg.url ?? "?"}`);
        return;
      }
      if (msg?.type === "ready") {
        this.log("[webview] shell ready");
      }
    });
  }

  /** Re-point the embedded GUI (also used before the view exists). */
  setBase(base: string): void {
    this.base = base;
    if (this.view) {
      this.view.webview.html = this.renderHtml(this.view.webview, this.base);
    }
  }

  private renderHtml(webview: vscode.Webview, base: string): string {
    const shellPath = vscode.Uri.joinPath(this.context.extensionUri, "dist", "media", "shell.html");
    try {
      let html = fs.readFileSync(shellPath.fsPath, "utf8");
      html = html
        .replaceAll("__DSH_URL__", escapeHtml(base))
        .replaceAll("__DSH_HOST__", cspHostOf(base));
      return html;
    } catch (error) {
      this.log(`[webview] shell.html read failed: ${(error as Error).message}`);
      throw error;
    }
  }
}

/**
 * CSP host-source WITHOUT port: `new URL().origin` keeps a non-default port,
 * and `host:port:*` is an INVALID CSP source (silently ignored → frame blocked).
 * Valid forms are `http://host:*` (wildcard port) or `http://host:port` (exact).
 */
function cspHostOf(base: string): string {
  try {
    const parsed = new URL(base);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return "http://127.0.0.1";
  }
}

/** Escape for HTML attribute context (URLs from config are user input). */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
