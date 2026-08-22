// Build script: bundle the extension host entry + copy static assets.
// Usage: node esbuild.js [--watch]
const esbuild = require("esbuild");
const { cpSync, mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");

const watch = process.argv.includes("--watch");

/** Copy a directory of static assets into dist. */
function copyDir(from, to) {
  cpSync(from, to, { recursive: true });
}

async function main() {
  rmSync("dist", { recursive: true, force: true });
  mkdirSync("dist", { recursive: true });

  const options = {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    outfile: "dist/extension.js",
    sourcemap: true,
    logLevel: "info",
  };

  copyDir("src/panel/media", "dist/media");

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("[esbuild] watching…");
  } else {
    await esbuild.build(options);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
