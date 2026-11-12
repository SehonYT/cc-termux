#!/usr/bin/env node
// Run test files sequentially: the gateway tests start servers, so parallel files
// can starve slow devices and produce false timeouts. Optional args filter by name.
//
// Every file runs under a deadline. A test that hangs used to leave CI on a 15 minute
// runner timeout with no clue which test was stuck, which is exactly what happened on
// macOS: three jobs died at 15m0s and nothing said why.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort()
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)));
if (!files.length) { console.error("no test files matched: " + filters.join(", ")); process.exit(1); }

// Generous: the slowest file is a few seconds locally and under a minute on a slow runner.
const FILE_TIMEOUT_MS = Number(process.env.MODELMESH_TEST_TIMEOUT_MS || 180000);
// node:test's own per-test deadline, so a hung test names itself instead of the file.
// --test-timeout only exists from Node 20, and Node 18 is still supported, so probe for it
// rather than passing a flag that makes the runner refuse to start.
const TEST_TIMEOUT_MS = Number(process.env.MODELMESH_TEST_CASE_TIMEOUT_MS || 60000);
const supportsTestTimeout = spawnSync(process.execPath, ["--test-timeout=1000", "--test", "--help"], { stdio: "ignore" }).status === 0
  || !/bad option/.test(String(spawnSync(process.execPath, ["--test-timeout=1000", "-e", ""], { encoding: "utf8" }).stderr || ""));
const nodeArgs = supportsTestTimeout ? ["--test", "--test-timeout=" + TEST_TIMEOUT_MS] : ["--test"];

let failed = 0;
const timedOut = [];
for (const f of files) {
  console.log("\n# " + f);
  const r = spawnSync(process.execPath, [...nodeArgs, path.join(dir, f)], {
    stdio: "inherit",
    timeout: FILE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  // spawnSync reports a timeout as an ETIMEDOUT error rather than a status.
  if (r.error && r.error.code === "ETIMEDOUT") {
    console.error("# TIMEOUT after " + Math.round(FILE_TIMEOUT_MS / 1000) + "s: " + f + " (a test is hanging)");
    timedOut.push(f);
    failed++;
    continue;
  }
  if (r.status !== 0) failed++;
}

console.log();
if (timedOut.length) {
  console.error("timed out: " + timedOut.join(", "));
  console.error("raise MODELMESH_TEST_TIMEOUT_MS for a genuinely slow machine");
}
console.log(files.length + " file(s), " + (failed ? failed + " with failures" : "all passing"));
process.exit(failed ? 1 : 0);
