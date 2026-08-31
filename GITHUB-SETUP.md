# 让 dsh-vsc 能被别人和 AI 搜到（傻瓜版）

## 先搞懂：为什么搜不到你？

你的仓库已经是 **Public** 了，但别人和 AI 还是搜不到——因为：

- 它**太新**，几乎没有访问量，搜索引擎还没"收录"它。
- **没有任何一个网页链接它**，也没有人提起它。
- 它**不在任何精选清单里**（AI 推荐"DSH 的 VS Code 项目"时，是照清单抄的）。

一句话：**公开 ≠ 被收录**。要"被收录"，得有人提你 + 你主动把自己放进去。下面就是你要做的，按顺序来，做完全部 10 分钟以内。

---

## 第 1 步：加"标签"（topics）—— 1 分钟

在仓库主页右侧那个 **About** 框里，点**铅笔（✏️）**，在 **Topics** 那一栏，输入一个词按回车，加完为止。加这些：

```
deepseek-harness  dsh  dsh-plugin  vscode-extension  ai-agent  local-ai  protocol-client
```

> ⚠️ **`dsh-plugin` 一定要加**——有个清单是自动扫这个标签来收录项目的，加了它等于自动上车。

---

## 第 2 步：把项目"报备"进精选清单 —— 最关键，能让你被 AI 找到

现在有**好几份**专门收录 DSH 项目的清单。你只要给每份清单提交一次申请（PR），让维护者把你加进去。**你不需要会英文，照抄下面的字就行。**

### 要申请这几份清单（按重要顺序）

1. **fendouai/awesome-deepseek-harness** — 最常被引用的一份
2. **0xsline/awesome-deepseek-harness** — 另一份主流清单
3. **whyihaveyou/dsh-suite** — 活目录，每小时刷新
4. **wgd753/awesome-dsh-plugin** — 按 `dsh-plugin` 生态收录

### 怎么申请（每份重复一次，约 1–2 分钟）

1. 打开那份清单的 GitHub 页面 → 右上角点 **Fork**（会复制一份到你的账号）。
2. 在你复制的那份里，打开 `README.md`（如果有中文版 `README.zh-CN.md`，也一起改），找到写着 **"VS Code"** 或 **"客户端 / Client"** 的那一节。
3. 在那节里，照着别人条目的样子，**加一行下面的话**。
4. 点页面左上角 "**Contribute**" → "**Open pull request**" → 标题和说明照抄下面的 → 点 **Create pull request**。

### 要加的那一行（直接复制）

**加到英文版 README：**

```
- [zhibailu/dsh-vsc](https://github.com/zhibailu/dsh-vsc) — Native VS Code sidebar + editor bridge for DeepSeek Harness. A pure protocol client: ask about your selection, review agent changes, approve operations — no rewriting DSH, no second server.
```

**如果清单有中文版，也加一行：**

```
- [zhibailu/dsh-vsc](https://github.com/zhibailu/dsh-vsc) — 在 VS Code 里用 DeepSeek Harness：原生侧边栏面板 + 编辑器桥（选区提问、改动审查、审批卡片）。纯协议客户端，不重写 DSH、不另起第二个服务端。
```

### 申请时的标题和说明（直接复制）

**标题**：`Add dsh-vsc — native VS Code client for DeepSeek Harness`

**说明**：

```
Adds zhibailu/dsh-vsc to the VS Code section. A native VS Code
extension for DeepSeek Harness (DSH): native sidebar panel + editor
bridge, built as a pure protocol client. Does not rewrite DSH, never
starts a second server, and stays robust across DSH upgrades because
it stands on the protocol layer. License: MIT.
```

---

## 第 3 步（可选，但有帮助）：把仓库链接进你的 README

在你自己 README 的**末尾**加一行，指向那份最大的清单，形成互链（对搜索收录有帮助）：

```
Thanks to the community — dsh-vsc is listed on [awesome-deepseek-harness](https://github.com/fendouai/awesome-deepseek-harness).
```

---

## 做完之后会发生什么

- 清单维护者**合并**后，你的项目就进了那份目录 → 之后 AI 和搜索引擎再"推荐 DSH 的 VS Code 项目"时，会照目录提到你。
- 加完 `dsh-plugin` 标签，自动扫描的清单也会慢慢收录。
- **现实预期**：刚上、0 个 star 时，你只会出现在"全量列表"里，不会一下排到最前面。那需要时间、star 和真实使用。但**"能被找到"这一步，现在就做得到。**

---

## 你唯一要亲自做的

就是**第 1、2 步**那几下点击（往 GitHub 提交标签和 PR）。这些都**必须用你的账号**，我没法替你点。材料我全备好了，你照抄即可。
