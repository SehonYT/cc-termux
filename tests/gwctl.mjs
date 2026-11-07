#!/usr/bin/env node
// test helper: stop/start the gateway reliably (finds it via /proc, not pidfiles)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CFG = process.argv[3] || process.env.CC_TERMUX_CONFIG || path.join(ROOT, 'tests', 'config.mock.json');
const PORT = 8788;

function findPids() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let cmd = '';
    try { cmd = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8'); } catch { continue; }
    if (cmd.includes('proxy/server.mjs') && Number(d) !== process.pid) out.push(Number(d));
  }
  return out;
}

async function health() {
  try { const r = await fetch('http://127.0.0.1:' + PORT + '/health'); return await r.json(); } catch { return null; }
}

const cmd = process.argv[2] || 'restart';
if (cmd === 'stop' || cmd === 'restart') {
  for (const pid of findPids()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await new Promise(r => setTimeout(r, 500));
}
if (cmd === 'start' || cmd === 'restart' || cmd === 'ensure') {
  if ((await health()) && cmd === 'ensure') { console.log(JSON.stringify(await health())); process.exit(0); }
  const log = fs.openSync(path.join(os.homedir(), '.cache', 'cc-termux', 'gateway.log'), 'a');
  const child = spawn('node', [path.join(ROOT, 'proxy', 'server.mjs')], {
    detached: true, stdio: ['ignore', log, log], env: { ...process.env, CC_TERMUX_CONFIG: CFG } });
  child.unref();
  for (let i = 0; i < 100; i++) { const h = await health(); if (h) { console.log(JSON.stringify(h)); process.exit(0); } await new Promise(r => setTimeout(r, 100)); }
  console.error('gateway failed to start'); process.exit(1);
}
if (cmd === 'status') { console.log(JSON.stringify(await health())); }