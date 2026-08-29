# src/events — 事件流客户端

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（源码） |
| **为谁负责** | 扩展与 harness 的实时事件通道 |
| **行为边界** | 只放事件流（WS `/api/events.mux`）相关代码 |

## 放这里 ✅

- `eventStream.ts` — HarnessEventStream（连接 / 重连 / 事件分发）

## 不放这里 ❌

- HTTP JSON-RPC 客户端 → `../harness/client.ts`；启动器 → `../harness/launcher.ts`
