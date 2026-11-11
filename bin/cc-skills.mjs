#!/usr/bin/env node
// Installs the cc-termux skill pack into Claude Code's skills directory.
// A skill is a folder with a SKILL.md; the catalog lives in skills/catalog.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installRoot, claudeDir } from "./cc-paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK_DIR = path.join(installRoot(), "skills");

function catalogDir() {
  // Installed layout first, then the repo layout (tests and local runs).
  for (const dir of [PACK_DIR, path.join(HERE, "..", "skills")]) {
    if (fs.existsSync(path.join(dir, "catalog.json"))) return dir;
  }
  return PACK_DIR;
}

export function loadCatalog() {
  try {
    return JSON.parse(fs.readFileSync(path.join(catalogDir(), "catalog.json"), "utf8"));
  } catch (e) {
    return { version: 1, skills: [] };
  }
}

export function skillsTarget() {
  return path.join(claudeDir(), "skills");
}

// A skill is a directory holding SKILL.md, which is all Claude Code needs.
export function isValidSkill(dir) {
  try { return fs.statSync(path.join(dir, "SKILL.md")).isFile(); } catch (e) { return false; }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

export function installSkills({ only = null, force = true } = {}) {
  const catalog = loadCatalog();
  const src = catalogDir();
  const target = skillsTarget();
  const installed = [];
  const skipped = [];
  for (const skill of catalog.skills) {
    if (only && !only.includes(skill.id)) continue;
    const from = path.join(src, skill.dir);
    if (!isValidSkill(from)) { skipped.push({ id: skill.id, reason: "SKILL.md missing" }); continue; }
    const to = path.join(target, skill.name);
    try {
      if (fs.existsSync(to) && !force) { skipped.push({ id: skill.id, reason: "already installed" }); continue; }
      copyDir(from, to);
      installed.push(skill.id);
    } catch (e) {
      skipped.push({ id: skill.id, reason: e.message });
    }
  }
  return { installed, skipped, target };
}

export function removeSkills({ only = null } = {}) {
  const catalog = loadCatalog();
  const target = skillsTarget();
  const removed = [];
  for (const skill of catalog.skills) {
    if (only && !only.includes(skill.id)) continue;
    const dir = path.join(target, skill.name);
    // Only remove a directory this pack owns: it must hold our SKILL.md.
    if (!isValidSkill(dir)) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(skill.id); } catch (e) { }
  }
  return { removed, target };
}

export function skillStatus() {
  const catalog = loadCatalog();
  const target = skillsTarget();
  return catalog.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    license: skill.license,
    installed: isValidSkill(path.join(target, skill.name)),
  }));
}

export function formatSkills(status) {
  if (!status.length) return "no skills in the pack";
  const width = Math.max(...status.map((s) => s.name.length));
  return status.map((s) => (s.installed ? "  + " : "  - ") + s.name.padEnd(width) + "  " + s.description).join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] || "status";
  const args = process.argv.slice(3);
  if (cmd === "status" || cmd === "list") {
    const status = skillStatus();
    if (args.includes("--json")) { console.log(JSON.stringify(status, null, 2)); process.exit(0); }
    console.log("skills in " + skillsTarget() + ":");
    console.log(formatSkills(status));
    console.log();
    console.log("  + installed   - not installed");
  } else if (cmd === "install") {
    const only = args.filter((a) => !a.startsWith("-"));
    const r = installSkills({ only: only.length ? only : null });
    console.log("installed " + r.installed.length + " skill(s) into " + r.target + (r.installed.length ? ": " + r.installed.join(", ") : ""));
    for (const s of r.skipped) console.log("  skipped " + s.id + ": " + s.reason);
  } else if (cmd === "remove" || cmd === "uninstall") {
    const only = args.filter((a) => !a.startsWith("-"));
    const r = removeSkills({ only: only.length ? only : null });
    console.log("removed " + r.removed.length + " skill(s)" + (r.removed.length ? ": " + r.removed.join(", ") : ""));
  } else {
    console.log("usage: cc-skills [status|install [id...]|remove [id...]]");
  }
}
