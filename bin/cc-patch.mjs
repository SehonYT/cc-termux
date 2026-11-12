#!/usr/bin/env node
// Optional equal-length byte patches for the installed Claude Code binary.
// Definitions live in patches.json; missing anchors are skipped and the original is kept.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { installRoot, atomicWrite } from "./cc-paths.mjs";

// Resolve the install root the same way the rest of modelmesh does, so a custom
// --root or a Windows layout is not silently read from the wrong place.
const ROOT = installRoot();
const BIN = path.join(ROOT, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin");
const BACKUP = BIN + ".orig";
const BACKUP_META = BACKUP + ".json";
// Written by --apply, removed by --revert, so the launcher can spot a binary that lost
// its patches without re-reading 300 MB on every start.
const PATCH_STAMP = BIN + ".patched";
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const HINT_BUFFERS = [Buffer.from("Switch between AI providers"), Buffer.from("Provider rows switch provider"), Buffer.from('name:"provider"')];
const isPatched = (buf) => HINT_BUFFERS.some((h) => buf.indexOf(h) >= 0);
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



function writeBackup(buf, extra = {}) {
  atomicWrite(BACKUP, Buffer.from(buf), 0o755);
  const meta = { size: buf.length, sha256: sha256(buf), at: new Date().toISOString(), ...extra };
  fs.writeFileSync(BACKUP_META, JSON.stringify(meta, null, 2) + "\n");
}

function ensureBackup(buf) {
  if (!fs.existsSync(BACKUP)) { writeBackup(buf); return; }
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(BACKUP_META, "utf8")); } catch (e) { meta = null; }
  let backupBuf = null;
  try { backupBuf = fs.readFileSync(BACKUP); } catch (e) { backupBuf = null; }
  const valid = meta && backupBuf && meta.size === backupBuf.length && meta.sha256 === sha256(backupBuf);
  if (valid && meta.size === buf.length) return;
  if (isPatched(buf)) {
    // The installed binary is already patched (e.g. an older .orig from a previous build).
    // Refresh the backup from the current patched binary instead of forcing a 310 MB reinstall.
    console.error("cc-patch: stale backup detected; refreshing it from the installed (already patched) binary.");
    console.error("cc-patch: note: --revert will restore this patched build, not an unpatched one.");
    writeBackup(buf, { patched: true });
    return;
  }
  // Current binary is unpatched and differs from the stale backup: refresh it.
  writeBackup(buf);
}

// Read the ELF interpreter path this binary was built with. Returns null when it is not an
// ELF or the program header cannot be found, so a lookalike file is left alone.
export function elfInterpreter(buf) {
  try {
    if (buf.length < 64 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) return null;
    const is64 = buf[4] === 2;
    const little = buf[5] === 1;
    if (!is64) return null;
    const read = (off) => (little ? buf.readBigUInt64LE(off) : buf.readBigUInt64BE(off));
    const phoff = Number(read(0x20));
    const phentsize = buf.readUInt16LE(0x36);
    const phnum = buf.readUInt16LE(0x38);
    for (let i = 0; i < phnum; i++) {
      const base = phoff + i * phentsize;
      if (base + 4 > buf.length) break;
      if (buf.readUInt32LE(base) !== 3) continue; // PT_INTERP
      const off = Number(read(base + 8));
      const size = Number(read(base + 32));
      const end = buf.indexOf(0, off);
      const stop = end > 0 && end < off + size ? end : off + size;
      return buf.subarray(off, stop).toString("utf8");
    }
    return null;
  } catch (e) { return null; }
}

// True when the binary asks for a loader path that no longer exists, which is what a moved
// install root or a project rename leaves behind.
export function staleInterpreter() {
  try {
    const buf = fs.readFileSync(BIN);
    const interp = elfInterpreter(buf);
    if (!interp) return null;
    if (fs.existsSync(interp)) return null;
    const want = path.join(ROOT, "lib", path.basename(interp));
    return fs.existsSync(want) ? { was: interp, want } : null;
  } catch (e) { return null; }
}

// Repoint the interpreter with patchelf. Without it the binary cannot be exec'd directly,
// so the launcher falls back to loader mode, which is slower and limits self-relaunch.
export function fixInterpreter() {
  const stale = staleInterpreter();
  if (!stale) return null;
  const has = spawnSync("patchelf", ["--version"], { stdio: "ignore" }).status === 0;
  if (!has) {
    try { spawnSync("pkg", ["install", "-y", "patchelf"], { stdio: "ignore" }); } catch (e) { }
  }
  const ok = spawnSync("patchelf", ["--version"], { stdio: "ignore" }).status === 0;
  if (!ok) return { ...stale, fixed: false, reason: "patchelf is not installed" };
  const r = spawnSync("patchelf", ["--set-interpreter", stale.want, BIN], { stdio: "ignore" });
  if (r.status !== 0) return { ...stale, fixed: false, reason: "patchelf failed" };
  try { fs.writeFileSync(path.join(ROOT, ".direct-exec"), ""); } catch (e) { }
  return { ...stale, fixed: true };
}

function writeStamp(applied, skipped) {
  try {
    fs.writeFileSync(PATCH_STAMP, JSON.stringify({ at: new Date().toISOString(), applied, skipped }, null, 2) + "\n", { mode: 0o600 });
  } catch (e) { }
}

function apply() {
  // A moved install root breaks the interpreter before any content patch matters.
  try {
    const fixed = fixInterpreter();
    if (fixed) console.log(fixed.fixed ? "cc-patch: interpreter repointed " + fixed.was + " -> " + fixed.want : "cc-patch: interpreter still stale (" + fixed.reason + ")");
  } catch (e) { }
  let buf;
  try { buf = fs.readFileSync(BIN); } catch (e) { console.error("cc-patch: binary not found: " + BIN); process.exit(1); }
  const original = Buffer.from(buf);
  const defs = loadDefs();
  const applied = [], skipped = [];
  let changed = applyRegions(buf, defs.regions || [], applied, skipped);
  changed += applyText(buf, defs.text || [], applied, skipped);
  if (!changed) {
    ensureBackup(original);
    // Already patched (re-run, or a newer build): refresh the stamp so the launcher stops
    // treating the install as unpatched.
    if (isPatched(buf)) writeStamp([], skipped);
    console.log("cc-patch: nothing to do" + (skipped.length ? " [" + skipped.join(", ") + "]" : ""));
    return 0;
  }
  ensureBackup(original);
  try { atomicWrite(BIN, buf, 0o755); }
  catch (e) { console.error("cc-patch: cannot write binary (" + e.code + "). Quit Claude sessions and retry."); process.exit(1); }
  console.log("cc-patch: applied " + applied.join(", ") + (skipped.length ? "  (skipped: " + skipped.join(", ") + ")" : ""));
  writeStamp(applied, skipped);
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
  const wasPatchedBackup = !!(meta && meta.patched);
  if (!meta || !backup || meta.size !== backup.length || meta.sha256 !== sha256(backup)) {
    if (!force) { console.error("cc-patch: backup metadata is missing or does not match the backup file; refusing to revert (use --force to override)"); process.exit(1); }
  }
  try {
    const tmp = BIN + ".revert." + process.pid;
    fs.writeFileSync(tmp, backup, { mode: 0o755 });
    fs.renameSync(tmp, BIN);
    try { fs.unlinkSync(PATCH_STAMP); } catch (e2) { }
    console.log(wasPatchedBackup ? "cc-patch: reverted to the previous patched build (backup was created from a patched binary)" : "cc-patch: reverted to the unpatched binary");
  } catch (e) { console.error("cc-patch: revert failed: " + e.message); process.exit(1); }
}

// Run only as a CLI. Importing this module must have no side effects: a test that imported
// it used to apply patches and call process.exit, killing the test runner.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const cmd = process.argv[2] || "--apply";
if (cmd === "--apply") process.exit(apply());
else if (cmd === "--status" || cmd === "--check") status();
else if (cmd === "--revert") revert();
else console.log("usage: cc-patch [--apply|--status|--revert]");
}