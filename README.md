# DSH Bridge (dsh-vsc)

DeepSeek Harness 的 VS Code 侧边栏 + 原生桥。

## 它是什么

- 侧边栏内嵌**真实的 DSH Web GUI**（iframe 指向运行中的 harness，能力与浏览器一致：会话、模型、MCP 工具、HMR 热更新）
- 扩展宿主是 harness 的**第二个客户端**：通过 `POST /api/<method>`（JSON-RPC 信封）与 WebSocket 事件流直连宿主，**不依赖 DSH 内部包，不需要重输 API key**
- 原生桥：
  - **Ask DSH (selection)**：编辑器右键 → 选"解释/审查/修复/自定义" → 结构化上下文（文件/选区/工作区/分支）排队送入最新会话
  - **Review Agent Changes**：监控 mux 事件流里的 `write`/`edit`/`str_replace_editor` 工具调用，turn 结束后状态栏提示改动数，一键打开 VS Code 原生 git diff（HEAD vs 工作区）

## 要求

- 已全局安装 `@deepseek-ai/dsh`（`dsh web` 在 PATH 上）
- 或者已有一个运行中的 harness（默认探测 `http://127.0.0.1:3080`，可用 `DSH_WEB_URL` 或设置 `dshVsc.url` 覆盖）

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → dist/extension.js + dist/media
npm run package     # 打包 vsix
```

F5 调试（.vscode/launch.json）→ Extension Development Host。

## 安装

```bash
code --install-extension dsh-vsc-0.1.0.vsix
```

## 边界（诚实版）

- 不重写聊天 UI（嵌入真实前端）；不截断/白名单事件；不要求重新输入 API key；不另起第二个 harness（发现不到才启动）
- Webview 视图隐藏时会重建，DSH 前端自带重连，会自动恢复
- 改动追踪只识别 `write`/`edit`/`str_replace_editor` 工具事件；agent 用 `bash` 之类的 shell 改文件不会被标记（git diff 审查仍可手工用）
- Ask DSH 发送到"最近更新的会话"（非空白），不会读 webview 里当前打开的是哪个会话
