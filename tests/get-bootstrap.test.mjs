import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("get.sh works without a controlling terminal (CI/pipe)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-get-"));
  try {
    const src = path.join(tmp, "src", "cc-termux-main");
    fs.mkdirSync(path.join(src, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(src, "scripts", "ensure-node.sh"), "ensure_node() { NODE=node; export NODE; }\n");
    fs.writeFileSync(path.join(src, "install.mjs"), [
      "import fs from \"node:fs\";",
      "const i = process.argv.indexOf(\"--root\");",
      "fs.writeFileSync((i > 0 ? process.argv[i + 1] : \".\") + \"/marker\", \"ran\");",
    ].join("\n"));
    const archive = path.join(tmp, "src.tgz");
    const packed = spawnSync("tar", ["-czf", archive, "-C", path.join(tmp, "src"), "cc-termux-main"]);
    if (packed.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); return; }
    const root = path.join(tmp, "root");
    fs.mkdirSync(root, { recursive: true });
    const env = { ...process.env, CC_TERMUX_ARCHIVE: archive, HOME: tmp };
    const r = spawnSync("sh", [path.join(repo, "get.sh"), "--root", root], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(r.status, 0, "stderr: " + r.stderr);
    assert.ok(fs.existsSync(path.join(root, "marker")), "installer did not run");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});