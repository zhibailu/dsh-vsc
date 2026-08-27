# 事故现场记录：工具动作分组（「⚙ 动作」大块）

- 日期：2026-08-27
- 范围：`src/panel/native/panel.html`（分组渲染、计时器清理）、`src/panel/NativePanelProvider.ts`、`src/panel/protocol.ts`
- 结论：已修复并清理（最终方案见文末）

---

## 一、现象与用户诉求

把"一串连续的内部工具动作"（read / edit / pwsh / grep…）合并进一个**两级折叠大块**：

1. 大块默认折叠，点开看到每个工具一行，再点开才看参数/结果；
2. 大块标题要**实时显示当前最新那个动作的描述**（如 `⚙ 动作 · 4 · pwsh : $f = …`），折叠时就能看出在干什么；
3. 工具行摘要要显示"做了什么"（读哪个文件、执行什么命令），路径取尾部、过长省略；
4. 合并语义（用户原话）：**"如果下个执行依然是动作那就合并"**——同一回合的连续工具执行归一组，不管中间有没有思考/过渡文本。

## 二、行为轨迹（如实记录，含全部失败尝试）

1. **第一次（连续 item 分组）**：按"相邻 item 类型"分组（`prevKind === "tool"` 才同组）。结果：agent 每次工具调用前都有 reasoning（思考）消息 → DSH 事件流里工具之间夹着 assistant item → 分组被拆碎 → 用户看到一片"动作·1"。
2. **第二次（加 60 秒间隔）**：为了"细分"大回合，加了 60 秒时间阈值。结果：模型两次工具调用之间常有 >60s 的 LLM 思考 → 同回合动作又被拆碎 → **背弃合并初衷**（用户："你连着四个动作-1，那合并什么了"）。
3. **第三次（按 turn 分组，正确方向）**：组容器 key = `"gt"+turn`。但渲染循环里 `delete byKey[p.key]` 把组容器 key 从复用索引删除 → plan 中同 key 的第二个组（被思考消息拆开的同回合）找不到原容器 → **每个 plan 项都新建容器** → 同 key 空组暴涨（诊断：groupsTotal 20→34→48）、每容器只装 1 个工具。
4. **第四次（容器位置固化）**：修了重复创建（handledGroups），但组容器"复用后不再定位" → 容器位置固化在首次插入处 → 动作栏出现在 turn-end 收尾条之后、任务一开始就有 → 用户："第 58 轮完成后面依然有大量的动作栏"。
5. **最终正确**：`handledGroups`（本轮同 key 只建一次）+ `placedGroups`（每轮渲染在**第一个 plan 项**处定位一次，后续同 key 项共享不移动）+ 组内卡片**复用不动、新建追加**（顺序 = plan 顺序）。诊断数据（groupsTotal 稳定 5、emptyGroups 空、turnFreq 每组 4-5）确认正确。

### 同期连环 bug（计时器残留，已一并修复）

- **`tool/result` callId 类型**：`tool/call` 存字符串，`tool/result` 的 `toolCallId` 可能是数字，严格相等匹配失败 → 卡片永远"running" → 计时器永不停止。修复：`findTool` 统一 `String()` 比较 + `turn/end` 兜底把所有 running 工具强制收为 ok。
- **渲染冻结卡死**：运行中用户滚动历史后 `suspended` 冻结，回合结束（`running:false`）的清理渲染也被吞掉 → 计时器残留。修复：`running:false`、`turn/start`、`turn/end` 解除冻结。
- **byKey 收集选择器**：工具卡片实际是"外层带 key 的 div 包 `<details class="tool">`"，收集若用 `.tool` 会拿到无 key 的 details → 永远匹配不上 → 每次渲染新建卡片 → 无限堆积（"100 个工具"）。修复：收集 `[data-key]`（外层 div）。
- **止血兜底**：`!state.running` 时 tickLive 直接清除 DOM 里所有残留 `.live-timer`。

## 三、根因总结

1. **语义先于实现**：分组语义是"同回合的连续执行"（用户自检逻辑），不是"相邻 item"，也不是时间窗口。实现前必须先确认语义。
2. **keyed DOM 同步的陷阱**：
   - `byKey` 的 `delete` 时机错误会破坏"同 key 多 plan 项"的复用（第三次事故）；
   - 容器/节点的"位置"必须跟随数据顺序，不能固化（第四次事故）；
   - 收集索引必须匹配实际 key 所在节点（外层 div，不是内部 details）。
3. **用日志/诊断定位**：三次"看起来修好"都是表象修复；最终靠 `group-v3` 诊断（groupsTotal、turnFreq、emptyGroups）拿到确切数字才锁定 `delete byKey`。

## 四、最终方案（现行代码，已剪枝）

- **plan 构建**：`state.items` → 显示计划；同一 `turn` 的所有工具归一个组（`"gt"+turn`），其余消息单条。
- **组容器**：`handledGroups` 防同 key 重复创建；`placedGroups` 保证每轮渲染在第一个 plan 项处定位一次；同 key 后续项共享、不移动。
- **组内卡片**：复用不动（保留用户展开状态）、新建追加（顺序 = plan 顺序）；冻结（历史轮次）不参与增量更新。
- **顶层摘要**：`updateGroupTitle` 取组内最后一个工具的摘要行（`⚙ 动作 · N · <最新动作> : <摘要>`），运行中跟随最新动作。
- **工具行摘要**：`toolSummaryText` 按参数名提取（`file_path`/`path`/`command`/`pattern`…），`shortPath` 取路径尾部。
- **计时器清理**：`turn/end` 兜底 + `softEndTurn`（cancel 无 turn/end）+ `tickLive` 止血 + `findTool` String 化。
- **渲染防呆**：`syncItems` 与每个 plan 项各自 try/catch，单项失败不拖垮面板。
- 所有诊断代码（diag 上报、宿主 diagLog、协议 diag 类型）已删除。

## 五、教训（对 AI 协作者）

1. 用户明确给出语义时（"下个执行依然是动作就合并"），按语义实现，不要自己发明时间窗口/相邻性规则。
2. keyed DOM 同步：明确"每个节点/容器的生命周期"——创建一次、位置跟随数据、key 的 delete 时机。
3. 收集索引必须与实际 DOM 结构（外层包装节点）一致。
4. 每次"修好"后用诊断数据验证（组数、重复、缺失），不要凭视觉印象。
