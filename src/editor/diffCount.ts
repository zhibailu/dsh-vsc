/**
 * Bridge-side line-diff counting for agent file mutations.
 *
 * Pure bridge logic: it reads only the tool-call arguments the agent already
 * sent on the wire (plus the current workspace file state for full-file
 * writes), and never touches the harness. It produces the "+N-M" numbers the
 * panel shows per tool call and per turn.
 *
 * Sources of truth, in priority order:
 *  1. tool/result `meta.diffs` (dsh-tool-fs stamps its result-time hunks
 *     { path, oldText, newText } there) — exact.
 *  2. tool/call arguments — exact for edit / str_replace_editor (old/new
 *     strings are both in the payload); best-effort for write (old content is
 *     read from disk at call time, i.e. before the harness usually applies it).
 */

export interface LineDiff {
  added: number;
  deleted: number;
}

/** Read the current content of a file path (resolved by the caller). */
export type OldContentReader = (path: string) => string | null;

const WRITE_LIKE = /^(write|fs[_a-z]*write|fs[_a-z]*create)$/i;
const EDIT_LIKE = /^(edit|fs[_a-z]*edit)$/i;
const PATCH_LIKE = /^(patch|apply_patch)$/i;
const DELETE_LIKE = /^(fs[_a-z]*delete|fs[_a-z]*remove)$/i;
const STR_EDITOR = "str_replace_editor";

/** Cap for the LCS DP; beyond it we fall back to "everything differs". */
const LCS_CELL_CAP = 4_000_000;

/** Split text into lines, ignoring the artifact of a single trailing newline. */
export function linesOf(text: string): string[] {
  const s = String(text ?? "");
  const lines = s.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 1 && lines[0] === "") return [];
  return lines;
}

/** Longest common subsequence length over lines (rolling-row DP). */
function lcsLength(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      cur[j] = ai === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur[0] = 0;
  }
  return prev[m];
}

/** Line-level diff between two texts: added / deleted line counts. */
export function diffLines(oldText: string, newText: string): LineDiff {
  const a = linesOf(oldText);
  const b = linesOf(newText);
  if (a.length === 0 && b.length === 0) return { added: 0, deleted: 0 };
  if (a.length === 0) return { added: b.length, deleted: 0 };
  if (b.length === 0) return { added: 0, deleted: a.length };
  // Trim the common prefix / suffix so typical local edits hit a tiny matrix.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0) return { added: midB.length, deleted: 0 };
  if (midB.length === 0) return { added: 0, deleted: midA.length };
  if (midA.length * midB.length > LCS_CELL_CAP) {
    return { added: midB.length, deleted: midA.length };
  }
  const lcs = lcsLength(midA, midB);
  return { added: midB.length - lcs, deleted: midA.length - lcs };
}

/** Count +/- lines in a unified diff payload (ignores hunk headers). */
function countUnifiedDiff(diffText: string): LineDiff {
  let added = 0;
  let deleted = 0;
  for (const line of linesOf(diffText)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) deleted++;
  }
  return { added, deleted };
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

function pathArg(args: Record<string, unknown>): string {
  return strArg(args, "file_path") || strArg(args, "path");
}

/**
 * Best-effort diff from a tool/call payload alone.
 * `readOld` supplies the pre-write content for full-file writes (the caller
 * owns path resolution / workspace awareness).
 */
export function countToolArgsDiff(
  name: string,
  args: Record<string, unknown>,
  readOld?: OldContentReader
): LineDiff | null {
  const n = String(name ?? "").trim();
  if (n === STR_EDITOR) {
    const command = strArg(args, "command");
    if (command === "create") {
      const added = linesOf(strArg(args, "file_text")).length;
      return { added, deleted: 0 };
    }
    if (command === "str_replace") {
      return diffLines(strArg(args, "old_str"), strArg(args, "new_str"));
    }
    if (command === "insert") {
      const added = linesOf(strArg(args, "new_str")).length;
      return { added, deleted: 0 };
    }
    return null;
  }
  if (WRITE_LIKE.test(n)) {
    const content = strArg(args, "content");
    const old = readOld ? readOld(pathArg(args)) : null;
    if (old === null) return { added: linesOf(content).length, deleted: 0 };
    return diffLines(old, content);
  }
  if (EDIT_LIKE.test(n)) {
    return diffLines(strArg(args, "old_string"), strArg(args, "new_string"));
  }
  if (PATCH_LIKE.test(n)) {
    const diffText = strArg(args, "diff") || strArg(args, "patch") || strArg(args, "content");
    if (!diffText) return null;
    return countUnifiedDiff(diffText);
  }
  if (DELETE_LIKE.test(n)) {
    const old = readOld ? readOld(pathArg(args)) : null;
    if (old === null) return null;
    return { added: 0, deleted: linesOf(old).length };
  }
  return null;
}

/**
 * Exact diff from a tool/result payload: dsh-tool-fs stamps `meta.diffs`
 * ({ path, oldText, newText } hunks) at result time. When the tool rewrote a
 * brand-new file the array is empty — fall back to the call's content so
 * creations still count as additions.
 */
export function countMetaDiff(
  meta: unknown,
  name: string,
  args: Record<string, unknown>
): LineDiff | null {
  const m = meta as { diffs?: unknown } | null | undefined;
  if (!m || !Array.isArray(m.diffs)) return null;
  if (m.diffs.length === 0) {
    const n = String(name ?? "").trim();
    if (WRITE_LIKE.test(n)) {
      return { added: linesOf(strArg(args, "content")).length, deleted: 0 };
    }
    if (n === STR_EDITOR && strArg(args, "command") === "create") {
      return { added: linesOf(strArg(args, "file_text")).length, deleted: 0 };
    }
    return null;
  }
  let added = 0;
  let deleted = 0;
  for (const hunk of m.diffs as { oldText?: unknown; newText?: unknown }[]) {
    const d = diffLines(String(hunk?.oldText ?? ""), String(hunk?.newText ?? ""));
    added += d.added;
    deleted += d.deleted;
  }
  return { added, deleted };
}
