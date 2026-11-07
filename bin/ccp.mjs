#!/usr/bin/env node
// Standalone provider picker. Draws directly on the terminal so it can be started from
// a shell, from Claude Code bash mode, or from a key binding.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const CFG = process.env.CC_TERMUX_CONFIG || path.join(HOME, ".config", "cc-termux", "config.json");
const ESC = String.fromCharCode(27);
const load = () => JSON.parse(fs.readFileSync(CFG, "utf8"));
const save = (c) => fs.writeFileSync(CFG, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
const composite = (p, id) => id ? "prov/" + p + "/" + id : id;

const cfg = load();
const list = Object.entries(cfg.providers || {}).filter(([, p]) => !p.hidden);
if (!list.length) { console.log("no providers configured - run cc-termux setup"); process.exit(1); }

if (!process.stdin.isTTY) {
  list.forEach(([n, p], i) => console.log((n === cfg.active ? "> " : "  ") + (i + 1) + ". " + n + "  " + (p.model || "")));
  process.exit(0);
}

let sel = Math.max(0, list.findIndex(([n]) => n === cfg.active));
const out = (s) => process.stdout.write(s);
const draw = () => {
  out(ESC + "[2J" + ESC + "[H");
  out("  cc-termux - provider picker\n\n");
  list.forEach(([name, p], i) => {
    const mark = i === sel ? "\u276f" : " ";
    const active = name === cfg.active ? " \u2714" : "  ";
    out("  " + mark + " " + (i + 1) + ". " + name.padEnd(14) + active + "  " + (p.model || "") + "\n");
  });
  out("\n  \u2191/\u2193 move \u00b7 enter select \u00b7 q cancel\n");
};

const cleanup = () => { try { process.stdin.setRawMode(false); } catch {} };
const finish = (name) => {
  if (name) {
    const p = cfg.providers[name];
    cfg.active = name;
    cfg.override = { provider: name, model: p.model || null };
    save(cfg);
    try {
      const sp = path.join(HOME, ".claude", "settings.json");
      const s = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf8")) : {};
      if (p.model) s.model = composite(name, p.model);
      fs.writeFileSync(sp, JSON.stringify(s, null, 2) + "\n");
    } catch {}
  }
  cleanup();
  out(ESC + "[2J" + ESC + "[H");
  console.log(name ? "\u2714 switched to " + name : "cancelled");
  process.exit(name ? 0 : 1);
};

draw();
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (buf) => {
  const k = buf.toString("utf8");
  if (k === "\u001b[A" || k === "k") { sel = (sel - 1 + list.length) % list.length; draw(); }
  else if (k === "\u001b[B" || k === "j") { sel = (sel + 1) % list.length; draw(); }
  else if (k === "\r" || k === "\n") { finish(list[sel][0]); }
  else if (k === "q" || k === "\u0003") { finish(null); }
  else if (/^[1-9]$/.test(k)) { const i = Number(k) - 1; if (i < list.length) finish(list[i][0]); }
});