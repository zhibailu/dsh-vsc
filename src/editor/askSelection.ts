import * as vscode from "vscode";
import type { HarnessClient } from "../harness/client";
import { currentEditorContext, formatEditorContext } from "./context";

const INTENT_CHOICES = [
  { label: "解释", detail: "解释这段代码在做什么、为什么这么写" },
  { label: "代码审查", detail: "审查这段代码的问题与改进点" },
  { label: "修复/改进", detail: "让 agent 直接修改这段代码" },
  { label: "自定义…", detail: "自己输入指令" },
];

const SELECTION_CAP = 4000;

/**
 * M2 — the native context bridge.
 * Right-click a selection → "DSH: Ask about selection" → a structured
 * context block (file / lines / excerpt) is queued into the latest session.
 * The agent reads the rest of the file itself with its fs tools.
 */
export async function askSelection(getClient: () => HarnessClient | null): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showWarningMessage("DSH: 请先在编辑器里选中要询问的代码。");
    return;
  }

  const client = getClient();
  if (!client) {
    const choice = await vscode.window.showWarningMessage("DSH: harness 未连接。", "启动 harness");
    if (choice === "启动 harness") {
      void vscode.commands.executeCommand("dsh.start");
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(INTENT_CHOICES, {
    placeHolder: "要 agent 对这个选区做什么？",
  });
  if (!picked) return;

  let instruction: string;
  if (picked.label === "自定义…") {
    const input = await vscode.window.showInputBox({
      prompt: "指令",
      placeHolder: "例如：这段代码有什么 bug？怎么修？",
    });
    if (input === undefined) return;
    instruction = input.trim();
    if (!instruction) return;
  } else {
    instruction = picked.label;
  }

  try {
    const ctx = await currentEditorContext();
    const block = formatEditorContext(ctx, SELECTION_CAP);
    const message = `${block}\n\n----\n指令：${instruction}`;

    const sessionId = await targetSession(client);
    await client.prompt(sessionId, [{ type: "text", text: message }], "queue");

    const short = sessionId.replace(/^session-/, "").slice(0, 8);
    void vscode.window.showInformationMessage(`DSH: 已排队发送到会话 ${short}（${instruction}）。`);
    void vscode.commands.executeCommand("dsh.sidebar.focus");
  } catch (error) {
    void vscode.window.showErrorMessage(`DSH: 发送失败 — ${(error as Error).message}`);
  }
}

/** Pick the most recently updated non-blank session; create one if none exists. */
async function targetSession(client: HarnessClient): Promise<string> {
  const { items } = await client.listSessions();
  const usable = items.filter((item) => !item.blank);
  if (usable.length > 0) {
    usable.sort((a, b) => b.updatedAt - a.updatedAt);
    return usable[0].sessionId;
  }
  const created = await client.call<{ sessionId: string }>("session.create", {});
  return created.sessionId;
}
