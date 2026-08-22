import * as vscode from "vscode";
import { execFile } from "node:child_process";

/** Snapshot of what the user is looking at, for context injection. */
export interface EditorContext {
  file?: string;
  language?: string;
  selection?: {
    startLine: number;
    endLine: number;
    text: string;
  };
  workspace?: string;
  branch?: string;
}

export async function currentEditorContext(): Promise<EditorContext> {
  const editor = vscode.window.activeTextEditor;
  const ctx: EditorContext = {};
  if (editor) {
    ctx.file = editor.document.uri.fsPath;
    ctx.language = editor.document.languageId;
    const sel = editor.selection;
    if (!sel.isEmpty) {
      ctx.selection = {
        startLine: sel.start.line + 1,
        endLine: sel.end.line + 1,
        text: editor.document.getText(sel),
      };
    }
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    ctx.workspace = folder.uri.fsPath;
    ctx.branch = await gitBranch(folder.uri.fsPath);
  }
  return ctx;
}

/** Format the snapshot as a compact, agent-readable context block. */
export function formatEditorContext(ctx: EditorContext, maxChars = 4000): string {
  const lines: string[] = [];
  lines.push("[VS Code 编辑器上下文]");
  if (ctx.file) lines.push(`文件: ${ctx.file}`);
  if (ctx.language) lines.push(`语言: ${ctx.language}`);
  if (ctx.selection) lines.push(`选区: 第 ${ctx.selection.startLine}-${ctx.selection.endLine} 行`);
  if (ctx.workspace) lines.push(`工作区: ${ctx.workspace}${ctx.branch ? `（分支 ${ctx.branch}）` : ""}`);
  lines.push("----");
  if (ctx.selection) {
    let text = ctx.selection.text;
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n…（截断，共 ${ctx.selection.text.length} 字符）`;
    }
    lines.push(text);
  } else if (ctx.file) {
    lines.push("（无选区，仅文件上下文）");
  }
  return lines.join("\n");
}

function gitBranch(folder: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", folder, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: 3000, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined)
    );
  });
}
