# src/harness — harness 连接与生命周期

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（源码） |
| **为谁负责** | 扩展与 dsh harness 的一切连接/生命周期 |
| **行为边界** | 只放 harness 侧：客户端、发现、启动、协议 |

## 放这里 ✅

- `client.ts` — RPC 客户端（`POST /api/<endpoint>`，参数进 `payload.args`）+ 认证（`/connect` 换 cookie）
- `discover.ts` — 存活探测 / 发现（0.2.1 没有 `host.describe`，只探"有人应答"）
- `launcher.ts` — 自启动（windowless、detached）、**从 stdout 抓 launch token**、PID 记录、停止
- `protocol.ts` — 协议类型（0.2.1 线：端表、会话/页/投影、follow 帧、`$events` 帧、设置域）
- overlay 运行时补丁已于 0.2.1 整体退役，本目录不再有 `overlay/`

## 不放这里 ❌

- 事件流 WS → `../events/`；编辑器桥 → `../editor/`
