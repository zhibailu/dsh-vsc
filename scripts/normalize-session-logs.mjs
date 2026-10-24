#!/usr/bin/env node
/**
 * Normalize DSH session logs so the 0.2.x format-migration chain accepts them.
 *
 * WHY THIS EXISTS (measured, 2026-10-24)
 * --------------------------------------
 * Sessions written by `@deepseek-ai/dsh` 0.1.1-rc.1 stamp the permission event as
 *
 *     {"type":"permission/preset","data":{"preset":"workspace-write","origin":"default"}}
 *
 * DSH 0.2.x routes such a log through `dsh-session-format-v0-to-v1`, which refuses
 * the extra member:
 *
 *     refuses this format v0 Session: permission/preset 0 data has unexpected
 *     member "origin"
 *
 * The log itself is untouched by that refusal ("source v0 artifact remains
 * unchanged") — the conversation is not lost, it is simply unreadable. Removing
 * the one member restores full readability: verified against a real 0.1.1 log,
 * which then served all 25 events (permission/preset … turn/end) through
 * `session/page` on 0.2.1-rc.3.
 *
 * WHAT IT DOES
 * ------------
 * Walks `<DSH_HOME>/sessions/<bucket>/<session>/session.jsonl.zstd`, decodes each
 * zstd frame, drops `data.origin` from `permission/preset` events, and rewrites
 * ONLY the frames that actually changed (frame framing, compressed data and every
 * other byte stay as they were).
 *
 * SAFETY
 * - Dry run by default: it prints what it WOULD change and writes nothing.
 * - `--apply` first copies the original to `<file>.bak` (never overwritten, so a
 *   second run cannot destroy the only pristine copy), then rewrites in place.
 * - No DSH code is imported, patched or executed; this only touches session data
 *   that belongs to the user.
 *
 * USAGE
 *   node scripts/normalize-session-logs.mjs                 # report only
 *   node scripts/normalize-session-logs.mjs --apply         # rewrite + backup
 *   node scripts/normalize-session-logs.mjs --home D:\x\.dsh --apply
 */
import { readFileSync, readdirSync, writeFileSync, copyFileSync, existsSync, statSync } from "node:fs";
import { zstdDecompressSync, zstdCompressSync } from "node:zlib";
import { join } from "node:path";
import { homedir } from "node:os";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const homeFlag = argv.indexOf("--home");
const home = homeFlag >= 0 && argv[homeFlag + 1] ? argv[homeFlag + 1] : process.env.DSH_HOME || join(homedir(), ".dsh");
const sessionsRoot = join(home, "sessions");

/** Byte offsets of every zstd frame header in `buf`. */
function frameOffsets(buf) {
  const marks = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      marks.push(i);
    }
  }
  return marks;
}

/**
 * Drop `data.origin` from permission/preset events in one frame.
 * @returns [newText, patchedCount]
 */
function patchFrameText(text) {
  let patched = 0;
  const out = text
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return line;
      }
      if (event && event.type === "permission/preset" && event.data && typeof event.data === "object" && "origin" in event.data) {
        delete event.data.origin;
        patched++;
        return JSON.stringify(event);
      }
      return line;
    })
    .join("\n");
  return [out, patched];
}

function* sessionLogs() {
  let buckets = [];
  try {
    buckets = readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return;
  }
  for (const bucket of buckets) {
    let sessions = [];
    try {
      sessions = readdirSync(join(sessionsRoot, bucket.name), { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const session of sessions) {
      const file = join(sessionsRoot, bucket.name, session.name, "session.jsonl.zstd");
      if (existsSync(file)) yield { file, bucket: bucket.name, session: session.name };
    }
  }
}

let scanned = 0;
let changed = 0;
let patchedEvents = 0;
let failed = 0;

for (const { file, bucket, session } of sessionLogs()) {
  scanned++;
  let buf;
  try {
    buf = readFileSync(file);
  } catch (error) {
    failed++;
    console.error(`  ! ${bucket}/${session}: read failed — ${error.message}`);
    continue;
  }
  const marks = frameOffsets(buf);
  if (marks.length === 0) {
    failed++;
    console.error(`  ! ${bucket}/${session}: no zstd frame found (unexpected layout) — skipped`);
    continue;
  }
  const parts = [];
  let filePatched = 0;
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i];
    const to = i + 1 < marks.length ? marks[i + 1] : buf.length;
    const raw = buf.subarray(from, to);
    let text;
    try {
      text = zstdDecompressSync(raw).toString("utf8");
    } catch {
      parts.push(raw); // undecodable frame: leave byte-identical
      continue;
    }
    const [next, patched] = patchFrameText(text);
    if (patched > 0) {
      parts.push(zstdCompressSync(Buffer.from(next, "utf8")));
      filePatched += patched;
    } else {
      parts.push(raw);
    }
  }
  if (filePatched === 0) continue;
  changed++;
  patchedEvents += filePatched;
  if (apply) {
    const backup = `${file}.bak`;
    if (!existsSync(backup)) copyFileSync(file, backup);
    writeFileSync(file, Buffer.concat(parts));
    console.log(`  ~ ${bucket}/${session}: patched ${filePatched} event(s) (backup: ${backup})`);
  } else {
    console.log(`  · ${bucket}/${session}: would patch ${filePatched} event(s)`);
  }
}

console.log("");
console.log(`DSH_HOME      : ${home}`);
console.log(`mode          : ${apply ? "APPLY (writes + .bak)" : "DRY RUN (writes nothing)"}`);
console.log(`logs scanned  : ${scanned}`);
console.log(`logs changed  : ${changed}`);
console.log(`events patched: ${patchedEvents}`);
console.log(`skipped/failed: ${failed}`);
if (!apply && changed > 0) {
  console.log("");
  console.log("Re-run with --apply to write the changes (each file keeps a .bak copy).");
}
if (apply && changed > 0) {
  console.log("");
  console.log("Revert: replace each session.jsonl.zstd with its neighboring .bak file.");
}
