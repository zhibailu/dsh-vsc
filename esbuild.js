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

  // Runtime overlay: pure-ESM loader + --import entry injected into the
  // harness process (node --import dist/overlay-register.mjs ...). Must be
  // ESM (module.register) and must NOT be bundled into the CJS extension.
  const overlayOptions = {
    entryPoints: ["src/harness/overlay/register.ts", "src/harness/overlay/loader.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outdir: "dist",
    entryNames: "overlay-[name]",
    outExtension: { ".js": ".mjs" },
    sourcemap: true,
    logLevel: "info",
  };

  copyDir("src/panel/media", "dist/media");
  copyDir("src/panel/native", "dist/media/native");

  if (watch) {
    const [ctx, ctxOverlay] = await Promise.all([esbuild.context(options), esbuild.context(overlayOptions)]);
    await Promise.all([ctx.watch(), ctxOverlay.watch()]);
    console.log("[esbuild] watching…");
  } else {
    await Promise.all([esbuild.build(options), esbuild.build(overlayOptions)]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
