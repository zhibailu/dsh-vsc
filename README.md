# DSH Bridge (dsh-vsc)

在 VS Code 侧边栏里用 DeepSeek Harness（DSH）干活：嵌入真实 Web GUI + 原生编辑器桥（选区提问、改动审查、文件跳转）。

## 安装（推荐：下载 Release 安装包）

需要：Windows / macOS / Linux + VS Code。

1. 打开 [Releases](https://github.com/zhibailu/dsh-vsc/releases)，下载最新的 `dsh-vsc-<版本号>.vsix`
2. 安装（VS Code 里 Ctrl+Shift+P → **Install from VSIX**，或命令行）：

```bash
code --install-extension dsh-vsc-0.1.0.vsix --force
```

3. 重载窗口（Ctrl+Shift+P → **Reload Window**），左侧活动栏点 **DSH** 图标即可使用

> dsh（harness 本体）不用单独装：扩展发现没有 harness 在跑时，会自动拉起一个（`npm i -g @deepseek-ai/dsh` 或 `npx @deepseek-ai/dsh web` 跑着的会被直接复用，默认 `http://127.0.0.1:3080`，可用 `DSH_WEB_URL` 或设置 `dshVsc.url` 覆盖）。

## 从源码构建（开发者 / 想改代码时）

```bash
git clone https://github.com/zhibailu/dsh-vsc.git
cd dsh-vsc
npm install
npm run package     # esbuild 构建 + vsce 打包，产出 dsh-vsc-<版本号>.vsix
code --install-extension dsh-vsc-0.1.0.vsix --force
```

## 使用

1. **重载窗口**（Ctrl+Shift+P → Reload Window）——装完必须重载才生效
2. 左侧活动栏点 **DSH** 图标打开侧边栏
3. 没有 harness 在跑时，扩展会自动静默拉起一个（窗口不弹出）；已有则直接复用
4. 发消息，看 agent 干活

**API key 不用在扩展里配**：key 在 dsh 侧配置（第一次 `dsh web` 时按提示设置）。扩展是 harness 的共享客户端，不碰你的 key。

## 截图

**① 侧边栏概览** —— 左侧活动栏 DSH 图标打开原生侧边栏面板

<img src="docs/screenshots/sidebar.png" width="210" alt="侧边栏概览" />

**② 对话与工具动作** —— 流式回复、思考折叠、「⚙ 动作」相邻工具合并块、每轮实时计时（上 / 下两张）

| 上 | 下 |
|---|---|
| <img src="docs/screenshots/chat0.png" width="205" alt="对话（上）" /> | <img src="docs/screenshots/chat1.png" width="205" alt="对话（下）" /> |

**③ 编辑器右键 Ask DSH** —— 选中代码后右键 → 菜单底部 "DSH: Ask about selection"

<img src="docs/screenshots/ask-menu.png" width="300" alt="右键 Ask DSH" />

## 功能

- 侧边栏内嵌真实 DSH Web GUI（会话、模型、MCP 工具、热更新与浏览器一致）
- 原生桥：
  - **Ask DSH（选区）**：编辑器选中代码 → 右键 → **面板内弹出 Ask 卡片**（解释 / 审查 / 修复 / 自定义），结构化上下文（文件/选区/工作区/分支）送入最新会话
  - **Review Agent Changes**：监控 `write`/`edit`/`str_replace_editor` 工具调用，回合结束提示改动数，一键打开 VS Code 原生 git diff
- 原生侧边栏面板：
  - 每轮实时计时、相邻工具动作合并成「⚙ 动作」折叠块、思考（reasoning）折叠、`+N-M` 改动统计
  - **审批卡片**：agent 请求执行需审批的操作 → 面板弹出审批卡片 → 允许一次 / 拒绝
  - **选择题卡片**：agent 调用提问工具 → 面板弹出选择题（单选序号 / 多选勾选 / 推荐徽章 / 自定义回答 ↑↓ 找回 / 跳过），回答经 `/api/respond` 回传
  - **推理等级切换**：header 模型选择器旁的下拉（随模型刷新）
  - **权限预设切换**：header 下拉，实时拉取 `agentPreset.list` 实际可用预设
  - 提问时**主输入栏整体隐藏**（composer takeover），防止误发消息

## 边界

- 不重写聊天 UI（嵌入真实前端）；不截断/白名单事件；不要求重输 API key
- 不另起第二个 harness（发现到运行中的就复用，只有没有才自拉；关 VS Code 时若还有其他客户端连着，自拉实例会保留）
- 改动追踪只识别 `write`/`edit`/`str_replace_editor` 工具事件；shell 里改文件不计入（git diff 审查仍可手工用）
- `+N-M` 统计同样只覆盖上述文件工具；`write` 的旧内容为调用瞬间磁盘估算，工具结果自带的 `meta.diffs` 会修正
- 计时器是桥接侧纯展示：只挂最新进行中的一轮，任务结束即固化为历史用时
- Ask DSH 发送到"最近更新的会话"（非空白），不看 webview 当前打开哪个会话
- 审批/选择题只在**当前选中会话**弹出（其他会话的交互帧不打扰当前视图）

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → dist/extension.js + dist/media
npm run package     # 打包 vsix
```

F5 调试（`.vscode/launch.json`）→ Extension Development Host。

自动回归测试（jsdom 模拟 webview，喂真实事件流验证面板渲染）：

```bash
node scratch/auto-test.mjs <sessionId> <turnNo>
```

## 许可证

MIT © 2026 zhibailu — 详见 [LICENSE](LICENSE)。
