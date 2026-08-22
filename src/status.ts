import * as vscode from "vscode";

/** Left status bar indicator: harness state; click opens the sidebar / review. */
export class DshStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "dsh.openSidebar";
    this.item.show();
    this.setSearching();
  }

  setSearching(): void {
    this.item.text = "$(sync~spin) DSH…";
    this.item.tooltip = "DSH Bridge: probing harness…";
    this.item.command = "dsh.openSidebar";
  }

  setStarting(port: number): void {
    this.item.text = "$(sync~spin) DSH starting…";
    this.item.tooltip = `DSH Bridge: starting dsh web on :${port}`;
    this.item.command = "dsh.openSidebar";
  }

  setOnline(version: string): void {
    this.item.text = "$(vm-active) DSH";
    this.item.tooltip = `DSH Bridge: connected (harness ${version}) — click to open sidebar`;
    this.item.command = "dsh.openSidebar";
  }

  setOffline(): void {
    this.item.text = "$(vm-outline) DSH offline";
    this.item.tooltip = "DSH Bridge: no harness reachable — click to open sidebar";
    this.item.command = "dsh.openSidebar";
  }

  setChanges(count: number): void {
    this.item.text = `$(diff) DSH: ${count} 个文件改动`;
    this.item.tooltip = "DSH Bridge: agent 改动了文件 — 点击审查";
    this.item.command = "dsh.reviewChanges";
  }

  dispose(): void {
    this.item.dispose();
  }
}
