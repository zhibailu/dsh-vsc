# dsh-vsc 最终形态规划（v2，用户拍板）

## 方向
- 不复制 Codex；桥接成果（协议层/发现/自启动/事件流）保留
- 目标：VS Code 原生感 + 人机协作优化
- 不修改 DSH 智能体/agent 逻辑（远期探明 DSH 组成后再议，如"事终总结"）

## 已确认的技术事实
- 复制按钮失效根因：VS Code 拦截 webview 跨源 iframe 的剪贴板 API（microsoft/vscode#182642）→ 原生 GUI 绕开；若保留嵌入需剪贴板桥
- `@`/`/` 输入是 DSH 原生（ui-input-trigger + ui-skill/ui-reference）→ 原生面板镜像该交互
- 嵌入 webview 不稳定（选择题点击失效、崩溃实录）→ 支持原生路线
- **dsh web 无 daemon/服务模式**（CLI 只有 `--host/--port/--trusted-host/--no-open`）→ 服务生命周期由扩展托管（detached spawn + 自愈）
- **DSH 自带配置通道**（wire 协议）：`settings.describe/update/replace/mutate/openDocument`（分层值 base/user + revision 乐观并发 + `applies: live|restart` 热生效提示）、`credentials.describe/set/unset`（密钥专用，不进明文 yml）、`agentPreset.*`、`llm.*`

## 架构原则：桥接为主，配置只走官方通道
- **运行时 = 纯桥接**：session/事件/审批/文件/差异——不写任何 DSH 配置
- **要改 DSH 配置（模型/agent/MCP/设置）→ 只调 wire 的 `settings.`/`credentials.`/`agentPreset.` RPC**：有 schema 校验、有 revision 防互相覆盖、改完 DSH 自己决定 live 热生效还是提示重启
- **绝不手写/改写 profile YAML**（用户手写层 `cordis.patch.yml` 只读；本扩展不拥有任何配置文件）。唯一例外：修 DSH 自身 bug 且经用户同意（如 GITHUB_TOKEN 加固）
- **防重复加载的唯一纪律：单 harness 实例**。discovery-first——端口上有活着的 DSH 就复用，绝不双开；配置写入前先 `settings.describe` 查重，幂等 add，`expectedRevision` 保证不覆盖
- 扩展的 webview 与 DSH 自带 UI 是"两个入口"而非重复资源；原生面板为主，embed 不进主路径

## 服务生命周期（自愈，2025-06 落地）
- 激活时探测配置端口：活着 → 复用连接；死了且 `dshVsc.autoStart` → detached 隐藏拉起 `dsh web --no-open`
- 事件流断开 → 3s 宽限后复探 → 真宕机则重新拉起（退避 2/4/8/16/30s）；连续 3 次拉起失败 → 本次会话停止自动重试，命令手动恢复
- 关 VS Code 不杀服务（共享服务，浏览器 GUI 继续用）；`dsh: Stop` 只停扩展拉起的实例并记住"别自动拉起"，重载/`dsh: Start` 后恢复
- 慢轮询 15s 兜底：用户手动起了服务也能被自动接上

## 架构：原生侧边栏面板（主界面）
- 原生渲染对话：消息/工具调用/折叠，VS Code 主题，注意力设计（不照搬网页样式）
- 输入框：`@` 文件/引用选择（镜像 DSH 原生交互）+ 右键选区 Ask
- 输入框上方：agent 提问/审批内嵌区（通知式文字重排，**不弹独立窗口**）
- 嵌入的 DSH 网页 → 降级为可选"高级视图"tab（保留，不进主路径）
- 状态栏/事件流驱动：运行中工具、停止按钮、token 状态

## 协作层
- 改动审查：agent 动手前快照 → 逐文件"接受/拒绝"（拒绝即还原，覆盖新文件，不依赖 git HEAD）
- 事件流监控：write/edit 工具调用 → 状态栏提示 → 一键审查

## 阶段（依赖调整后的实际顺序）
1. **Phase 1 原生面板骨架**：对话渲染 + 输入框 + 事件流接线（= GUI 重做第一步，内嵌问答的地基）
2. **Phase 2 内嵌问答/审批**：输入框上方问答区，respond API 回复
3. **Phase 3 快照改动审查**：snapshot + 逐文件 accept/reject
4. **Phase 4 打磨**：折叠/注意力/主题/剪贴板桥/状态栏细节/`@` 输入

## 不做（现在）
- 不动 DSH 智能体/agent 逻辑
- 不复制 Codex 功能清单
- 不维护嵌入版为日常主界面
