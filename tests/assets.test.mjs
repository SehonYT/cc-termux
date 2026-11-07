import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const r = spawnSync(process.execPath, [path.join(repo, "install.mjs"), "--list-assets"], { encoding: "utf8" });
assert.equal(r.status, 0, r.stderr);
const assets = new Set(r.stdout.trim().split("\n").filter(Boolean));

function walk(dir) {
  const out = [];
  const abs = path.join(repo, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = dir + "/" + entry.name;
    if (entry.isDirectory()) out.push(...walk(child));
    else if (entry.isFile() && !/\.(bak|orig|log|tmp)$/.test(entry.name)) out.push(child);
  }
  return out;
}

test("installer ships every runtime file (catches forgotten modules)", () => {
  const runtime = ["bin", "proxy", "commands", "scripts"].flatMap(walk);
  for (const f of runtime) assert.ok(assets.has(f), "not shipped by installer: " + f);
  assert.ok(assets.has("bin/cc-perf.mjs"), "cc-perf.mjs regression");
});

test("every relative import of a shipped file is shipped too", () => {
  const shipped = [...assets].filter((f) => f.endsWith(".mjs") || f.endsWith(".js") || f === "bin/cc-termux");
  const re = /(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
  for (const rel of shipped) {
    const abs = path.join(repo, rel);
    let text = "";
    try { text = fs.readFileSync(abs, "utf8"); } catch (e) { continue; }
    let m;
    while ((m = re.exec(text)) !== null) {
      const target = path.resolve(path.dirname(abs), m[1]);
      const relTarget = path.relative(repo, target).split(path.sep).join("/");
      assert.ok(!relTarget.startsWith(".."), rel + " imports outside the repo: " + m[1]);
      assert.ok(fs.existsSync(target), rel + " imports a missing file: " + m[1]);
      assert.ok(assets.has(relTarget), rel + " imports " + relTarget + " but the installer does not ship it");
    }
  }
});
