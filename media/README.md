# media — 扩展图标资源

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（打进 vsix，用于扩展图标） |
| **为谁负责** | 扩展本身（package.json 引用） |
| **行为边界** | 只放扩展级图标/静态资源（svg 等） |

## 放这里 ✅

- `dsh.svg` — 活动栏 / 视图容器图标（package.json `contributes.viewsContainers` 引用）

## 不放这里 ❌

- webview 内嵌资源 → `src/panel/media/`
- 文档截图 → `docs/screenshots/`
