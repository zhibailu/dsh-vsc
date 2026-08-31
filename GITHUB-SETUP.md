# GitHub repo setup — copy-paste for discoverability

These live in **GitHub repo settings** (not in files), so you set them once on the web page.
Most of them are what search engines and AI models read first. Do them all — they're free.

## 1. Repository **Description** (<= 350 chars; keyword-first, states what & why)

Paste this into the repo "Description" box on the repo home page:

```
Run DeepSeek Harness (DSH), a local AI agent, inside VS Code — native sidebar panel + editor bridge. A pure protocol client: no rewriting DSH, no second server.
```

## 2. Repository **Topics** (click "Add topics" under the description; pick as many as fit)

Select/add these tags (comma-separated list to add):

```
deepseek, deepseek-harness, dsh, dsh-plugin, ai-agent, local-ai, vscode-extension, vscode, ide, code-assistant, protocol-client, agent, llm, ai-tools, code-review
```

> ⚠️ **`dsh-plugin` 尤其重要**：有清单（如 `kingselyjoe/awesome-dsh-list`）是**自动扫描 GitHub `dsh-plugin` topic** 来收录项目的。加上这个 topic，等于自动进入它们的目录。

## 3. **Website** field (optional)

If you ever host a one-page site or a docs site, point it here. Not required.

## 4. Badges already in the README

The README uses **static** shields.io badges (no repo dependency), so they render even before the repo is public. Once the repo is public, you can optionally swap to `github/...` dynamic badges (e.g. `shields.io/github/license/zhibailu/dsh-vsc`, stars, release). Not required — static is fine.

## 5. Double-check: publish the right files

Before pushing, confirm these are committed and **not** git-ignored:

| File | Purpose |
|---|---|
| `README.md` | Primary (English) — the main discoverability surface |
| `README.zh.md` | Chinese mirror |
| `llms.txt` | AI/LLM crawler index (linked from README) |
| `AGENTS.md` | Onboarding for AI coding agents |
| `CONTRIBUTING.md` | Contribution guide (linked from README) |
| `CHANGELOG.md` | Release history |
| `docs/design.md`, `docs/screenshots/` | Philosophy + screenshots referenced by README |

> ⚠️ `internal/` must **stay** git-ignored (private maintainer docs) — it is already excluded via `.gitignore` / `.vscodeignore`; do not `git add -f internal`.

## 6. Verify the README links render

Open the repo page and confirm: badges show, TOC anchors jump, the three screenshots load from `docs/screenshots/`, and the language toggle (`English` / `简体中文`) works both ways.

---

## 7. 上 `awesome-deepseek-harness` 清单（让 AI/搜索能"找到你"的关键一步）

> **为什么**：AI 推荐"DSH 的 VS Code 项目"时，通常是照着一份人工维护的精选清单抄的。你的项目不在任何清单上，所以它再问 AI 也搜不到。**把项目提交进这些清单**，它才会出现在 AI 和搜索引擎的目录里。这些清单大多接受任何人提交 PR。

### 先确认（10 秒）：仓库必须 **Public**

打开 `https://github.com/zhibailu/dsh-vsc` → 仓库名旁必须是 **Public**。是 `Private` 的话，下面全部白做。

### 要提交的清单（按优先级）

| 清单 | 地址 | 说明 |
|---|---|---|
| fendouai/awesome-deepseek-harness | https://github.com/fendouai/awesome-deepseek-harness | 规模最大、最常被引用，有 `CONTRIBUTING.md` |
| 0xsline/awesome-deepseek-harness | https://github.com/0xsline/awesome-deepseek-harness | 另一份主流清单，有 `contributing.md` |
| whyihouyou 系 / dsh-suite | https://github.com/whyihaveyou/dsh-suite | 活目录，每小时刷新 + 兼容实测 |
| wgd753 / beancookie 的 awesome-dsh-plugin | 同名搜索 | 按 `dsh-plugin` 生态收录 |

### 提交方式（每份清单各点 1 次，总共几分钟）

1. 打开清单仓库 → 点 **Fork**（右上角）→ 它会复制到你的账号下。
2. 在你 fork 的副本里，打开 `README.md`（有的有 `README.zh-CN.md` 中文版，也加一份），找到"VS Code / 客户端 / 集成"这类分类的小节。
3. 在那一节里，照别人的格式加一行（见下方**现成条目**）。
4. Commit → 回到原仓库 → 点 **Contribute / New pull request** → 描述粘贴下面的 **PR 文案** → Create。

### 现成条目（复制即用）

**英文版**（放进英文 README 的 VS Code / 客户端分类）：

```markdown
- [zhibailu/dsh-vsc](https://github.com/zhibailu/dsh-vsc) — Native VS Code sidebar + editor bridge for DeepSeek Harness. A pure protocol client: ask about your selection, review agent changes, approve operations — no rewriting DSH, no second server.
```

**中文版**（放进 `README.zh-CN.md` 的分类）：

```markdown
- [zhibailu/dsh-vsc](https://github.com/zhibailu/dsh-vsc) — 在 VS Code 里用 DeepSeek Harness：原生侧边栏面板 + 编辑器桥（选区提问、改动审查、审批卡片）。纯协议客户端，不重写 DSH、不另起第二个服务端。
```

**PR 标题**：`Add dsh-vsc — native VS Code client for DeepSeek Harness`

**PR 描述**（粘贴）：

```
Adds [zhibailu/dsh-vsc](https://github.com/zhibailu/dsh-vsc) to the VS Code / client section.

A native VS Code extension for DeepSeek Harness (DSH):
- Native sidebar panel + editor bridge (ask about a selection, review agent changes, approval & question cards).
- Built as a **pure protocol client** — it consumes DSH's wire contract, does not rewrite DSH, and never starts a second server.
- Robust across DSH upgrades because it stands on the protocol layer, not the UI layer.

License: MIT. Screenshots and a design/rationale doc are in the README.
```

### 之后会发生什么

- 清单维护者合并后，你的项目进入那份目录 → AI 和搜索引擎再"推荐 DSH 的 VS Code 项目"时，会照目录提到你。
- 加上 GitHub `dsh-plugin` topic，自动扫描型清单也会陆续收录。
- ⚠️ 现实预期：**刚上清单、0 star 时，你只会出现在"全量目录"里，不会排到"最火"前列**。那些要靠时间、star、真实使用沉淀。但"能被找到"是第一步，这一步现在就做得到。

### 顺手做（可选，加大被搜到的概率）

- 在 README 末尾加一行指向 awesome 清单（形成互链，对 SEO 有帮助）。
- 等哪天有真实用户，把他们的 star / issue 作为社交证明。
