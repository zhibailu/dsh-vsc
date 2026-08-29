# src — 源码区（TypeScript）

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（仓库核心，vsix 打包时编译进 dist，不直接入包） |
| **为谁负责** | 扩展功能本身 |
| **行为边界** | 只放扩展运行时代码（.ts / 面板静态资源） |

## 结构

| 目录 | 职责 |
|---|---|
| `editor/` | 编辑器桥：选区上下文、改动追踪、diff 构建、文件跳转 |
| `events/` | HarnessEventStream：WebSocket 事件流客户端 |
| `harness/` | harness 客户端 / 发现 / 自启动器 / 协议类型 |
| `panel/` | 侧边栏面板：NativePanelProvider、嵌入 HTML、原生面板 |

## 放这里 ✅

- 扩展的 TS 源码、面板 HTML/资源

## 不放这里 ❌

- 复盘/规划 → `internal/`；脚本 → `scripts/`；扩展级图标 → `media/`
