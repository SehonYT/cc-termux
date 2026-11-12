import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("status is friendly before any provider is configured", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-status-"));
  try {
    const r = spawnSync(process.execPath, [path.join(repo, "bin", "modelmesh"), "status"], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, HOME: home, USERPROFILE: home, MODELMESH_ROOT: repo, MODELMESH_CONFIG: path.join(home, "config.json") },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ENOENT|Cannot read/);
    assert.match(r.stdout, /no providers yet/);
    assert.match(r.stdout, /modelmesh (setup|update)/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("logs is friendly before the gateway has ever run", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-logs-"));
  try {
    const r = spawnSync(process.execPath, [path.join(repo, "bin", "modelmesh"), "logs"], {
      encoding: "utf8", timeout: 15000,
      env: { ...process.env, HOME: home, USERPROFILE: home, MODELMESH_ROOT: repo, MODELMESH_CONFIG: path.join(home, "config.json"), MODELMESH_CACHE: path.join(home, "cache") },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no gateway log yet/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("diagnose exits cleanly before setup", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-diag-"));
  try {
    const r = spawnSync(process.execPath, [path.join(repo, "bin", "modelmesh"), "diagnose"], {
      encoding: "utf8", timeout: 20000,
      env: { ...process.env, HOME: home, USERPROFILE: home, MODELMESH_ROOT: repo, MODELMESH_CONFIG: path.join(home, "config.json"), MODELMESH_CACHE: path.join(home, "cache") },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /modelmesh (setup|update)/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});