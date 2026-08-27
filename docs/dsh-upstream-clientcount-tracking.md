# DSH 上游追踪：客户端计数与身份字段（升级检查点）

> 本文档记录 dsh-vsc 对 DSH 上游（`@deepseek-ai/dsh` 全局安装包）的依赖点，
> 特别是"客户端连接计数 / 客户端身份"能力的现状与我们的补丁，以及每次
> `npm update -g @deepseek-ai/dsh` 后需要核对的地方。
>
> 背景：2026-08 多进程写入冲突事故（web 端 3080 与扩展自拉 3081 实例共用
> `~/.dsh`，JSONL 会话日志无跨进程锁，双实例各自内存 seq 交错 append 导致
> `corrupt session log: seq gap`）。修复方向定为：**扩展是 harness 的第二个
> 客户端（共享模式），不再自起第二个服务端**；仅在没有任何 harness 时自拉
> 兜底实例，并对其做引用计数关闭（最后一个客户端离开时才停）。
>
> 数据根策略：扩展自拉实例与 web GUI **共用 `~/.dsh`**（同一份历史，"一个在跑
> 另一个能看到"）。不再使用 DSH_HOME 隔离——端口天然排他：扩展自拉实例占用
> 的正是 web GUI 的默认端口（3080），两者不可能同时存在，因此也不会双写同一
> 日志。

---

## 1. 现状（2026-08-27，@deepseek-ai/dsh 0.1.1-rc.1）

### 1.1 官方已实现：服务端能数客户端，但不对外暴露

- `@deepseek-ai/dsh-host-apiproxy` 内部维护 `muxQueues`（`Set`）：
  - 每个连接 `/api/events.mux` 的消费者（浏览器 tab、扩展的 WS）各占一个队列
  - 连接建立时 `muxQueues.add(queue)`，断开时 `delete`（`lib/index.js` 内，打包后约 line 1679/3544/3625）
  - 也就是说服务端进程**内部**知道"当前有几个视图客户端连着我"，这个数就是 `muxQueues.size`
- **但协议层没有暴露**：
  - `host.describe` 返回值（`lib/index.js` 内 `host.describe` 实现）只有
    `version / cwd / provider / model / attachedSessions / home / canOpenPath`
    —— 没有 `clientCount`
  - 响应经 zod schema 校验（`hostDescribeValueSchema`），`z.object` 默认剥掉未声明字段，
    所以即使实现里多返回一个字段，也会被 schema 静默丢弃

### 1.2 官方已预留但未实现：客户端/服务端身份

- `dsh-host-apiproxy/README.md`（及 README.zh.md）明确写着
  **`hostInstanceId` 是 documented reservation**（文档化保留位，尚未实现）。
  这是服务端进程身份；官方没有客户端身份（无 auth、无 clientId、无连接注册表）。
- `muxQueues` 里只有匿名连接，**无法**区分"哪个客户端是谁"。

### 1.3 对 dsh-vsc 的含义

- 我们只能可靠拿到"**有多少个客户端连着**"（计数），拿不到"**有哪些客户端、自己是哪一个**"（身份）。
- 因此关闭策略采用**引用计数**（count ≤ 1 且实例是我们自拉的 → 停），而不是路由式关闭。

---

## 2. 我们的补丁：host.describe 增加 clientCount

- 脚本：`scripts/patch-dsh-client-count.ps1`（幂等；`npm update -g` 后需重跑）
- 改动文件：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-host-apiproxy\lib\index.js`
- 两处修改（必须同时存在，否则 zod 剥字段）：
  1. `hostDescribeValueSchema` 增加 `clientCount: z.number().int().nonnegative()`
  2. `host.describe` 实现返回 `clientCount: muxQueues.size`
- 语义：`clientCount` = 当前 `/api/events.mux` 消费者数。扩展自己也占一个
  （它的 `HarnessEventStream` 就是一条 mux 连接），所以判定"是否最后一个客户端"
  用 `clientCount <= 1`。
- 扩展侧消费：`src/harness/protocol.ts` 的 `HostDescription.clientCount?: number`
  （`undefined` = 补丁未应用，视为"无其他客户端已知"——进程是自拉的且无窗口，
  停掉比留孤儿好）。
- 注意：补丁只对**之后启动**的 harness 生效（模块加载时才有 `clientCount`），
  已运行中的实例要重启才带新字段。

### 如何验证补丁是否生效

```powershell
# 对运行中的 harness
curl.exe -s -X POST http://127.0.0.1:3080/api/host.describe -H "content-type: application/json" -d "{\"type\":\"client-request\",\"rpcId\":\"x\",\"method\":\"host.describe\",\"payload\":{}}"
# 返回值里应出现 "clientCount": N
```

---

## 3. 升级检查点（每次 `npm update -g @deepseek-ai/dsh` 之后）

按顺序核对，任何一项异常都说明上游变了，需要同步更新补丁脚本 / 扩展 / 本文档。

1. **跑补丁脚本**：`powershell -ExecutionPolicy Bypass -File scripts\patch-dsh-client-count.ps1`
   - 出现 `[FAIL] ... anchor not found` → 上游改了文件结构，进第 2 步
   - 全是 `[ok]`（已应用）或 `[PATCH]` → 继续第 2 步确认
2. **确认 clientCount 存活**：
   - 重新 grep `dsh-host-apiproxy\lib\index.js` 是否还有
     `clientCount: muxQueues.size` 与 `clientCount: z$1.number().int().nonnegative()`
   - 若上游自己实现了 `clientCount`（或改名）→ 可考虑移除我们的补丁，改用官方的，
     同时改 `protocol.ts` 注释
3. **确认身份字段是否落地**：
   - 读 `dsh-host-apiproxy/README.md`，查 `hostInstanceId` 是否从
     "documented reservations" 变成已实现
   - 若实现 → 评估是否值得升级关闭策略为**身份感知**（例如：只有扩展这一个
     客户端时才停，浏览器 tab 不计入我们的引用计数，或按 clientId 精确路由）
   - 若未实现 → 维持引用计数策略，不改
4. **确认 muxQueues 语义没变**：
   - 若上游把 `/api/events.mux` 改成每会话独立连接、或加入连接复用/心跳保活，
     `clientCount` 的"一个 tab / 一个扩展 = 1"语义会变，需重估 `<= 1` 阈值
5. **端到端验证**（扩展 F5 调试）：
   - 只开 web GUI → 扩展连上（共享模式）→ 关 VS Code → 确认 3080 **不被杀**，
     deactivate 日志记录 `owned=false`
   - 无任何 harness → 打开 VS Code → 扩展自拉实例（共享 `~/.dsh`）→ 状态栏可见 →
     关 VS Code → 确认自拉实例被停、`%TEMP%\dsh-vsc-harness.pid` 被清
   - 自拉实例运行时，浏览器再开一个 tab 连它（count=2）→ 关 VS Code →
     确认实例**保留**，deactivate 日志记录 `clientCount=2 ... keep running`

---

## 4. 相关文件

| 文件 | 作用 |
|---|---|
| `scripts/patch-dsh-client-count.ps1` | 幂等补丁：host.describe 加 clientCount |
| `scripts/patch-dsh-windowless.ps1` | 已有补丁：windowless 工具执行（同类模式参考） |
| `src/harness/protocol.ts` | `HostDescription.clientCount?` |
| `src/harness/launcher.ts` | 自拉实例 PID 记录（`%TEMP%\dsh-vsc-harness.pid`） |
| `src/extension.ts` | `deactivate()` 引用计数关闭逻辑 |
| `~/.dsh/sessions/.../session-589ab6fa.../` | 2026-08 损坏事故现场（已归档，勿删） |
