// CDP capture v2: attach to the WEBVIEW target (type 'iframe', vscode-webview://),
// auto-attach its cross-origin subframes, reload, and collect console/errors.
// Usage: node scripts/cdp-capture.mjs [seconds]
const DURATION_MS = (Number(process.argv[2] ?? 25)) * 1000;

const version = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const BROWSER_WS = version.webSocketDebuggerUrl;

const ws = new WebSocket(BROWSER_WS);
let seq = 0;
const pending = new Map();
const sessions = new Map(); // sessionId -> label

function send(sessionId, method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, sessionId, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

function labelOf(sessionId) {
  return sessions.get(sessionId) ? `[${sessions.get(sessionId)}]` : "[?]";
}

ws.onmessage = (msg) => {
  const data = JSON.parse(String(msg.data));
  if (data.id !== undefined) {
    const resolve = pending.get(data.id);
    if (resolve) { pending.delete(data.id); resolve(data.result ?? data.error); }
    return;
  }
  if (data.method === "Target.attachedToTarget" && data.params.sessionId) {
    const info = data.params.targetInfo || {};
    const url = (info.url || "").slice(0, 70);
    sessions.set(data.params.sessionId, `${info.type}:${url}`);
    console.log(`[attach] ${info.type} ${data.params.sessionId} -> ${url}`);
    for (const m of ["Runtime.enable", "Log.enable", "Page.enable"]) {
      ws.send(JSON.stringify({ id: ++seq, sessionId: data.params.sessionId, method: m, params: {} }));
    }
    // auto-attach children of this target too (OOPIFs)
    ws.send(JSON.stringify({ id: ++seq, sessionId: data.params.sessionId, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }));
    return;
  }
  const p = data.params || {};
  const label = labelOf(data.sessionId);
  switch (data.method) {
    case "Runtime.consoleAPICalled": {
      const args = (p.args || []).map((a) => (a.value !== undefined ? JSON.stringify(a.value).slice(0, 250) : (a.description || a.type).slice(0, 250))).join(" ");
      console.log(`${label} CONSOLE.${p.type}: ${args}`);
      break;
    }
    case "Runtime.exceptionThrown":
      console.log(`${label} EXCEPTION: ${JSON.stringify(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text).slice(0, 600)}`);
      break;
    case "Log.entryAdded":
      if (p.entry && (p.entry.level === "error" || p.entry.level === "warning")) {
        console.log(`${label} LOG.${p.entry.level}: ${String(p.entry.text).slice(0, 300)}`);
      }
      break;
    case "Runtime.executionContextCreated":
      if (p.context?.auxData?.isDefault) {
        console.log(`${label} context: ${p.context.origin} (${p.context.name || "?"})`);
      }
      break;
  }
};

ws.onopen = async () => {
  console.log("connected:", BROWSER_WS);
  const { targetInfos } = await send(undefined, "Target.getTargets");
  const webviews = targetInfos.filter((t) => t.type === "iframe" && t.url.startsWith("vscode-webview://"));
  console.log(`--- ${webviews.length} webview iframe target(s) ---`);
  for (const w of webviews) {
    console.log(`  ${w.targetId} ${w.url.slice(0, 60)}`);
  }
  // attach to each webview, auto-attach its children, then reload
  for (const w of webviews) {
    const { sessionId } = await send(undefined, "Target.attachToTarget", { targetId: w.targetId, flatten: true });
    if (sessionId) {
      sessions.set(sessionId, `webview:${w.url.slice(0, 50)}`);
      for (const m of ["Runtime.enable", "Log.enable", "Page.enable"]) await send(sessionId, m, {});
      await send(sessionId, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      console.log(`[reload] ${w.url.slice(0, 60)}`);
      await send(sessionId, "Page.reload", { ignoreCache: true });
    }
  }
  console.log(`--- capturing for ${DURATION_MS / 1000}s (waiting for DSH app boot) ---`);
  setTimeout(() => { console.log("--- done ---"); try { ws.close(); } catch {} process.exit(0); }, DURATION_MS);
};

ws.onerror = (e) => { console.log("ws error", JSON.stringify(e.message)); process.exit(1); };
ws.onclose = () => process.exit(0);
