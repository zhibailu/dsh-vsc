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
deepseek, deepseek-harness, dsh, ai-agent, local-ai, vscode-extension, vscode, ide, code-assistant, protocol-client, agent, llm, ai-tools, code-review
```

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
