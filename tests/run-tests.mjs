#!/usr/bin/env node
// Run test files sequentially: the gateway tests start servers, so parallel files
// can starve slow devices and produce false timeouts. Optional args filter by name.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort()
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)));
if (!files.length) { console.error("no test files matched: " + filters.join(", ")); process.exit(1); }
let failed = 0;
for (const f of files) {
  console.log("\n# " + f);
  const r = spawnSync(process.execPath, ["--test", path.join(dir, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);