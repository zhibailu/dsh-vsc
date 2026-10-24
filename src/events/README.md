# src/events — 事件流客户端

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（源码） |
| **为谁负责** | 扩展与 harness 的实时事件通道 |
| **行为边界** | 只放事件流（WS `/api/remote.mux` 上的逻辑流）相关代码 |

## 放这里 ✅

- `eventStream.ts` — HarnessEventStream（一条物理 WS + 四条逻辑流：`session/follow`、`session/control`、`workspace/follow`、`$events`；连接 / 重连 / 归一化分发）
- 0.2.1 起这里还负责**归一化**：把 follow 的 `event`/`assistant-stream` 帧、control 的投影帧、`$events` 的 emit/waterfall 帧，转成面板一直认识的 `PanelEvent` 形状（`turn/start`、`tool/call`、`assistant/chunk`、`session/projection`、`session/queue`…），所以 `panel.html` 不需要知道传输层换过代。

## 不放这里 ❌

- HTTP JSON-RPC 客户端 → `../harness/client.ts`；启动器 → `../harness/launcher.ts`
