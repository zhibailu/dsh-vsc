/**
 * Grafted markdown renderer — the SAME engine the official DSH web GUI uses.
 *
 * The harness's web UI renders message text with micromark (+ GFM extensions);
 * this module is that same pipeline, bundled into the panel at build time
 * (esbuild injects it into panel.html; CSP is script-src 'unsafe-inline').
 * Markdown SEMANTICS (what is a heading / table / fence / bold…) come from
 * micromark, so our output matches the official renderer by construction.
 *
 * What stays ours is the webview-specific SPACING: the panel body is
 * `white-space: pre-wrap`, so block elements (headings/tables/pre) separate by
 * their own margins and must NOT be followed by a bare "\n" (it would double
 * into a visible blank row), while text paragraphs separate by "\n\n" (one
 * visible blank line). The official page has no pre-wrap bodies, so this
 * layer has no official counterpart to copy.
 */
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

/** Top-level block elements micromark can emit (p is special-cased). */
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "pre", "table", "ul", "ol", "blockquote", "hr",
]);

/**
 * Collapse whitespace-only gaps BETWEEN tags everywhere except inside
 * <pre>…</pre> (code content is significant). micromark pretty-prints tables,
 * lists and blockquotes with newlines between tags; under the panel's pre-wrap
 * body those inter-tag newlines would render as visible blank rows. Code
 * blocks are masked out so their content keeps every newline.
 */
function minifyExceptPre(fragment: string): string {
  const pres: string[] = [];
  const masked = fragment.replace(/<pre[\s\S]*?<\/pre>/g, (m) => {
    pres.push(m);
    return `\u0000${pres.length - 1}\u0000`;
  });
  const collapsed = masked.replace(/>\s+</g, "><");
  return collapsed.replace(/\u0000(\d+)\u0000/g, (_, i) => pres[Number(i)]);
}

interface TopNode {
  kind: "p" | "block";
  html: string;
}

/**
 * Split a micromark fragment into its TOP-LEVEL block nodes. Nested block
 * elements (blockquote > p, blockquote > pre, …) stay inside their parent's
 * html — only depth-0 p/hN/pre/table/ul/ol/blockquote/hr become nodes.
 */
function splitTopLevel(html: string): TopNode[] {
  const nodes: TopNode[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
  let depth = 0;
  let cur = "";
  let curKind: "p" | "block" | null = null;
  let m: RegExpExecArray | null;
  let pos = 0;
  const flush = (): void => {
    if (curKind) {
      nodes.push({ kind: curKind, html: cur });
      cur = "";
      curKind = null;
    }
  };
  while ((m = tagRe.exec(html)) !== null) {
    const text = html.slice(pos, m.index);
    if (depth > 0 && curKind) cur += text;
    pos = tagRe.lastIndex;
    const close = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (BLOCK_TAGS.has(tag)) {
      if (tag === "hr") {
        // Void element: standalone top-level node when at depth 0.
        if (depth === 0) {
          flush();
          nodes.push({ kind: "block", html: m[0] });
        } else if (curKind) {
          cur += m[0];
        }
        continue;
      }
      if (!close) {
        if (depth === 0) {
          flush();
          curKind = tag === "p" ? "p" : "block";
        }
        depth++;
      } else {
        depth--;
        if (depth === 0) {
          cur += m[0];
          flush();
        }
      }
      if (depth > 0 && curKind) cur += m[0];
    } else if (depth > 0 && curKind) {
      cur += m[0];
    }
  }
  flush();
  return nodes;
}

/** Unwrap <p>…</p> into bare text (pre-wrap keeps the line structure) and
 *  turn remote markdown images into links (CSP img-src blocks http). */
function pText(pHtml: string): string {
  let inner = pHtml.replace(/^<p>/, "").replace(/<\/p>$/, "");
  inner = inner.replace(/<img\s+src="([^"']+)"[^>]*>/g, (m, url: string) =>
    url.startsWith("data:") ? m : `<a class="md-img-link" href="${url}">[图片]</a>`
  );
  return inner;
}

/** Map a block node onto the panel's class structure (same classes the old
 *  renderer emitted: md-hN / md-table / md-code + the block-copy button). */
function mapBlock(html: string): string {
  let out = html;
  out = out
    .replace(/<h([1-6])>/g, '<div class="md-h$1">')
    .replace(/<\/h([1-6])>/g, "</div>");
  out = out
    .replace(/<pre>/g, '<pre class="md-code">')
    .replace(/<\/pre>/g, '<button class="block-copy" title="复制代码">⧉ 复制</button></pre>');
  if (out.startsWith("<table")) out = '<div class="md-table">' + out + "</div>";
  return out;
}

/**
 * Render markdown message text for the panel.
 * Spacing rule (preserves the web markdown look):
 *  - block nodes: no trailing "\n" (their margins handle spacing);
 *  - text paragraph followed by text: "\n\n" (one visible blank line);
 *  - text paragraph followed by a block: one "\n";
 *  - no trailing newline at the very end.
 */
export function renderMd(text: string): string {
  const src = String(text ?? "");
  if (src.trim() === "") return "";
  const fragment = micromark(src, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
    allowDangerousHtml: false,
  });
  if (fragment.trim() === "") return "";
  const nodes = splitTopLevel(minifyExceptPre(fragment));
  let out = "";
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === "p") {
      out += pText(n.html);
      if (i < nodes.length - 1) {
        out += nodes[i + 1].kind === "p" ? "\n\n" : "\n";
      }
    } else {
      out += mapBlock(n.html);
    }
  }
  return out.replace(/\n+$/u, "");
}

// Expose to the panel's inline scripts (they call DshMd.render).
(globalThis as unknown as { DshMd?: { render: (text: string) => string } }).DshMd = {
  render: renderMd,
};
