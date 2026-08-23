// Simulate the @ menu on a workspace root: derive dirs from files, print rows.
// Usage: node scripts/sim-menu.mjs [root]
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] ?? "D:/MyProject/dshsandbox";
const EXCLUDE = ["node_modules", "dist", ".git", "out", "build", "coverage", ".vscode-test", ".vscode-test-ext"];
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(path.relative(root, p).replaceAll("\\", "/"));
  }
})(root);

files.sort((a, b) => a.localeCompare(b));
const dirSet = new Set();
for (const f of files) {
  const parts = f.split("/");
  for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/"));
}
const dirs = [...dirSet].sort((a, b) => a.localeCompare(b));

console.log(`root: ${root}\ndirs: ${dirs.length}, files: ${files.length}\n--- 菜单前 14 行 ---`);
dirs.slice(0, 10).forEach((d) => console.log(`文件夹·${d.split("/").pop()}/ ${d}`));
files.slice(0, 4).forEach((f) => console.log(`文件·${f.split("/").pop()} ${f}`));
