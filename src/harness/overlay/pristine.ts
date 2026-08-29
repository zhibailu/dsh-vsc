/**
 * Official-install integrity reference for the runtime overlay.
 *
 * The installed @deepseek-ai/dsh tree must stay byte-identical to the npm
 * release (v0.1.1-rc.1). These SHA256 values were computed from the tarballs
 * pulled straight from the npm registry and are what
 * scripts/restore-dsh-pristine.ps1 restores/verifies against. When upstream
 * ships a new version, update this table + the script + internal/runtime-overlay.md
 * together (see "upgrade checkpoints" there).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** relative path under the dsh package's node_modules/@deepseek-ai -> pristine SHA256 */
export const PRISTINE_SHA256: Record<string, string> = {
  "dsh-host-apiproxy/lib/index.js": "B37CD0EED0A20D625788608374C51B50AD367A8B42EB4D484F3542DB18114EC9",
  "dsh-subprocess-local/lib/index.js": "F3A11B8AD2D3E01CA9943E9EC919465D8D4525E60FDD6904DA0D4494FE00C247",
  "dsh-sandbox-windows-acl/lib/types-CNjZgO4h.js": "D75087768CC528FEC521C8E93259FF3B37A9FB4D3C627F132EA76F23FB4B4F54",
};

export interface PristineReport {
  ok: boolean;
  /** rel paths that are missing on disk */
  missing: string[];
  /** rel paths whose sha256 does not match the npm release */
  modified: string[];
  /** rel paths verified byte-identical to the npm release */
  pristine: string[];
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
}

/**
 * Check the dsh install under `subRoot` (e.g. `<npm-global>\node_modules\
 * @deepseek-ai\dsh\node_modules\@deepseek-ai`). Read-only; never writes.
 * A non-pristine tree means the runtime overlay can still patch, but the
 * "official body integrity" guarantee is broken (someone re-patched, or the
 * dsh version changed) — surface it.
 */
export function checkDshPristine(subRoot: string): PristineReport {
  const report: PristineReport = { ok: true, missing: [], modified: [], pristine: [] };
  const base = subRoot.replace(/[\\/]+$/, "");
  for (const rel of Object.keys(PRISTINE_SHA256)) {
    try {
      const hash = sha256(`${base}/${rel}`);
      if (hash === PRISTINE_SHA256[rel]) report.pristine.push(rel);
      else report.modified.push(rel);
    } catch {
      report.missing.push(rel);
    }
  }
  report.ok = report.missing.length === 0 && report.modified.length === 0;
  return report;
}
