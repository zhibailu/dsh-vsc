// M0 probe — prove the DSH bridge protocol against a running harness.
// Usage: node scripts/probe.mjs  (defaults to http://127.0.0.1:3080)
// Wire protocol (verified against @deepseek-ai/dsh-host-apiproxy):
//   POST /api/<method>            body: {type:'client-request', rpcId, method, payload}
//   resp: {type:'server-response', rpcId, result:{ok, value|error}}
//   WS   /api/events.mux          all-session event stream
//   WS   /api/events.host         host-level stream

const BASE = process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080";
const crypto = await import("node:crypto");

function rpcId() {
  return crypto.randomUUID();
}

async function call(method, payload) {
  const id = rpcId();
  const res = await fetch(`${BASE}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: id, method, payload }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function summarize(label, r) {
  const b = r.body;
  const result = b && typeof b === "object" ? b.result : undefined;
  if (r.status !== 200 || !result) {
    console.log(`✗ ${label}: HTTP ${r.status} ${typeof b === "string" ? b : JSON.stringify(b)?.slice(0, 300)}`);
    return undefined;
  }
  if (result.ok) {
    console.log(`✓ ${label}`);
    return result.value;
  }
  console.log(`✗ ${label}: ${result.error?.code} — ${result.error?.message}`);
  return undefined;
}

console.log(`probe base: ${BASE}\n`);

// 1. host.describe — handshake the browser client does on connect
const desc = summarize("host.describe", await call("host.describe", {}));
if (desc) console.log(`    → ${JSON.stringify(desc).slice(0, 300)}`);

// 2. session.list — list persisted sessions
const list = summarize("session.list", await call("session.list", {}));
const items = list?.items ?? [];
console.log(`    → ${items.length} session(s)`);
for (const it of items.slice(0, 5)) {
  console.log(`      ${it.sessionId}  running=${it.running}  blank=${it.blank}  updatedAt=${new Date(it.updatedAt).toISOString()}`);
}

// 3. session.history — read a window from the latest session
if (items.length > 0) {
  const sid = items[0].sessionId;
  const hist = summarize("session.history", await call("session.history", { sessionId: sid, maxMessages: 3 }));
  const events = hist?.events ?? [];
  console.log(`    → ${events.length} event(s), hasMore=${hist?.hasMore}`);
  for (const e of events.slice(0, 6)) {
    const ev = e.event;
    const name = ev?.type ?? ev?.name ?? JSON.stringify(ev)?.slice(0, 60);
    console.log(`      seq=${ev?.seq} ${name}`);
  }
} else {
  console.log("    (no sessions to read history from)");
}

// 4. events.mux — open the WS event stream, sample frames for 2.5s
console.log("");
const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/events.mux`);
const frames = [];
const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve("timeout"), 2500);
  ws.onopen = () => console.log("✓ ws /api/events.mux opened");
  ws.onerror = (e) => {
    console.log(`✗ ws error: ${e.message ?? "unknown"}`);
    clearTimeout(timer);
    resolve("error");
  };
  ws.onmessage = (msg) => {
    try {
      const frame = JSON.parse(String(msg.data));
      frames.push(frame);
      if (frames.length >= 5) {
        clearTimeout(timer);
        resolve("sample");
      }
    } catch {
      /* non-JSON frame, ignore */
    }
  };
  ws.onclose = (e) => {
    clearTimeout(timer);
    resolve(`closed(${e.code})`);
  };
});
const outcome = await done;
console.log(`    ws sample: ${outcome}, ${frames.length} frame(s)`);
for (const f of frames.slice(0, 5)) {
  const t = f.payload?.type ?? f.type;
  const sid = f.payload?.sessionId ?? f.sessionId;
  console.log(`      type=${t} session=${sid ?? "-"}`);
}
try { ws.close(); } catch { /* already closed */ }

console.log("\nprobe done.");
