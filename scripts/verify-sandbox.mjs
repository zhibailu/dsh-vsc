// Verify the patched windows-acl sandbox chain still works and stays windowless.
import { execFileSync } from "node:child_process";
const node = "C:\\Program Files\\nodejs\\node.exe";
const runner = "C:\\Users\\WihteDew\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js";
const ws = "D:\\MyProject\\dshsandbox";
const tmp = process.env.TEMP;
try {
  const out = execFileSync(node, [
    runner, "--workspace", ws, "--temp", tmp, "--mode", "read-only", "--",
    "powershell", "-NoProfile", "-Command", "Write-Output sandbox-chain-ok",
  ], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  console.log("exit 0, output:", out.trim());
} catch (e) {
  console.log("FAILED status=", e.status);
  if (e.stdout) console.log("stdout:", e.stdout.trim());
  if (e.stderr) console.log("stderr:", e.stderr.trim());
  process.exit(1);
}
