# Changelog

All notable changes to **dsh-vsc (DSH Bridge)**.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- _(nothing yet)_

## [0.3.0] - 2026-10-24

**DSH 0.2.1 line (Typert Remote).** Moves the bridge from the 0.1.x wire to 0.2.1-rc.3. **Not backward compatible with 0.1.x harnesses** — old dot-named endpoints answer `404`, with no compatibility alias.

### Changed — wire
- Endpoint table rewritten to slash form, with typed arguments under `payload.args` (`session/list` takes `_request`, underscore included); `session/prompt` now mints a `requestId`.
- `session.history` split into `session/page` (requires `throughSeq`, taken from the follow snapshot's cursor) + `session/projections`; `session/models` → `session/modelCatalog` (`default` / `routableProviders`); `agentPreset.list` → `agentPresets/list` (rows carry only id/order/isDefault, display copy comes from the bridge).
- Event transport rewritten: the fixed `/api/events.mux` is gone; everything is logical streams on one socket `/api/remote.mux` — `session/follow` (snapshot + durable events + raw assistant-stream chunks), `session/control` (projection baseline + deltas), `workspace/follow` (rows + archived set), `$events` (forwarded host events + answerable waterfalls).
- Approvals and questions: `/api/respond` → forwarded waterfalls answered through `$events/result` (`clientId` + `eventId` + outcome).
- Session list updates now ride forwarded `api-session/added|removed|status|activity` events; titles/usage/stats come from control projections instead of list rows.

### Added — auth (new in 0.2.1)
- `GET /connect?token=<launchToken>&interactions=answer` mints the signed API cookie that every `/api/*` call and the WS handshake must carry.
- The launcher captures the per-process launch token from `dsh web`'s stdout; a harness the extension did not start needs `dshVsc.token` from the user.

### Removed
- **Runtime overlay retired** (`src/harness/overlay/`, 4 deltas + 3 SHA-256 pins + `NODE_OPTIONS` injection): upstream now ships the windowless subprocess spawn and `STARTF_USESHOWWINDOW|SW_HIDE`, and `clientCount` vanished with `dsh-host-apiproxy`. The extension touches no official file.
- Reference-counted shutdown (`host.describe` → `clientCount`): shutdown now stops only the instance this extension spawned.

### Fixed
- Harness refusal copy keys on `session/attachment-invalid` (the 0.2.1 envelope, reason in `details.reason`) as well as the 0.1.x `attachment-error`.
- Settings writes omit `expectedRevision` when unknown — the 0.2.1 gateway rejects `null`.
- Permission select falls back to the three shipped presets, since 0.2.1's `permissions` projection carries only the current value.

### Notes
- 0.2.2–0.2.6 shipped without changelog entries; see `git log --oneline` for that span.

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
