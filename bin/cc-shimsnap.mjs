#!/usr/bin/env node
// Claude Code appends shims to every bash snapshot it generates: "find" is redefined to
// exec an embedded bfs, and "grep" to an embedded ugrep. On Termux/Android the embedded
// bfs dies with SIGSYS ("Bad system call") inside Claude Code's sandboxed shell, so every
// find call fails and agents get empty results - a silent false negative.
//
// This module rewrites that one function in existing and newly created snapshots so find
// is the real findutils binary again. The launcher spawns it detached at startup; it also
// works standalone (--once / --watch).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "# cc-termux find shim";
const REPLACEMENT = MARKER + " (embedded bfs exits with SIGSYS on Android)\n" +
  'function find { command find ${1+"$@"}; }\n';

export function snapshotDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "shell-snapshots");
}

/** Replace the bfs-backed find function; returns the new text (unchanged when not needed). */
export function patchSnapshotText(src) {
  if (typeof src !== "string" || src.includes(MARKER)) return src;
  const start = src.indexOf("function find {");
  if (start < 0) return src;
  const end = src.indexOf("function grep {", start);
  if (end < 0) return src;
  return src.slice(0, start) + REPLACEMENT + src.slice(end);
}

export function patchFile(file) {
  let src;
  try { src = fs.readFileSync(file, "utf8"); } catch (e) { return false; }
  const next = patchSnapshotText(src);
  if (next === src) return false;
  try {
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, next, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { return false; }
}

export function patchAll(dir = snapshotDir()) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith("snapshot-") && f.endsWith(".sh")); } catch (e) { return 0; }
  let n = 0;
  for (const f of files) if (patchFile(path.join(dir, f))) n++;
  return n;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = snapshotDir();
  patchAll(dir);
  if (!process.argv.includes("--once")) {
    const until = Date.now() + Number(process.env.CC_TERMUX_SHIM_WATCH_MS || 180000);
    // Keep the event loop alive (do NOT unref): this process must outlive the first
    // snapshot Claude Code writes, a few hundred milliseconds after it starts.
    const timer = setInterval(() => {
      patchAll(dir);
      if (Date.now() > until) { clearInterval(timer); process.exit(0); }
    }, 150);
  }
}
