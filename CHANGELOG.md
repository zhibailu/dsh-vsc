# Changelog

All notable changes to **dsh-vsc (DSH Bridge)**.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- _(nothing yet)_

## [0.2.1] - 2026-08-30

- Docs: design-philosophy deep-dive and index pointer; install-from-Releases-first guidance; version placeholder for vsix filenames.
- Fix: activity-bar container id without a dot; untrusted-workspace support; sidebar focus command.

## [0.2.0] - 2026-08-30

- **Settings panel** + composer layout rework; model / effort split; agent-preset **mode picker**.
- Single-source wire schema (`src/harness/protocol.ts`); drop dead `agentPreset.select`.
- Grafted the official **micromark** markdown engine so GFM renders like the web GUI (headings, italics, strikethrough, tables, block margins).
- **Permission-preset** select (read-only / workspace-write / full-access) via permissions projection + `/permission` command; read `agentPreset.list` by official schema.
- In-panel **Ask card**, approval & question interaction cards, reasoning-effort switch.
- Runtime **in-memory patch loader** replaces disk-patch scripts (overlay).
- CI: auto-build and publish `.vsix` on version tags.

## [0.1.0] - 2026-08-23

- Initial release: DSH in the VS Code sidebar (embedded web GUI) + native bridge.
- Harness lifecycle: discover, reuse-or-auto-start, self-heal, reference-counted shutdown (`clientCount`).
- Native sidebar chat panel: streaming, session picker, queue/steer/edit/copy, task bar (todos projection), slash commands, `@` file-mention picker, per-turn timing, `+N-M` stats, collapsible tool actions.
- Editor bridge: **Ask DSH about selection** (structured context), **Review Agent Changes** (write/edit/str_replace_editor → native git diff).
- Overlay v1: client-count + window/console hiding, guarded by SHA-256 + canary anchors.
