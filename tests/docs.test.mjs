import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readmePath = path.join(root, "README.md");
const readme = fs.readFileSync(readmePath, "utf8");

function h2s(text) {
  return text.split("\n").filter((l) => /^## /.test(l)).map((l) => l.slice(3).trim());
}

function markdownTargets(text) {
  const targets = [];
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) targets.push(m[1]);
  for (const m of text.matchAll(/<img\s+[^>]*src="([^"]+)"/g)) targets.push(m[1]);
  return targets;
}

function assertRelativeLinksResolve(file, text) {
  const dir = path.dirname(file);
  for (const target of markdownTargets(text)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const clean = decodeURIComponent(target.split("#")[0]);
    if (!clean) continue;
    const resolved = path.resolve(dir, clean);
    assert.ok(fs.existsSync(resolved), file + ": link target does not exist: " + target);
  }
}

test("README keeps the showcase structure", () => {
  assert.deepEqual(h2s(readme), [
    "Quick start",
    "Features",
    "Providers",
    "Usage",
    "Commands",
    "How it works",
    "Configuration",
    "Security",
    "Platform support",
    "Updates and self-repair",
    "Manual install",
    "Development",
    "Limitations",
    "Community",
    "License",
  ]);
});

test("README has a logo, the badge set and the one-line installers", () => {
  assert.match(readme, /<img src="assets\/logo\.png"[^>]*>/, "logo must be shown");
  assert.match(readme, /img\.shields\.io\/github\/actions\/workflow\/status\/SehonYT\/cc-termux\/ci\.yml/, "CI badge");
  assert.match(readme, /img\.shields\.io\/badge\/license-MIT/, "license badge");
  assert.match(readme, /img\.shields\.io\/badge\/node-/, "node badge");
  assert.match(readme, /discord\.gg\/AF8zvEDcSG/, "Discord invite");
  assert.match(readme, /https:\/\/raw\.githubusercontent\.com\/SehonYT\/cc-termux\/main\/get\.sh/, "POSIX installer");
  assert.match(readme, /https:\/\/raw\.githubusercontent\.com\/SehonYT\/cc-termux\/main\/get\.ps1/, "Windows installer");
});

test("README links every detailed document and does not duplicate sections", () => {
  for (const doc of ["docs/ARCHITECTURE.md", "docs/TROUBLESHOOTING.md", "SECURITY.md", "CONTRIBUTING.md", "LICENSE", "NOTICE", "tests/README.md"]) {
    const md = readme.includes("](" + doc + ")");
    const html = readme.includes('href="' + doc + '"');
    assert.ok(md || html, "README must link " + doc);
  }
  const headings = h2s(readme);
  assert.equal(new Set(headings).size, headings.length, "duplicate H2 headings in README");
});

test("README markdown links resolve to real files", () => {
  assertRelativeLinksResolve(readmePath, readme);
});

test("docs are well formed and their links resolve", () => {
  const docs = ["README.md", "tests/README.md", "SECURITY.md", "CONTRIBUTING.md", "NOTICE",
    path.join("docs", "ARCHITECTURE.md"), path.join("docs", "TROUBLESHOOTING.md")];
  for (const rel of docs) {
    const file = path.join(root, rel);
    const text = fs.readFileSync(file, "utf8");
    if (rel === "README.md") assert.match(text, /<h1>cc-termux<\/h1>/);
    else if (rel !== "NOTICE") assert.match(text, /^# /, rel + " must start with an H1 title");
    const fences = text.split("\n").filter((l) => /^\s*```/.test(l)).length;
    assert.equal(fences % 2, 0, rel + " has an unclosed code fence");
    assertRelativeLinksResolve(file, text);
    assert.doesNotMatch(text, /\b(TBD|FIXME|TODO)\b/, rel + " must not contain placeholders");
  }
});

test("every test suite is documented in tests/README.md", () => {
  const suites = fs.readdirSync(path.join(root, "tests")).filter((f) => f.endsWith(".test.mjs")).sort();
  const table = fs.readFileSync(path.join(root, "tests", "README.md"), "utf8");
  for (const suite of suites) assert.ok(table.includes("\`" + suite + "\`"), "tests/README.md must list " + suite);
  // and the other direction: no stale rows pointing at removed suites
  for (const m of table.matchAll(/\`([\w-]+\.test\.mjs)\`/g)) {
    assert.ok(suites.includes(m[1]), "tests/README.md lists a suite that no longer exists: " + m[1]);
  }
});
