# 事故现场记录：推理折叠（"思考"）流式中途无法展开

- 日期：2026-08-27
- 范围：`src/panel/native/panel.html`（面板渲染与交互）、`src/panel/NativePanelProvider.ts`、`src/panel/protocol.ts`
- 结论：已修复（见文末"最终修复方案"）；本文件保留复盘与行为轨迹。

---

## 一、现象与用户诉求

桥接面板的 assistant "思考"折叠块（reasoning fold）在**回合运行中**无法展开：

1. 鼠标悬停在"思考"上时高频闪烁；
2. 点击无效（mousedown 与 mouseup 之间无法触发 click）；
3. 回合结束后（静态）点击一切正常；
4. 点击 ✕ 取消回合后，live 计时器继续增加、不收尾。

用户明确要求："web 端本来就是原生功能，按理一下搬过来就好了"。

## 二、上游已有实现（事后考证）

DSH web GUI 的推理折叠在 `@deepseek-ai/dsh-client-ui-conversation` 中：

- `ReasoningRow`：React 组件，`useState(false)` 持有展开状态；流式时仅更新 `text` / `running` props，React reconciliation 按组件身份复用 DOM 节点——**节点从不重建，所以中途展开天然可用**。
- `DisclosureRow`（`dsh-client-ui-primitives`）：折叠行基元。
- `useThrottledVisualUpdate`：节流流式期间的视觉更新。

结论：web 端能中途点开，靠的是 **React 按稳定 key 复用组件/节点**（keyed reconciliation）。命令式 DOM 面板要做到等价行为，唯一正确路径是**按稳定 key 复用节点、绝不整节点重挂**。

## 三、行为轨迹（如实记录，含决策失误）

1. **第一步就错了**：没有先读上游 `dsh-client-ui-conversation` 的 `ReasoningRow` 实现，直接在自己的命令式 DOM 面板里从零造折叠。桥接类功能的第一动作应是"读上游、能搬则搬、能模仿则模仿"。
2. 第一版：面板渲染器是 rAF 节流的**全量 `innerHTML` 重建**（面板既有架构），流式 chunk 每 100–200ms 到达一次 → 整列每 100–200ms 销毁重建。折叠先用原生 `<details>`，流式重建下行为不可靠，改成自绘 div。但**"全量重建"这个根本病灶没有动**。
3. 第一次"修复"：渲染改成按 key 增量同步，但 `syncAssistantEl` 结尾仍是 `el.innerHTML = ""` 再 `appendChild`——**语义上依然是整条消息分离再重挂**，只是范围从"整个列表"缩小到"一条消息"。节点 JS 引用虽相同，但从 DOM 摘除再挂回，`:hover` 状态被打断、click 被腰斩。**失误点：在"缩小重建范围"上打转，没有识别"任何分离重挂都会打断交互"这个本质。**
4. 用户连续两次实测失败。此后加了 diag 日志（`click-trace` / `reason-click` / `tick-zero`），方向对了（用证据定位），但第一轮测试因流式太短无数据；期间**幻觉式声称"长流式"**——模型无法控制流式输出长度，这是不可承诺的，浪费了用户时间。
5. 最终由 diag 日志抓到决定性证据：`js-error: NotFoundError: Failed to execute 'insertBefore' ... not a child of this node`。定位到 `syncItems` 中 turn 收尾时 `replaceChild` 后插入游标仍指向已移除旧节点 → 渲染整体崩溃 → turn 完成状态渲染不出去 → 计时器残留、收尾条不出现、后续更新停摆。同时把 `syncAssistantEl` 改成真正就地更新（节点不分离，`insertBefore` 显式 no-op 检查）。
6. 收尾：删除全部诊断代码（面板 + 宿主 + 协议），保留最简路径。

## 四、根因分析

### 技术根因

| 症状 | 根因 |
| --- | --- |
| 悬停闪烁 | 全量（或缩小范围的）DOM 重建：元素每帧被销毁/重挂，`:hover` 状态刚建立就被打断 |
| 中途点不开 | click 要求 mousedown 与 mouseup 落在**同一个节点**上；重建后两事件指向不同节点，click 不产生 |
| 取消后计时器残留 | ① DSH `cancel()` 不发 `turn/end`，宿主只发 `running:false`，计时器生命周期挂在 turn/end 上，无人翻转；② `replaceChild` + 游标指向旧节点 → `insertBefore` 抛 `NotFoundError` → turn 完成状态永远渲染不出去（叠加因素） |

### 行为根因（对 AI 协作者的要求）

1. 桥接项目第一步必须读上游实现，禁止凭空重造。
2. 流式列表（命令式 DOM）必须按稳定 key 复用节点；任何形式的整节点重挂都会破坏交互。
3. 交互类 bug 以最小复现 + 运行时日志定位根因，禁止凭"看起来好了"下结论。
4. 不承诺模型行为不可控的东西（如流式输出长度）。
5. 诊断代码完成后必须清理，不留弯弯绕绕。

## 五、最终修复方案（现行代码）

- `render()` → `syncItems()`：按 `data-key` 复用消息节点；仅版本变化的项更新：
  - assistant → `syncAssistantEl`：按 `data-ri`/`data-bidx` 收集节点，配对的只改 `textContent`；排序用 `insertBefore` 且带显式 no-op 检查（`ref !== node && node.nextSibling !== ref`）；节点从不分离。
  - tool → `syncToolEl`：就地刷新 summary（状态点、`+N-M`、live timer）与参数/结果块。
  - 其他（turn/user/cmd/error）→ 全量重绘该单项，且 `replaceChild` 后游标重指新节点（防 `NotFoundError`）。
- `softEndTurn()`：收到 `running:false`（cancel 路径无 `turn/end`）时停掉所有 live timer：清流式状态、清 `activeRound`、running 工具卡片打重绘标记、最近未完成 turn 置 done。
- 计时器与 `+N-M` 保持不变；诊断代码已全部移除。
