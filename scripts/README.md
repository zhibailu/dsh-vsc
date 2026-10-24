# scripts — 工具脚本区

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（仓库里有，但 vsix 打包排除） |
| **为谁负责** | 维护者（校验 / 自测），不面向终端用户 |
| **行为边界** | 只放开发/运维脚本：官方本体校验、生命周期测试 |

## 放这里 ✅

- `restore-dsh-pristine.ps1` — 还原/校验官方 `@deepseek-ai/dsh` 安装树与 npm 发布版字节一致（幂等；`-VerifyOnly` 只读校验）
- `verify-sandbox.mjs` / `lifecycle-test.ps1` — 开发期自测

## 不放这里 ❌

- 一次性调试探针 → `scratch/`
- 源码 → `src/`

## 背景（如实记录）

- 曾有两个补丁脚本（`patch-dsh-windowless.ps1` / `patch-dsh-client-count.ps1`）**直接改写官方安装包文件**，违反"纯桥接：绝不写 DSH 官方文件"，已删除。
- 之后又用**运行时内存覆盖**（`src/harness/overlay/`，经 NODE_OPTIONS 注入）临时补过 `clientCount` 与 windowless；**这一层在 DSH 0.2.1 上已整体退役**：控制台隐藏由官方 `dsh-win32-process` 自己做，`clientCount` 随 `dsh-host-apiproxy` 包消失。现在扩展对官方文件**零侵入**，也不再注入 `NODE_OPTIONS`。
- `restore-dsh-pristine.ps1` 只对**装过 0.1.x 的老机器**还有意义：它把历史补丁痕迹还原回官方原版并做 SHA256 校验；新装的 0.2.1 从未被改过，跑不跑都一样。

## ⚠️ 已知问题（如实记录）

- `verify-sandbox.mjs` 里写死了维护者的绝对路径（`C:\Users\WihteDew\...`、`D:\MyProject\dshsandbox`），**别人机器上直接跑会失败**。待办：改为动态解析，或声明"仅维护者本机使用"。
