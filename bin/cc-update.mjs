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
import { buildVersion, labelVersion } from "../scripts/version.mjs";
import { createProgress, banner, step, info } from "./cc-ui.mjs";

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
  if (!local || !remote) return false;
  if (local.sha && remote.sha && local.sha === remote.sha) return false;
  const l = local.updatedAt && new Date(local.updatedAt).getTime();
  const r = remote.updatedAt && new Date(remote.updatedAt).getTime();
  if (Number.isFinite(l) && Number.isFinite(r)) return r > l;
  // Legacy stamps without a commit date: fall back to sha difference.
  if (local.sha && remote.sha) return local.sha !== remote.sha;
  return semverNewer(remote.version, local.version);
}

export async function remoteInfo({ repo = DEFAULT_REPO, fetchImpl = fetch } = {}) {
  const headers = { "user-agent": "cc-termux" };
  let sha = null;
  let version = null;
  let updatedAt = null;
  let commits = [];
  // The commit atom feed is public, stable per commit and not API rate-limited.
  try {
    const r = await fetchImpl("https://github.com/" + repo + "/commits/main.atom", { headers, signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const text = await r.text();
      const re = /Grit::Commit\/([0-9a-f]{40})[\s\S]*?<updated>([^<]+)<\/updated>/g;
      let m;
      while ((m = re.exec(text)) !== null) commits.push({ sha: m[1], updatedAt: m[2] });
      if (commits.length) { sha = commits[0].sha; updatedAt = commits[0].updatedAt; }
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
  return { sha, version, updatedAt, commits };
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

export async function latestClaudeVersion({ fetchImpl = fetch } = {}) {
  const r = await fetchImpl("https://registry.npmjs.org/@anthropic-ai/claude-code/latest", { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("registry HTTP " + r.status);
  return (await r.json()).version || null;
}

export async function claudeCodeUpToDate({ root = DEFAULT_ROOT, fetchImpl = fetch, minBinaryBytes = 5 * 1024 * 1024 } = {}) {
  const bin = path.join(root, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin");
  const js = path.join(root, "js", "cli.js");
  let localVersion = "";
  try { localVersion = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(); } catch (e) { }
  if (!localVersion) return { upToDate: false, reason: "no installed version" };
  if (localVersion.endsWith("-js")) {
    return { upToDate: fs.existsSync(js), localVersion, reason: fs.existsSync(js) ? "js build present" : "js build missing" };
  }
  if (!fs.existsSync(bin)) return { upToDate: false, localVersion, reason: "binary missing" };
  if (fs.statSync(bin).size < minBinaryBytes) return { upToDate: false, localVersion, reason: "binary too small" };
  let remoteVersion = null;
  try { remoteVersion = await latestClaudeVersion({ fetchImpl }); }
  catch (e) {
    // No metadata: keep the working binary instead of re-downloading 150 MB blindly.
    return { upToDate: true, localVersion, reason: "registry unreachable - keeping installed binary" };
  }
  if (!remoteVersion) return { upToDate: false, localVersion, reason: "no registry version" };
  return { upToDate: localVersion === remoteVersion, localVersion, remoteVersion, reason: localVersion === remoteVersion ? "up to date" : "new version available" };
}

export async function selfUpdate({ root = DEFAULT_ROOT, repo = DEFAULT_REPO, archivePath = null, redownload = false, fetchImpl = fetch } = {}) {
  if (!process.env.CC_TERMUX_NO_BANNER) {
    banner(["cc-termux updater", "Code is fetched from GitHub; Claude Code itself is installed", "from Anthropic's official npm registry when a new version is needed."]);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-update-"));
  const tgz = path.join(tmp, "src.tgz");
  let targetSha = null;
  let targetDate = null;
  try {
    if (archivePath) {
      fs.copyFileSync(archivePath, tgz);
    } else {
      // Resolve the commit first, then download that exact commit. Downloading "main"
      // can serve a cached archive that is older than the atom feed and cause an
      // endless "update available" loop.
      try { const info = await remoteInfo({ repo, fetchImpl }); targetSha = info.sha || null; targetDate = info.updatedAt || null; } catch (e) { }
      const local = localInfo(root);
      if (!redownload && local.updatedAt && targetDate && new Date(targetDate).getTime() < new Date(local.updatedAt).getTime()) {
        step("remote feed is older than the installed build - not downgrading");
        return false;
      }
      const url = targetSha
        ? "https://codeload.github.com/" + repo + "/tar.gz/" + targetSha
        : "https://codeload.github.com/" + repo + "/tar.gz/refs/heads/main";
      if (targetSha) step("updating to commit " + targetSha.slice(0, 7));
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error("download HTTP " + r.status);
      const total = Number(r.headers.get("content-length")) || 0;
      const prog = createProgress("cc-termux source archive from GitHub", { stream: process.stderr });
      const chunks = [];
      let received = 0;
      for await (const chunk of r.body) { chunks.push(Buffer.from(chunk)); received += chunk.length; prog.update(received, total); }
      fs.writeFileSync(tgz, Buffer.concat(chunks));
      prog.done({ ok: true, message: (received / 1024).toFixed(1) + " kB" });
    }
    const src = path.join(tmp, "src");
    fs.mkdirSync(src, { recursive: true });
    extractTgz(tgz, src);
    const installer = findInstaller(src);
    if (!installer) throw new Error("install.mjs missing in archive (contents: " + fs.readdirSync(src).join(", ") + ")");
    let codeOnly = false;
    if (!redownload) {
      try {
        const state = await claudeCodeUpToDate({ root });
        codeOnly = state.upToDate;
        step("Claude Code " + (state.localVersion || "?") + " - " + state.reason);
        if (codeOnly) info("Only cc-termux files and UI patches will be updated; the Claude Code binary stays as is.");
        else info("A newer Claude Code will be downloaded from registry.npmjs.org.");
      } catch (e) { }
    }
    const args = [installer, "--root", root, "--no-setup"];
    if (codeOnly) args.push("--code-only");
    const env = { ...process.env, CC_TERMUX_NO_BANNER: codeOnly ? "1" : "" };
    if (targetSha) env.CC_TERMUX_COMMIT_SHA = targetSha;
    if (typeof targetDate !== "undefined" && targetDate) env.CC_TERMUX_COMMIT_DATE = targetDate;
    const res = spawnSync(process.execPath, args, { stdio: "inherit", env });
    if (res.status !== 0) throw new Error("installer exited with " + res.status);
    let sha = targetSha;
    if (!sha) { try { sha = (await remoteInfo({ repo, fetchImpl })).sha; } catch (e) { } }
    const pkgPath = path.join(path.dirname(installer), "package.json");
    const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, "utf8")) : { version: "unknown" };
    const stamp = { version: buildVersion(pkg.version, sha || ""), baseVersion: pkg.version, sha, installedAt: new Date().toISOString() };
    if (typeof targetDate !== "undefined" && targetDate) stamp.updatedAt = targetDate;
    fs.writeFileSync(path.join(root, "cc-termux.json"), JSON.stringify(stamp, null, 2) + "\n");
    try { fs.rmSync(path.join(root, "update-check.json"), { force: true }); } catch (e) { }
    step("cc-termux updated to " + buildVersion(pkg.version, sha || "") + (codeOnly ? " (Claude Code binary kept)" : " (Claude Code binary reinstalled)"));
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
      if (r.available) console.log("cc-termux update available: " + labelVersion(r.local.version, r.local.sha) + " -> " + labelVersion(r.remote.version, r.remote.sha) + "  (run: cc-termux update)");
      else console.log("cc-termux is up to date (" + labelVersion(r.local.version, r.local.sha) + ")");
    }).catch((e) => { console.error("cc-termux: update check failed: " + e.message); process.exit(1); });
  } else if (arg === "--self-update") {
    selfUpdate({ root, redownload: process.argv.includes("--redownload") }).catch((e) => { console.error("cc-termux: update failed: " + e.message); process.exit(1); });
  } else {
    console.log("usage: cc-update [--check|--self-update]");
  }
}