#!/usr/bin/env node
// Optional equal-length byte patches for the installed Claude Code binary.
//
// Patch definitions live in patches.json next to the install root, so a new Claude Code
// release can be supported by editing JSON instead of this script. Each `find`/`start`
// entry may be a list of alternatives; the first one present wins. Missing anchors are
// reported and skipped, never forced, and the original binary is kept as claude.bin.orig.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.env.CC_TERMUX_ROOT || path.join(os.homedir(), ".local", "share", "cc-termux");
const BIN = path.join(ROOT, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin");
const BACKUP = BIN + ".orig";
const BACKUP_META = BACKUP + ".json";
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const PATTERN_HINT = /Switch between AI providers|Provider rows switch provider|name:"provider"/;
const DEFS = path.join(ROOT, "patches.json");

function loadDefs() {
  try { return JSON.parse(fs.readFileSync(DEFS, "utf8")); }
  catch (e) { return { text: [], regions: [] }; }
}
const padBytes = (s, n) => { const b = Buffer.from(String(s), "utf8"); if (b.length > n) throw new Error("replacement is longer than the anchor"); return Buffer.concat([b, Buffer.alloc(n - b.length, 0x20)]); };
const asList = (v) => (Array.isArray(v) ? v : [v]);

function applyText(buf, patches, applied, skipped) {
  let changed = 0;
  for (const p of patches) {
    let hit = null;
    let already = false;
    for (const find of asList(p.find)) {
      const idx = buf.indexOf(Buffer.from(find));
      if (idx >= 0) { hit = find; break; }
      try { if (buf.indexOf(padBytes(p.replace, find.length)) >= 0) { already = true; break; } } catch (e) { }
    }
    if (!hit) { skipped.push(p.id + (already ? " (already patched)" : " (anchor missing)")); continue; }
    const find = Buffer.from(hit);
    let repl;
    try { repl = padBytes(p.replace, hit.length); } catch (e) { skipped.push(p.id + " (" + e.message + ")"); continue; }
    let pos = buf.indexOf(find);
    let n = 0;
    while (pos >= 0) { repl.copy(buf, pos); n++; pos = buf.indexOf(find, pos + find.length); }
    changed += n;
    applied.push(p.id + (n > 1 ? " x" + n : ""));
  }
  return changed;
}

function applyRegions(buf, patches, applied, skipped) {
  let changed = 0;
  for (const p of patches) {
    let start = null;
    for (const s of asList(p.start)) { if (buf.indexOf(Buffer.from(s)) >= 0) { start = s; break; } }
    if (!start) { skipped.push(p.id + " (start anchor missing)"); continue; }
    let end = null;
    for (const e of asList(p.end)) { if (buf.indexOf(Buffer.from(e)) >= 0) { end = e; break; } }
    if (!end) { skipped.push(p.id + " (end anchor missing)"); continue; }
    const startBuf = Buffer.from(start);
    const endBuf = Buffer.from(end);
    let at = buf.indexOf(startBuf);
    let n = 0;
    while (at >= 0) {
      const endAt = buf.indexOf(endBuf, at);
      if (endAt < 0) break;
      const len = endAt - at;
      let repl;
      try { repl = padBytes(p.replace, len); } catch (e) { skipped.push(p.id + " (" + e.message + ")"); break; }
      if (!buf.subarray(at, endAt).equals(repl)) { repl.copy(buf, at); n++; }
      at = buf.indexOf(startBuf, at + len);
    }
    if (n) { changed += n; applied.push(p.id + (n > 1 ? " x" + n : "")); }
    else skipped.push(p.id + " (no region matched)");
  }
  return changed;
}

function atomicWrite(file, data, mode) {
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

function writeBackup(buf) {
  atomicWrite(BACKUP, Buffer.from(buf), 0o755);
  fs.writeFileSync(BACKUP_META, JSON.stringify({ size: buf.length, sha256: sha256(buf), at: new Date().toISOString() }, null, 2) + "\n");
}

function ensureBackup(buf) {
  if (!fs.existsSync(BACKUP)) { writeBackup(buf); return; }
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(BACKUP_META, "utf8")); } catch (e) { meta = null; }
  let backupBuf = null;
  try { backupBuf = fs.readFileSync(BACKUP); } catch (e) { backupBuf = null; }
  const valid = meta && backupBuf && meta.size === backupBuf.length && meta.sha256 === sha256(backupBuf);
  if (valid && meta.size === buf.length) return;
  if (PATTERN_HINT.test(buf.toString("utf8"))) {
    console.error("cc-patch: the saved backup belongs to a different build and this binary is already patched.");
    console.error("cc-patch: refusing to patch; run: cc-termux update --redownload");
    process.exit(1);
  }
  // Current binary is unpatched and differs from the stale backup: refresh it.
  writeBackup(buf);
}

function apply() {
  let buf;
  try { buf = fs.readFileSync(BIN); } catch (e) { console.error("cc-patch: binary not found: " + BIN); process.exit(1); }
  ensureBackup(buf);
  const defs = loadDefs();
  const applied = [], skipped = [];
  let changed = applyRegions(buf, defs.regions || [], applied, skipped);
  changed += applyText(buf, defs.text || [], applied, skipped);
  if (!changed) { console.log("cc-patch: nothing to do" + (skipped.length ? " [" + skipped.join(", ") + "]" : "")); return 0; }
  try { atomicWrite(BIN, buf, 0o755); }
  catch (e) { console.error("cc-patch: cannot write binary (" + e.code + "). Quit Claude sessions and retry."); process.exit(1); }
  console.log("cc-patch: applied " + applied.join(", ") + (skipped.length ? "  (skipped: " + skipped.join(", ") + ")" : ""));
  return 0;
}

function status() {
  let buf;
  try { buf = fs.readFileSync(BIN); } catch (e) { console.error("cc-patch: cannot read binary (" + e.code + ")"); process.exit(1); }
  const defs = loadDefs();
  let pendingCount = 0;
  for (const p of [...(defs.regions || []), ...(defs.text || [])]) {
    const anchors = asList(p.find || p.start);
    let applied = false;
    try {
      const probe = Buffer.from(String(p.replace), "utf8").subarray(0, 48);
      if (probe.length && buf.indexOf(probe) >= 0) applied = true;
    } catch (e) { }
    const pending = anchors.some((a) => buf.indexOf(Buffer.from(a)) >= 0);
    if (pending && !applied) pendingCount++;
    console.log("  " + (applied ? "applied " : pending ? "pending " : "n/a     ") + p.id + "  - " + (p.description || ""));
  }
  if (process.argv[2] === "--check" && pendingCount) process.exit(2);
}

function revert() {
  if (!fs.existsSync(BACKUP)) { console.error("cc-patch: no backup at " + BACKUP); process.exit(1); }
  let meta = null, backup = null;
  try { meta = JSON.parse(fs.readFileSync(BACKUP_META, "utf8")); } catch (e) { meta = null; }
  try { backup = fs.readFileSync(BACKUP); } catch (e) { backup = null; }
  const force = process.argv.includes("--force");
  if (!meta || !backup || meta.size !== backup.length || meta.sha256 !== sha256(backup)) {
    if (!force) { console.error("cc-patch: backup metadata is missing or does not match the backup file; refusing to revert (use --force to override)"); process.exit(1); }
  }
  try {
    const tmp = BIN + ".revert." + process.pid;
    fs.writeFileSync(tmp, backup, { mode: 0o755 });
    fs.renameSync(tmp, BIN);
    console.log("cc-patch: reverted to the unpatched binary");
  } catch (e) { console.error("cc-patch: revert failed: " + e.message); process.exit(1); }
}

const cmd = process.argv[2] || "--apply";
if (cmd === "--apply") process.exit(apply());
else if (cmd === "--status" || cmd === "--check") status();
else if (cmd === "--revert") revert();
else console.log("usage: cc-patch [--apply|--status|--revert]");