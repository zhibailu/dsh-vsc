// Build script: bundle the extension host entry + copy static assets.
// Usage: node esbuild.js [--watch]
const esbuild = require("esbuild");
const { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const watch = process.argv.includes("--watch");

/** Copy a directory of static assets into dist. */
function copyDir(from, to) {
  cpSync(from, to, { recursive: true });
}

/**
 * Bundle the panel markdown renderer (src/panel/renderer.ts — the same
 * micromark engine the official web GUI uses) and inline it into
 * dist/media/native/panel.html at the __DASH_MARKDOWN__ marker. The panel's
 * CSP is script-src 'unsafe-inline' (no external scripts), so the bundle must
 * live inside the HTML. The src panel.html keeps the placeholder.
 */
async function injectRenderer() {
  const res = await esbuild.build({
    entryPoints: ["src/panel/renderer.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: ["es2020", "chrome120"],
    minify: true,
    write: false,
    logLevel: "info",
  });
  const bundle = res.outputFiles[0].text;
  const panelDist = "dist/media/native/panel.html";
  let html = readFileSync("src/panel/native/panel.html", "utf8");
  if (!html.includes("__DASH_MARKDOWN__")) {
    throw new Error("panel.html is missing the __DASH_MARKDOWN__ marker");
  }
  // Function replacer — a string replacement would interpret "$&"/"$'" in the
  // bundle (micromark's URL-encode regex has "$&-;") and corrupt it.
  html = html.replace("/*__DASH_MARKDOWN__*/", () => bundle);
  writeFileSync(panelDist, html);
  // Integrity: the written file must contain the bundle byte-for-byte.
  const written = readFileSync(panelDist, "utf8");
  if (!written.includes(bundle)) {
    throw new Error("renderer injection integrity check failed: bundle corrupted in panel.html");
  }
  console.log(`[esbuild] renderer inlined into panel.html (${bundle.length} bytes)`);
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
  copyDir("src/panel/native", "dist/media/native");
  await injectRenderer();

  if (watch) {
    const [ctx, ctxRenderer] = await Promise.all([
      esbuild.context(options),
      // Re-inject the renderer bundle into panel.html on every rebuild.
      esbuild.context({
        entryPoints: ["src/panel/renderer.ts"],
        bundle: true,
        platform: "browser",
        format: "iife",
        target: ["es2020", "chrome120"],
        minify: true,
        write: false,
        logLevel: "info",
      }),
    ]);
    ctxRenderer.onEnd(() => injectRenderer());
    await Promise.all([ctx.watch(), ctxRenderer.watch()]);
    console.log("[esbuild] watching…");
  } else {
    await esbuild.build(options);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
