# src/harness — harness 连接与生命周期

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（源码） |
| **为谁负责** | 扩展与 dsh harness 的一切连接/生命周期 |
| **行为边界** | 只放 harness 侧：客户端、发现、启动、协议 |

## 放这里 ✅

- `client.ts` — JSON-RPC 客户端（`POST /api/<method>`）
- `discover.ts` — 端口探测 / 发现
- `launcher.ts` — 自启动（windowless、detached）、PID 记录、停止
- `protocol.ts` — 协议类型（含 `HostDescription.clientCount?`）

## 不放这里 ❌

- 事件流 WS → `../events/`；编辑器桥 → `../editor/`
