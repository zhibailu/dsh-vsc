# AGENTS.md

Guidance for AI coding agents working in this repository. Read this before making changes.

## What this project is

`dsh-vsc` (DSH Bridge) is a **VS Code extension** that connects to **DeepSeek Harness (DSH)** — a local AI agent service (default `http://127.0.0.1:3080`) — as a **protocol client**. It renders DSH's work in a native sidebar panel and bridges the editor (ask-about-selection, review-agent-changes).

The defining constraint is the **"pure bridge"** philosophy: consume DSH's **wire contract (protocol)**, not its UI; never rewrite DSH; never start a second server on an existing history. Details in [docs/design.md](docs/design.md) — read it before touching architecture.

## Commands

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | esbuild → `dist/extension.js` + `dist/media` |
| `npm run package` | Build + `vsce package` → `dsh-vsc-<version>.vsix` |
| `node scratch/auto-test.mjs <sessionId> <turnNo>` | jsdom regression test against a live harness |

Debug via F5 (`.vscode/launch.json`) → Extension Development Host.

## Source layout

- `src/extension.ts` — entry point; activation, command registration, harness lifecycle, shutdown.
- `src/editor/` — editor bridge: selection context, change tracking, diff building, file jumps.
- `src/events/` — `HarnessEventStream`: the `/api/remote.mux` logical-stream client (follow / control / workspace / `$events`).
- `src/harness/` — protocol client, discovery, launcher (incl. launch-token capture).
- `src/panel/` — sidebar: `NativePanelProvider.ts`, native `panel.html`, embedded webview.
- `internal/` — private maintainer docs (plan, playbook, upstream tracking). **git-ignored; never publish or commit to git.**
- `scratch/` — throwaway probes/tests against a live harness (real events); not production code.
- `docs/` — public user docs + screenshots.

## Architecture invariants (do not break)

1. **Never import DSH internals.** The client (`src/harness/client.ts`) reimplements the wire contract with only `fetch`; keep it thin (~200 lines). No `@deepseek-ai/dsh-*` imports in shipped code.
2. **Forward events losslessly.** The bridge must not re-model DSH event frames (`src/panel/protocol.ts`). Rendering is the panel's job.
3. **No second server.** Reuse a running harness; auto-start only when none is reachable; never spawn a second DSH writing the same `~/.dsh` history. Shutdown stops only an instance THIS extension spawned (see invariant 5 for why the old reference count is gone).
4. **Target is the DSH 0.2.1 line (Typert Remote).** Endpoints are slash-separated (`session/page`, not `session.history`), every argument rides `payload.args` keyed by the Host's literal parameter names (`session/list` is `_request`, with the underscore), and streams are logical streams on ONE WebSocket (`/api/remote.mux`) rather than a fixed `/api/events.mux`. There is **no dot-name compatibility alias** — old spellings answer `404`.
5. **Auth is a first-class wire concern.** Every `/api/*` call and the WS handshake must carry the signed cookie minted by `GET /connect?token=<launchToken>&interactions=answer`. The launch token is a per-process random value that is never written to disk, so the launcher must capture it from `dsh web`'s stdout; a harness the extension did not start requires the user's `dshVsc.token`.
6. **No runtime overlay.** The 0.1.x in-memory patch module is retired: every delta it carried is either shipped by DSH itself (windowless subprocess spawn, `STARTF_USESHOWWINDOW|SW_HIDE`) or no longer exists (`dsh-host-apiproxy` / `clientCount`). Do not reintroduce disk or memory patches; if upstream lacks something, degrade in the panel instead.

## Coding conventions

- TypeScript, strict. Follow existing style in `src/`.
- Keep the bridge transparent: no invented re-modeling of DSH data.
- Per-directory `README.md` files describe each area's responsibility and boundary — keep them in sync when you move things.
- Public-facing docs live in `docs/`; anything internal/private goes in `internal/` (and stays git-ignored).

## Testing

- The repo favors verifying against the **real harness + real event streams**. `scratch/` contains many one-off probes; the maintained live probes are `scratch/probe-0.2.1-endpoints.mjs` (every RPC the bridge calls, exact arg shape) and `scratch/probe-0.2.1-stream.mjs` (`$events` / `session/control` / `workspace/follow` / `session/follow`, incl. a real approval waterfall). `scratch/auto-test.mjs` (jsdom panel renderer) predates 0.2.1 and still replays `session.history` frames.
- Run `npm run typecheck` before committing; `npm run build` to confirm the bundle compiles.
