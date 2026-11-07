#!/usr/bin/env node
// Update checking and self-update for cc-termux itself (not the Claude Code binary).
//
// Installed state lives in <root>/cc-termux.json: { version, sha, installedAt }.
// Remote state is the latest commit sha on main plus package.json version.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractTgz } from "./cc-tar.mjs";

export const DEFAULT_REPO = process.env.CC_TERMUX_REPO || "SehonYT/cc-termux";
export const DEFAULT_ROOT = path.join(os.homedir(), ".local", "share", "cc-termux");

export function localInfo(root = DEFAULT_ROOT) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "cc-termux.json"), "utf8")); }
  catch (e) { return { version: "0.0.0", sha: null }; }
}

export function semverNewer(remote, local) {
  const a = String(remote || "0.0.0").split(".").map(Number);
  const b = String(local || "0.0.0").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

export function isNewer(local, remote) {
  if (local && local.sha && remote && remote.sha) return local.sha !== remote.sha;
  return semverNewer(remote && remote.version, local && local.version);
}

export async function remoteInfo({ repo = DEFAULT_REPO, fetchImpl = fetch } = {}) {
  const headers = { "user-agent": "cc-termux" };
  let sha = null;
  let version = null;
  // The commit atom feed is public, stable per commit and not API rate-limited.
  try {
    const r = await fetchImpl("https://github.com/" + repo + "/commits/main.atom", { headers, signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const text = await r.text();
      const m = /Grit::Commit\/([0-9a-f]{40})/.exec(text);
      if (m) sha = m[1];
    }
  } catch (e) { }
  try {
    const r = await fetchImpl("https://raw.githubusercontent.com/" + repo + "/main/package.json", { headers, signal: AbortSignal.timeout(5000) });
    if (r.ok) version = (await r.json()).version || null;
  } catch (e) { }
  if (!sha) {
    try {
      const r = await fetchImpl("https://api.github.com/repos/" + repo + "/commits/main", { headers, signal: AbortSignal.timeout(5000) });
      if (r.ok) sha = (await r.json()).sha || null;
    } catch (e) { }
  }
  return { sha, version };
}
export async function check({ root = DEFAULT_ROOT, repo = DEFAULT_REPO, fetchImpl = fetch, cacheTtlMs = 12 * 3600 * 1000 } = {}) {
  const local = localInfo(root);
  const cacheFile = path.join(root, "update-check.json");
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (Date.now() - new Date(cache.at).getTime() < cacheTtlMs) {
      return { ...cache, local, available: isNewer(local, cache.remote), cached: true };
    }
  } catch (e) { }
  const remote = await remoteInfo({ repo, fetchImpl });
  const available = isNewer(local, remote);
  try { fs.writeFileSync(cacheFile, JSON.stringify({ at: new Date().toISOString(), remote }) + "\n"); } catch (e) { }
  return { local, remote, available, cached: false };
}

export function findInstaller(dir, depth = 0) {
  if (depth > 3) return null;
  try {
    if (fs.existsSync(path.join(dir, "install.mjs"))) return path.join(dir, "install.mjs");
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const found = findInstaller(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
  } catch (e) { }
  return null;
}

export async function selfUpdate({ root = DEFAULT_ROOT, repo = DEFAULT_REPO } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-update-"));
  const tgz = path.join(tmp, "src.tgz");
  try {
    const r = await fetch("https://codeload.github.com/" + repo + "/tar.gz/refs/heads/main", { signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error("download HTTP " + r.status);
    fs.writeFileSync(tgz, Buffer.from(await r.arrayBuffer()));
    const src = path.join(tmp, "src");
    fs.mkdirSync(src, { recursive: true });
    extractTgz(tgz, src);
    const installer = findInstaller(src);
    if (!installer) throw new Error("install.mjs missing in archive (contents: " + fs.readdirSync(src).join(", ") + ")");
    const res = spawnSync(process.execPath, [installer, "--root", root], { stdio: "inherit" });
    if (res.status !== 0) throw new Error("installer exited with " + res.status);
    let sha = null;
    try { sha = (await remoteInfo({ repo })).sha; } catch (e) { }
    const pkgPath = path.join(path.dirname(installer), "package.json");
    const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, "utf8")) : { version: "unknown" };
    fs.writeFileSync(path.join(root, "cc-termux.json"), JSON.stringify({ version: pkg.version, sha, installedAt: new Date().toISOString() }, null, 2) + "\n");
    console.log("cc-termux: updated to " + pkg.version + (sha ? " (" + sha.slice(0, 7) + ")" : ""));
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  const rootIdx = process.argv.indexOf("--root");
  const root = rootIdx > 0 ? process.argv[rootIdx + 1] : DEFAULT_ROOT;
  if (arg === "--check") {
    check({ root, cacheTtlMs: 0 }).then((r) => {
      if (r.available) console.log("cc-termux update available: " + (r.local.version || "?") + " -> " + (r.remote.version || r.remote.sha.slice(0, 7)) + "  (run: cc-termux update)");
      else console.log("cc-termux is up to date (" + (r.local.version || "unknown") + ")");
    }).catch((e) => { console.error("cc-termux: update check failed: " + e.message); process.exit(1); });
  } else if (arg === "--self-update") {
    selfUpdate({ root }).catch((e) => { console.error("cc-termux: update failed: " + e.message); process.exit(1); });
  } else {
    console.log("usage: cc-update [--check|--self-update]");
  }
}