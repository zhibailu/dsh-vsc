# .vscode — 编辑器开发配置

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（开发配置，用户 clone 后 F5 可用） |
| **为谁负责** | 开发者（维护者/贡献者） |
| **行为边界** | 只放 VS Code 工作区配置（launch/tasks/settings） |

## 放这里 ✅

- `launch.json` — F5 调试（Extension Development Host + `--extensionDevelopmentPath`）

## 不放这里 ❌

- 仓库运行时代码 → `src/`；私人文档 → `internal/`
