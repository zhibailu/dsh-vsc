/**
 * Runtime overlay patch table — the SINGLE source of truth for the dsh-vsc
 * bridge's in-memory deltas.
 *
 * These are the same textual deltas the removed disk-patch scripts
 * (scripts/patch-dsh-windowless.ps1 / patch-dsh-client-count.ps1) used to
 * write INTO the installed @deepseek-ai/dsh tree. The bridge philosophy is
 * "pure bridge": the official DSH body must stay byte-identical to the npm
 * release (see scripts/restore-dsh-pristine.ps1 + the recorded SHA256 in
 * ./pristine.ts). The loader (./loader.ts) applies these deltas to the module
 * SOURCE IN MEMORY as the harness process loads each module.
 *
 * Delta contract (all four were verified byte-exact against the npm release,
 * see the spike notes in internal/runtime-overlay.md):
 *   - url    : regex matched against the module's file URL (end-anchored)
 *   - marker : regex proving the patch is ALREADY in effect (idempotency)
 *   - re     : upstream anchor; group 1 = the line prefix, group 2 = its EOL,
 *              group 3 (windows-acl) = the following "hStdInput" line start
 *   - build  : (pre, eol, tail?) => replacement text
 *
 * Safety: if `marker` hits -> already overlaid (skip). If `re` misses ->
 * upstream changed shape; the loader MUST NOT patch (canary failure, logged,
 * degraded mode — the extension already degrades gracefully: clientCount
 * becomes undefined and shutdown falls back to "stop owned instance").
 */

export interface Delta {
  label: string;
  url: RegExp;
  marker: RegExp;
  re: RegExp;
  build: (pre: string, eol: string, tail?: string) => string;
}

export const PATCHES: Delta[] = [
  {
    label: "host-apiproxy clientCount (response schema)",
    url: /dsh-host-apiproxy[\\/]lib[\\/]index\.js$/,
    marker: /clientCount: z\$1\.number\(\)\.int\(\)\.nonnegative\(\)/,
    re: /(\tattachedSessions: z\$1\.number\(\)\.int\(\)\.nonnegative\(\),)(\r?\n)/,
    build: (pre, eol) => pre + eol + "\tclientCount: z$1.number().int().nonnegative()," + eol,
  },
  {
    label: "host-apiproxy clientCount (describe impl)",
    url: /dsh-host-apiproxy[\\/]lib[\\/]index\.js$/,
    marker: /clientCount: muxQueues\.size,/,
    re: /(\t\t\t\t\tattachedSessions: ctx\.agents\.list\(\)\.length,)(\r?\n)/,
    build: (pre, eol) => pre + eol + "\t\t\t\t\tclientCount: muxQueues.size," + eol,
  },
  {
    label: "subprocess-local spawn windowsHide",
    url: /dsh-subprocess-local[\\/]lib[\\/]index\.js$/,
    marker: /windowsHide: platform === "win32"/,
    re: /(\t\tdetached: platform !== "win32")(\r?\n)/,
    build: (pre, eol) => pre + "," + eol + '\t\twindowsHide: platform === "win32"' + eol,
  },
  {
    label: "windows-acl hidden console (STARTF_USESHOWWINDOW|SW_HIDE)",
    url: /dsh-sandbox-windows-acl[\\/]lib[\\/]types-[A-Za-z0-9_-]+\.js$/,
    marker: /wShowWindow: 0/,
    re: /(\t\tdwFlags: 256,)(\r?\n)(\t\thStdInput)/g,
    build: (pre, eol, tail) => "\t\tdwFlags: 257," + eol + "\t\twShowWindow: 0," + eol + (tail ?? ""),
  },
];

export type OverlayStatus = "no-match" | "already" | "patched" | "anchor-missing";

export interface OverlayResult {
  status: OverlayStatus;
  source?: string;
  label?: string;
}

/**
 * Apply every delta whose url matches `fileUrl` to `source`.
 * Returns the overlaid source (or the original unchanged).
 */
export function applyPatches(fileUrl: string, source: string): OverlayResult {
  const url = fileUrl.replace(/\\/g, "/");
  let out = source;
  let any = false;
  for (const p of PATCHES) {
    if (!p.url.test(url)) continue;
    any = true;
    if (p.marker.test(out)) continue; // already overlaid (idempotent)
    if (!p.re.test(out)) return { status: "anchor-missing", label: p.label };
    out = out.replace(p.re, (_m, pre: string, eol: string, tail?: string) => p.build(pre, eol, tail));
  }
  if (!any) return { status: "no-match" };
  return { status: out === source ? "already" : "patched", source: out };
}
