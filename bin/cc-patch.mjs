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

const ROOT = process.env.CC_TERMUX_ROOT || path.join(os.homedir(), ".local", "share", "cc-termux");
const BIN = path.join(ROOT, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin");
const BACKUP = BIN + ".orig";
const DEFS = path.join(ROOT, "patches.json");

function loadDefs() {
  try { return JSON.parse(fs.readFileSync(DEFS, "utf8")); }
  catch (e) { return { text: [], regions: [] }; }
}
const padTo = (s, n) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const asList = (v) => (Array.isArray(v) ? v : [v]);

function applyText(buf, patches, applied, skipped) {
  let changed = 0;
  for (const p of patches) {
    let hit = null;
    let already = false;
    for (const find of asList(p.find)) {
      const idx = buf.indexOf(Buffer.from(find));
      if (idx >= 0) { hit = find; break; }
      if (buf.indexOf(Buffer.from(padTo(p.replace, find.length))) >= 0) { already = true; break; }
    }
    if (!hit) { skipped.push(p.id + (already ? " (already patched)" : " (anchor missing)")); continue; }
    const find = Buffer.from(hit);
    const repl = Buffer.from(padTo(p.replace, hit.length));
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
      if (p.replace.length > len) { skipped.push(p.id + " (replacement longer than region)"); break; }
      Buffer.from(padTo(p.replace, len)).copy(buf, at);
      n++;
      at = buf.indexOf(startBuf, at + len);
    }
    if (n) { changed += n; applied.push(p.id + (n > 1 ? " x" + n : "")); }
    else skipped.push(p.id + " (no region matched)");
  }
  return changed;
}

function apply() {
  let buf;
  try { buf = fs.readFileSync(BIN); } catch (e) { console.error("cc-patch: binary not found: " + BIN); process.exit(1); }
  if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, Buffer.from(buf), { mode: 0o755 });
  const defs = loadDefs();
  const applied = [], skipped = [];
  let changed = applyRegions(buf, defs.regions || [], applied, skipped);
  changed += applyText(buf, defs.text || [], applied, skipped);
  if (!changed) { console.log("cc-patch: nothing to do" + (skipped.length ? " [" + skipped.join(", ") + "]" : "")); return 0; }
  try { fs.writeFileSync(BIN, buf, { mode: 0o755 }); }
  catch (e) { console.error("cc-patch: cannot write binary (" + e.code + "). Quit Claude sessions and retry."); process.exit(1); }
  console.log("cc-patch: applied " + applied.join(", ") + (skipped.length ? "  (skipped: " + skipped.join(", ") + ")" : ""));
  return 0;
}

function status() {
  let buf;
  try { buf = fs.readFileSync(BIN); } catch (e) { console.error("cc-patch: cannot read binary (" + e.code + ")"); process.exit(1); }
  const defs = loadDefs();
  for (const p of [...(defs.regions || []), ...(defs.text || [])]) {
    const appliedMarker = p.replace.trim().slice(0, 24);
    const applied = buf.indexOf(Buffer.from(appliedMarker)) >= 0;
    const anchor = asList(p.find || p.start)[0];
    const pending = buf.indexOf(Buffer.from(anchor)) >= 0;
    console.log("  " + (applied ? "applied " : pending ? "pending " : "n/a     ") + p.id + "  - " + (p.description || ""));
  }
}

function revert() {
  if (!fs.existsSync(BACKUP)) { console.error("cc-patch: no backup at " + BACKUP); process.exit(1); }
  fs.copyFileSync(BACKUP, BIN);
  fs.chmodSync(BIN, 0o755);
  console.log("cc-patch: reverted to the unpatched binary");
}

const cmd = process.argv[2] || "--apply";
if (cmd === "--apply") process.exit(apply());
else if (cmd === "--status" || cmd === "--check") status();
else if (cmd === "--revert") revert();
else console.log("usage: cc-patch [--apply|--status|--revert]");