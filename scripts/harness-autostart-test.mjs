// One-shot verification of the launcher pattern (reg fallback + detached spawn).
import { spawn, execFile } from "node:child_process";

function readWindowsUserEnv(name) {
  return new Promise((resolve) => {
    execFile("reg", ["query", "HKCU\\Environment", "/v", name], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(undefined);
      const m = new RegExp(`${name}\\s+REG_\\S+\\s+(.+)`).exec(stdout);
      resolve(m ? m[1].trim() : undefined);
    });
  });
}

async function main() {
  const env = { ...process.env };
  const source = env.GITHUB_TOKEN ? "process env" : "reg user env";
  if (!env.GITHUB_TOKEN) {
    const t = await readWindowsUserEnv("GITHUB_TOKEN");
    if (t) env.GITHUB_TOKEN = t;
  }
  console.log(`GITHUB_TOKEN: ${env.GITHUB_TOKEN ? env.GITHUB_TOKEN.length + " chars (via " + source + ")" : "MISSING"}`);

  const child = spawn("dsh web --no-open --port 3088", {
    shell: true,
    windowsHide: true,
    detached: true,
    stdio: "ignore",
    env,
  });
  console.log("spawned pid", child.pid);
  child.unref();

  // poll the harness API
  const deadline = Date.now() + 40000;
  let ok = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:3088/api/host.describe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "t", method: "host.describe", payload: {} }),
      });
      if (res.ok) {
        const body = await res.json();
        console.log("HARNESS UP:", JSON.stringify(body.result?.value).slice(0, 160));
        ok = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ok) {
    console.log("HARNESS FAILED TO BOOT within 40s");
    process.exitCode = 1;
  }
  // cleanup: kill the whole tree
  execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (err) => {
    console.log("taskkill:", err ? "failed (" + err.message + ")" : "tree killed");
    process.exit(0);
  });
}

main();
