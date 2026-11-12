#!/usr/bin/env node
// Installs the modelmesh skill pack into Claude Code's skills directory.
// Skills become the user's files, so an update records hashes and never overwrites an edit.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { installRoot, claudeDir } from "./cc-paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK_DIR = path.join(installRoot(), "skills");
const MANIFEST = ".modelmesh-pack.json";

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
function manifestPath() {
  return path.join(skillsTarget(), MANIFEST);
}

// A skill is a directory holding SKILL.md, which is all Claude Code needs.
export function isValidSkill(dir) {
  try { return fs.statSync(path.join(dir, "SKILL.md")).isFile(); } catch (e) { return false; }
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Every .md (and licence) file in a skill, with its content hash.
export function hashSkill(dir) {
  const out = {};
  const walk = (base, rel) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const full = path.join(base, entry.name);
      const key = rel ? rel + "/" + entry.name : entry.name;
      if (entry.isDirectory()) walk(full, key);
      else if (entry.isFile()) out[key] = sha(fs.readFileSync(full));
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return out;
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(manifestPath(), "utf8")); } catch (e) { return { version: 0, skills: {} }; }
}
function writeManifest(m) {
  try {
    fs.mkdirSync(skillsTarget(), { recursive: true });
    fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2) + "\n", { mode: 0o600 });
  } catch (e) { }
}

function copyDir(from, to, into = "") {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst, into);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

// What an update would do to one skill, without touching anything: unchanged, modified
// (the user edited it), partial (files are missing) or outdated (upstream added files).
export function compareSkill(skill) {
  const catalog = loadCatalog();
  const from = path.join(catalogDir(), skill.dir);
  const to = path.join(skillsTarget(), skill.name);
  const manifest = readManifest();
  const recorded = (manifest.skills || {})[skill.name];
  if (!isValidSkill(to)) return { state: "missing", changed: Object.keys(hashSkill(from)) };
  const current = hashSkill(to);
  if (!recorded) {
    // Installed before this pack recorded hashes: assume the user may have edited it.
    return { state: "unknown", changed: [] };
  }
  const files = Object.keys(current);
  const deleted = Object.keys(recorded.files || {}).filter((f) => !(f in current));
  const edited = files.filter((f) => recorded.files[f] && recorded.files[f] !== current[f]);
  // Files upstream has that the install lacks (new files in a newer pack version).
  const upstream = hashSkill(from);
  const added = Object.keys(upstream).filter((f) => !(f in current));
  if (edited.length) return { state: "modified", edited, deleted, added, changed: [] };
  if (deleted.length) return { state: "partial", edited, deleted, added, changed: [] };
  if (added.length) return { state: "outdated", edited, deleted, added, changed: added };
  return { state: "unchanged", edited: [], deleted: [], added: [], changed: [] };
}

// Install or update: writes what is missing, refreshes what is untouched, and keeps an
// edited skill unless force is set.
export async function installSkills({ only = null, force = false, record = true } = {}) {
  const catalog = loadCatalog();
  const src = catalogDir();
  const target = skillsTarget();
  const installed = [];
  const updated = [];
  const kept = [];
  const skipped = [];
  for (const skill of catalog.skills) {
    if (only && !only.includes(skill.id)) continue;
    const from = path.join(src, skill.dir);
    if (!isValidSkill(from)) { skipped.push({ id: skill.id, reason: "SKILL.md missing" }); continue; }
    const to = path.join(target, skill.name);
    const state = compareSkill(skill).state;
    try {
      if (state === "missing" || force || state === "unchanged" || state === "outdated" || state === "unknown") {
        if (state === "unknown" && !force) { kept.push({ id: skill.id, reason: "installed by an older version; kept as is" }); continue; }
        const existed = isValidSkill(to);
        copyDir(from, to);
        (existed ? updated : installed).push(skill.id);
      } else if (state === "modified" || state === "partial") {
        // Never rewrite an edited file, but restore what went missing: an edit is not a
        // reason to leave a skill broken.
        const cmp = compareSkill(skill);
        fs.mkdirSync(to, { recursive: true });
        const restored = [];
        for (const rel of [...(cmp.deleted || []), ...(cmp.added || [])]) {
          const s = path.join(from, rel);
          if (!fs.existsSync(s)) continue;
          fs.mkdirSync(path.dirname(path.join(to, rel)), { recursive: true });
          fs.copyFileSync(s, path.join(to, rel));
          restored.push(rel);
        }
        const edited = cmp.edited || [];
        if (restored.length) updated.push(skill.id + " (restored " + restored.join(", ") + ")" + (edited.length ? ", kept your edits" : ""));
        kept.push({ id: skill.id, reason: (edited.length ? "you edited " + edited.join(", ") : "local changes") + (restored.length ? ", missing files restored" : "; left alone") });
      }
    } catch (e) {
      skipped.push({ id: skill.id, reason: e.message });
    }
  }
  if (record) {
    // Keep the generated provider line in step with the code that implements the chain.
    try {
      const line = await providerChainSummary();
      if (line) await refreshGenerated("modelmesh-web", "SKILL.md", "chain:generated", line);
    } catch (e) { }
    recordManifest();
  }
  return { installed, updated, kept, skipped, target };
}

// Records what this pack wrote, so a later update can tell an edit from an upgrade.
export function recordManifest() {
  const catalog = loadCatalog();
  const manifest = { version: catalog.version || 1, pack: "modelmesh", at: new Date().toISOString(), skills: {} };
  for (const skill of catalog.skills) {
    const dir = path.join(skillsTarget(), skill.name);
    if (!isValidSkill(dir)) continue;
    manifest.skills[skill.name] = { id: skill.id, files: hashSkill(dir), source: skill.source };
  }
  writeManifest(manifest);
  return manifest;
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
  if (removed.length) recordManifest();
  return { removed, target };
}

export function skillStatus() {
  const catalog = loadCatalog();
  const target = skillsTarget();
  const manifest = readManifest();
  return catalog.skills.map((skill) => {
    const installed = isValidSkill(path.join(target, skill.name));
    const cmp = installed ? compareSkill(skill) : { state: "not installed" };
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      license: skill.license,
      installed,
      state: cmp.state,
      packVersion: manifest.version || 0,
      catalogVersion: catalog.version || 1,
    };
  });
}

// Skills whose shipped text describes a provider chain that has since changed.
export function staleContent() {
  const out = [];
  const chainFile = path.join(skillsTarget(), "modelmesh-web", "SKILL.md");
  try {
    const text = fs.readFileSync(chainFile, "utf8");
    const expected = providerChainSummary();
    if (!text.includes(expected)) out.push({ id: "modelmesh-web", reason: "provider chain changed since it was installed" });
  } catch (e) { }
  return out;
}

// One line naming the live chain, generated so the skill can never drift from the code.
// Generated at install time so the skill can never drift from the code that implements it.
export async function providerChainSummary() {
  try {
    const { WEB_PROVIDERS, PROVIDER_INFO } = await import("./cc-webproviders.mjs");
    const labels = WEB_PROVIDERS.filter((id) => !PROVIDER_INFO[id].antigravityOnly)
      .map((id) => PROVIDER_INFO[id].label.replace(/ \(.*\)$/, ""));
    const ag = WEB_PROVIDERS.find((id) => PROVIDER_INFO[id].antigravityOnly);
    const agLabel = ag ? PROVIDER_INFO[ag].label : "";
    return agLabel + ", then " + labels.join(", ");
  } catch (e) {
    return "";
  }
}

// Rewrites the one generated line inside a skill, leaving every hand-written word alone.
export async function refreshGenerated(skillName, file, marker, line) {
  const target = path.join(skillsTarget(), skillName, file);
  try {
    const text = fs.readFileSync(target, "utf8");
    if (!text.includes(marker) || !line) return false;
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.includes(marker));
    // The generated sentence sits on the line above the marker.
    if (at < 1) return false;
    const next = lines.slice();
    next[at - 1] = next[at - 1].replace(/^1\..*/, "1. " + line + ".");
    if (next[at - 1] === lines[at - 1]) return false;
    fs.writeFileSync(target, next.join("\n"));
    return true;
  } catch (e) { return false; }
}

// Vendored skills are pinned to a source path so a sync can fetch the current version and
// show a diff before anything is written. Generated at install time from the catalog.
export function vendoredSources() {
  return loadCatalog().skills
    .filter((s) => /raw\.githubusercontent\.com|github\.com/.test(s.source || "") && s.upstream)
    .map((s) => ({ id: s.id, name: s.name, dir: s.dir, source: s.source, upstream: s.upstream, license: s.license }));
}

// How far behind upstream we are, using the pinned commit rather than guessing.
export async function upstreamHead(repo, { fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl("https://api.github.com/repos/" + repo + "/commits?per_page=1", {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const head = Array.isArray(j) ? j[0] : null;
    if (!head || !head.sha) return null;
    const date = (head.commit && head.commit.committer && head.commit.committer.date) || null;
    return { sha: String(head.sha).slice(0, 12), date };
  } catch (e) { return null; }
}

// Files upstream has that this pack never pinned, so a new reference doc cannot go unnoticed.
export async function upstreamListing(tree, { fetchImpl = fetch } = {}) {
  if (!tree) return null;
  try {
    const r = await fetchImpl(tree, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j.filter((e) => e.type === "file").map((e) => e.name) : null;
  } catch (e) { return null; }
}

// Fetches each vendored file and reports what changed, writing nothing unless apply is set.
export async function syncUpstream({ only = null, apply = false, fetchImpl = fetch, checkUpstream = true, log = () => {} } = {}) {
  const target = skillsTarget();
  const results = [];
  for (const skill of vendoredSources()) {
    if (only && !only.includes(skill.id)) continue;
    const files = Array.isArray(skill.upstream.files) ? skill.upstream.files : [];
    // Some upstreams keep a licence at the repo root rather than beside the skill.
    const extra = Array.isArray(skill.upstream.extra) ? skill.upstream.extra : [];
    const changes = [];
    let behind = null, added = null;
    if (checkUpstream && skill.upstream.repo) {
      const head = await upstreamHead(skill.upstream.repo, { fetchImpl });
      if (head && skill.upstream.commit) {
        behind = head.sha === skill.upstream.commit
          ? { behind: 0, head: head.sha, pinned: skill.upstream.commit }
          : { behind: true, head: head.sha, pinned: skill.upstream.commit, date: head.date };
      } else if (head) {
        behind = { behind: null, head: head.sha, pinned: null };
      }
      const listing = await upstreamListing(skill.upstream.tree, { fetchImpl });
      const tracked = [...files, ...extra.map((e) => e.file)];
      if (listing) added = listing.filter((f) => !tracked.includes(f));
    }
    for (const file of [...files.map((f) => ({ file: f, url: skill.upstream.base.replace(/\/$/, "") + "/" + f })), ...extra]) {
      let text = null;
      try {
        const r = await fetchImpl(file.url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) { changes.push({ file: file.file, status: "fetch-failed", detail: "HTTP " + r.status }); continue; }
        text = await r.text();
      } catch (e) { changes.push({ file: file.file, status: "fetch-failed", detail: e.message.slice(0, 60) }); continue; }
      const dest = path.join(target, skill.name, file.file);
      let current = null;
      try { current = fs.readFileSync(dest, "utf8"); } catch (e) { }
      if (current === null) changes.push({ file: file.file, status: "missing", detail: "not installed" });
      else if (current === text) changes.push({ file: file.file, status: "same", detail: "" });
      else changes.push({ file: file.file, status: "different", detail: "upstream differs", next: text });
    }
    results.push({ id: skill.id, name: skill.name, changes, behind, added });
  }
  if (apply) {
    for (const r of results) {
      for (const c of r.changes) {
        if (c.status !== "different" && c.status !== "missing") continue;
        if (typeof c.next !== "string") continue;
        const dest = path.join(target, r.name, c.file);
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, c.next);
          log("updated " + r.id + "/" + c.file);
        } catch (e) { log("failed " + r.id + "/" + c.file + ": " + e.message); }
      }
    }
    recordManifest();
  }
  return results;
}

export function formatSync(results) {
  if (!results.length) return "  no vendored skills to sync";
  const lines = [];
  for (const r of results) {
    const changed = r.changes.filter((c) => c.status === "different");
    const missing = r.changes.filter((c) => c.status === "missing");
    const failed = r.changes.filter((c) => c.status === "fetch-failed");
    const state = failed.length ? "could not check (" + failed[0].detail + ")"
      : changed.length ? changed.length + " file(s) changed upstream"
      : missing.length ? missing.length + " file(s) missing locally"
      : r.behind && r.behind.behind ? "behind upstream (" + r.behind.pinned + " -> " + r.behind.head + ")"
      : "up to date";
    lines.push("  " + r.id.padEnd(18) + state);
    if (r.behind && r.behind.behind) {
      lines.push("      pinned " + r.behind.pinned + ", upstream head " + r.behind.head + (r.behind.date ? " (" + r.behind.date.slice(0, 10) + ")" : ""));
    }
    if (r.added && r.added.length) lines.push("      upstream also has: " + r.added.join(", "));
    for (const c of changed) lines.push("      ~ " + c.file);
    for (const c of missing) lines.push("      + " + c.file + " (not installed)");
  }
  return lines.join("\n");
}

export function formatSkills(status) {
  if (!status.length) return "no skills in the pack";
  const width = Math.max(...status.map((s) => s.name.length));
  const label = (s) => {
    if (!s.installed) return "-";
    if (s.state === "modified") return "!";
    if (s.state === "outdated" || s.state === "partial") return "^";
    return "+";
  };
  return status.map((s) => "  " + label(s) + " " + s.name.padEnd(width) + "  " + s.description).join("\n");
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
    console.log("  + installed   ^ update available   ! locally modified (kept)   - not installed");
  } else if (cmd === "install" || cmd === "update") {
    const only = args.filter((a) => !a.startsWith("-"));
    const force = args.includes("--force");
    const r = await installSkills({ only: only.length ? only : null, force });
    if (r.installed.length) console.log("installed: " + r.installed.join(", "));
    if (r.updated.length) console.log("updated:   " + r.updated.join(", "));
    for (const k of r.kept) console.log("kept:      " + k.id + " (" + k.reason + ")");
    for (const s of r.skipped) console.log("skipped:   " + s.id + " (" + s.reason + ")");
    if (!r.installed.length && !r.updated.length && !r.kept.length) console.log("nothing to do");
    if (r.kept.length) console.log("\nuse --force to overwrite a modified skill");
  } else if (cmd === "sync") {
    const only = args.filter((a) => !a.startsWith("-"));
    const apply = args.includes("--apply");
    const results = await syncUpstream({ only: only.length ? only : null, apply, log: (m) => console.log("  " + m) });
    console.log(formatSync(results));
    if (!apply) {
      const any = results.some((r) => r.changes.some((c) => c.status === "different" || c.status === "missing"));
      console.log();
      console.log(any ? "  run again with --apply to write the upstream version" : "  nothing to do");
    }
  } else if (cmd === "remove" || cmd === "uninstall") {
    const only = args.filter((a) => !a.startsWith("-"));
    const r = removeSkills({ only: only.length ? only : null });
    console.log("removed " + r.removed.length + " skill(s)" + (r.removed.length ? ": " + r.removed.join(", ") : ""));
  } else {
    console.log("usage: cc-skills [status|install [id...] [--force]|sync [id...] [--apply]|remove [id...]]");
  }
}
