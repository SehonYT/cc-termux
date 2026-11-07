#!/usr/bin/env node
// Syntax + fixture checks that run in CI (no network, no Claude Code required).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = [];
for (const dir of ["bin", "proxy", "scripts", "tests"]) {
  const p = path.join(root, dir);
  if (!fs.existsSync(p)) continue;
  for (const f of fs.readdirSync(p)) if (f.endsWith('.mjs') || f === 'cc-termux') files.push(path.join(p, f));
}
files.push(path.join(root, 'install.mjs'));

let failed = 0;
const shellFiles = ["get.sh", "install.sh", "scripts/ensure-node.sh"];
for (const f of shellFiles) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  const r = spawnSync("bash", ["-n", p], { stdio: "inherit" });
  if (r.status !== 0) { console.error("shell syntax error:", f); failed++; }
}

for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('syntax error:', f); failed++; }
}

for (const j of ['package.json', 'presets.json', 'config.example.json']) {
  try { JSON.parse(fs.readFileSync(path.join(root, j), 'utf8')); }
  catch (e) { console.error('invalid JSON:', j, e.message); failed++; }
}

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('checks passed (' + files.length + ' files)');
