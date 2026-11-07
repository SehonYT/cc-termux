#!/usr/bin/env node
// Run test files sequentially: the gateway tests start servers, so parallel files
// can starve slow devices and produce false timeouts.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();
let failed = 0;
for (const f of files) {
  console.log("\n# " + f);
  const r = spawnSync(process.execPath, ["--test", path.join(dir, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);