# src/panel/media — webview 内嵌资源

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（源码，编译后进 dist/media） |
| **为谁负责** | webview 页面本身 |
| **行为边界** | 只放 webview 引用的静态资源 |

## 放这里 ✅

- `shell.html` — 嵌入视图的 shell 模板
- `dsh-whale.svg` — 面板内图标

## 不放这里 ❌

- 扩展级图标 → `media/`（仓库根）；截图 → `docs/screenshots/`
