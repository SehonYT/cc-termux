#!/usr/bin/env node
// Optional byte patches for the installed Claude Code binary (terminal UI strings).
// Patches are equal-length replacements, anchored to known release strings; missing
// anchors are skipped rather than corrupting the binary.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.env.CC_TERMUX_ROOT || path.join(os.homedir(), ".local", "share", "cc-termux");
const BIN = path.join(ROOT, "bin", "claude.bin");
const BACKUP = BIN + ".orig";

const TEXT_PATCHES = [
  {
    id: "provider-command",
    description: "Turn the removed /agents command into /provider",
    find: 'name:"agents",description:"(removed) Ask Claude to create/manage subagents, or edit .claude/agents/"',
    replace: 'name:"provider",description:"Switch the active LLM provider with a picker"',
  },
  {
    id: "picker-title",
    description: "Rename the /model picker title to a provider-aware one",
    find: "Switch between Claude models",
    replace: "Switch between AI providers ",
  },
  {
    id: "picker-hint",
    description: "Explain provider rows vs model rows in the picker hint",
    find: "For other/previous model names, specify with --model.",
    replace: "Provider rows switch provider, model rows apply now.    ",
  },
];

const REGION_PATCHES = [
  {
    id: "provider-handler",
    description: "Route the provider command to the cc-termux picker (ccp)",
    start: "var Ukr=async()=>",
    end: ',jkr={type:"local",name:',
    replace: 'var Ukr=async()=>{try{Bun.spawnSync(["ccp"],{stdio:"inherit"})}catch(e){}return{type:"text",value:"provider picker closed"}}',
  },
];

const read = () => fs.readFileSync(BIN);
const padTo = (s, n) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

function applyText(buf, applied, skipped) {
  let changed = 0;
  for (const p of TEXT_PATCHES) {
    const find = Buffer.from(p.find);
    const repl = Buffer.from(padTo(p.replace, p.find.length));
    const hits = [];
    let i = buf.indexOf(find);
    while (i >= 0) { hits.push(i); i = buf.indexOf(find, i + 1); }
    if (!hits.length) {
      if (buf.indexOf(repl) >= 0) skipped.push(p.id + " (already patched)");
      else skipped.push(p.id + " (anchor missing)");
      continue;
    }
    for (const at of hits) repl.copy(buf, at);
    changed += hits.length;
    applied.push(p.id + (hits.length > 1 ? " x" + hits.length : ""));
  }
  return changed;
}

function applyRegions(buf, applied, skipped) {
  let changed = 0;
  for (const p of REGION_PATCHES) {
    const startBuf = Buffer.from(p.start);
    const endBuf = Buffer.from(p.end);
    let at = buf.indexOf(startBuf);
    if (at < 0) { skipped.push(p.id + " (start anchor missing)"); continue; }
    let n = 0;
    while (at >= 0) {
      const endAt = buf.indexOf(endBuf, at);
      if (endAt < 0) { skipped.push(p.id + " (end anchor missing)"); break; }
      const len = endAt - at;
      if (p.replace.length > len) { skipped.push(p.id + " (replacement too long)"); break; }
      Buffer.from(padTo(p.replace, len)).copy(buf, at);
      n++;
      at = buf.indexOf(startBuf, at + len);
    }
    if (n) { changed += n; applied.push(p.id + (n > 1 ? " x" + n : "")); }
  }
  return changed;
}

function apply() {
  let buf;
  try { buf = read(); } catch { console.error("cc-patch: binary not found: " + BIN); process.exit(1); }
  const applied = [], skipped = [];
  let changed = applyRegions(buf, applied, skipped);
  changed += applyText(buf, applied, skipped);
  if (!changed) {
    console.log("cc-patch: nothing to do" + (skipped.length ? "  [" + skipped.join(", ") + "]" : ""));
    return 0;
  }
  if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, buf, { mode: 0o755 });
  try { fs.writeFileSync(BIN, buf, { mode: 0o755 }); }
  catch (e) { console.error("cc-patch: cannot write binary (" + e.code + "). Quit Claude sessions and retry."); process.exit(1); }
  console.log("cc-patch: applied " + applied.join(", ") + (skipped.length ? "  (skipped: " + skipped.join(", ") + ")" : ""));
  return 0;
}

function status() {
  let buf;
  try { buf = read(); } catch (e) { console.error("cc-patch: cannot read binary (" + e.code + ")"); process.exit(1); }
  for (const p of REGION_PATCHES) {
    const done = buf.indexOf(Buffer.from("Bun.spawnSync")) >= 0;
    const pending = buf.indexOf(Buffer.from(p.start)) >= 0;
    console.log("  " + (done ? "applied " : pending ? "pending " : "n/a     ") + p.id + "  - " + p.description);
  }
  for (const p of TEXT_PATCHES) {
    const done = buf.indexOf(Buffer.from(p.replace.trim())) >= 0;
    const pending = buf.indexOf(Buffer.from(p.find)) >= 0;
    console.log("  " + (done ? "applied " : pending ? "pending " : "n/a     ") + p.id + "  - " + p.description);
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