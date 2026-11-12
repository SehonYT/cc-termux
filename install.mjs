#!/usr/bin/env node
// Installer for Linux, macOS, Windows and Termux.
// Resolves the official Claude Code package, installs it, then writes shims and setup.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { detectTarget, nodeVersionOk, glibcTooOld } from "./bin/cc-platform.mjs";
import { extractTgz } from "./bin/cc-tar.mjs";
import { createProgress, banner, step, info } from "./bin/cc-ui.mjs";
import { installSkills, formatSkills, skillStatus } from "./bin/cc-skills.mjs";
import { PERF_PROMPT_LINES, perfDefaultAnswer, savePerfMode, shouldAskPerf } from "./bin/cc-perf.mjs";
import { ensurePathInRcFiles, prefixBinDir } from "./bin/cc-heal.mjs";
import { installRoot, configFile, cacheDir, claudeDir, isWindows } from "./bin/cc-paths.mjs";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argVal = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = argVal("--root", installRoot());
const CFG = configFile();
// Platform default root, ignoring a CC_TERMUX_ROOT override: only a canonical install may
// write user-wide shims, and temp/custom roots (tests, parallel checkouts) must stay isolated.
const DEFAULT_ROOT = installRoot({ ...process.env, CC_TERMUX_ROOT: "" });
const CHECK = has("--check");
const NO_SETUP = has("--no-setup");
const NO_SHIMS = has("--no-shims");
const RESET_CONFIG = has("--reset-config");
const CODE_ONLY = has("--code-only");
const TARBALL = argVal("--tarball", "");
const VERSION_ARG = argVal("--version", "");

const log = (m) => console.log("\x1b[36mcc-termux\x1b[0m " + m);
const fail = (m) => { console.error("\x1b[31merror\x1b[0m " + m); process.exit(1); };

function detectHostTarget() {
  let cpuinfo = "";
  try { cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8"); } catch (e) { }
  let t = detectTarget({
    platform: process.platform, arch: process.arch, cpuinfo,
    hasFile: (p) => fs.existsSync(p),
    forceJs: has("--force-js") || process.env.CC_TERMUX_FORCE_JS === "1",
  });
  if (process.platform === "linux" && t.pkg && !/-musl$/.test(t.pkg)) {
    const ldd = spawnSync("ldd", ["--version"], { encoding: "utf8" }).stdout || "";
    if (glibcTooOld(ldd)) t = { ...t, pkg: t.pkg + "-musl" };
  }
  return t;
}
async function latestVersion() {
  const r = await fetch("https://registry.npmjs.org/@anthropic-ai/claude-code/latest");
  if (!r.ok) throw new Error("registry HTTP " + r.status);
  return (await r.json()).version;
}

function run(cmd, argv, opts) {
  const r = spawnSync(cmd, argv, { stdio: "inherit", ...opts });
  return r.status === 0;
}

function extract(tgz, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const tarOk = spawnSync("tar", ["--version"], { stdio: "ignore" }).status === 0;
  if (tarOk) return spawnSync("tar", ["-xzf", tgz, "-C", dest], { stdio: "inherit" }).status === 0;
  try { extractTgz(tgz, dest); return true; } catch (e) { fail("extraction failed: " + e.message); }
}

async function npmIntegrity(name, version) {
  try {
    const r = await fetch("https://registry.npmjs.org/" + name + "/" + version, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.dist && j.dist.integrity) || null;
  } catch (e) { return null; }
}

function verifyIntegrity(file, integrity) {
  if (!integrity || !integrity.startsWith("sha512-")) return true;
  try {
    const hash = crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
    return hash === integrity.slice("sha512-".length);
  } catch (e) { return false; }
}

async function fetchText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  return await r.text();
}

async function download(url, file, label, integrity) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const total = Number(r.headers.get("content-length")) || 0;
      const prog = createProgress(label || ("downloading " + path.basename(file)), { stream: process.stderr });
      let received = 0;
      const out = fs.createWriteStream(file);
      const meter = new Transform({ transform(chunk, _enc, cb) { received += chunk.length; prog.update(received, total); cb(null, chunk); } });
      if (r.body && typeof r.body.getReader === "function") await pipeline(Readable.fromWeb(r.body), meter, out);
      else { const buf = Buffer.from(await r.arrayBuffer()); received = buf.length; fs.writeFileSync(file, buf); }
      if (integrity && !verifyIntegrity(file, integrity)) throw new Error("integrity check failed for " + url);
      prog.done({ ok: true, message: received + " bytes" });
      return received;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        const wait = 1000 * attempt;
        info("download attempt " + attempt + " failed (" + (e.name || e.message) + "), retrying in " + wait + "ms");
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw new Error("download failed: " + (lastErr && (lastErr.message || lastErr.name)) + " - " + url);
}

function runtimeAssets() {
  const out = new Set();
  for (const f of ["patches.json", "presets.json", "install.mjs", "install.sh", "install.ps1", "get.sh", "get.ps1", "package.json", "README.md", "LICENSE", "NOTICE"]) {
    if (fs.existsSync(path.join(SRC, f))) out.add(f);
  }
  const walk = (rel) => {
    const abs = path.join(SRC, rel);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = rel + "/" + entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && !/\.(bak|orig|log|tmp)$/.test(entry.name)) out.add(child);
    }
  };
  for (const dir of ["bin", "proxy", "commands", "scripts", "docs", "skills"]) walk(dir);
  return [...out].sort();
}

function copyAssets() {
  const files = runtimeAssets();
  for (const f of files) {
    const from = path.join(SRC, f);
    const to = path.join(ROOT, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(from)) { fs.copyFileSync(from, to); if (!f.endsWith(".json")) fs.chmodSync(to, 0o755); }
  }
  try { fs.chmodSync(path.join(ROOT, "bin", "cc-launcher.mjs"), 0o755); } catch {}
  const cmds = path.join(SRC, "commands");
  if (fs.existsSync(cmds)) {
    const dst = path.join(claudeDir(), "commands");
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(cmds, dst, { recursive: true, force: true });
  }
}
async function askPerformance() {
  if (process.env.CC_TERMUX_NO_PROMPT === "1" || process.env.CC_TERMUX_NO_TUNE === "1") return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const cfgPath = CFG;
  let mode = "";
  try { mode = (JSON.parse(fs.readFileSync(cfgPath, "utf8")).performance || {}).mode || ""; } catch (e) { }
  if (!shouldAskPerf(mode)) return; // already answered on install/first update
  const def = perfDefaultAnswer({ mode });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log();
    banner(["Performance mode (optional)"], { stream: process.stdout, tty: true });
    for (const line of PERF_PROMPT_LINES) console.log("  " + line);
    console.log();
    const hint = def === "yes" ? "[Y/n]" : "[y/N]";
    const a = (await rl.question("  Turn on performance mode? " + hint + " > ")).trim().toLowerCase();
    const yes = a === "" ? def === "yes" : a.startsWith("y");
    savePerfMode(cfgPath, yes ? "on" : "off");
    step(yes ? "Performance mode is ON (change later: cc-termux tune off)" : "Performance mode is off (change later: cc-termux tune on)", { stream: process.stdout, tty: true });
  } finally {
    rl.close();
  }
}

// Optional web-search keys. Everything is skippable: with no keys the built-in scrapers
// handle search, and any provider added here becomes a faster first choice.
async function askWebProviders() {
  if (process.env.CC_TERMUX_NO_PROMPT === "1" || process.env.CC_TERMUX_NO_WEB_PROMPT === "1") return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const file = path.join(path.dirname(CFG), "web.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { }
  if (cfg.asked) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const write = () => {
    cfg.asked = true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  };
  try {
    console.log();
    banner(["Web search (optional)"], { stream: process.stdout, tty: true });
    console.log("  cc-termux can search through a hosted API. Search tries the provider you add");
    console.log("  first and falls back to the next one on quota or failure, with the built-in");
    console.log("  scraper always last, so search works whether or not you add a key.");
    console.log();
    const a = (await rl.question("  Add a web search API? (y/N) > ")).trim().toLowerCase();
    if (!a.startsWith("y")) {
      write();
      step("No web key added - the built-in scraper handles search (change later: cc-termux web)", { stream: process.stdout, tty: true });
      return;
    }

    // One list, one choice, one key. Anything else can be added later from the same place.
    const options = [
      { id: "tavily", label: "Tavily", url: "https://app.tavily.com/home", hint: "free key, 1000 credits/month" },
      { id: "brave", label: "Brave Search", url: "https://api-dashboard.search.brave.com/app/keys", hint: "free plan, 2000 queries/month" },
      { id: "jina", label: "Jina Reader", url: "https://jina.ai/reader", hint: "search and page reading, free tier" },
    ];
    for (;;) {
      console.log();
      console.log("  Which one?");
      options.forEach((o, i) => {
        const already = cfg.keys && cfg.keys[o.id] ? " (key saved)" : "";
        console.log("    " + (i + 1) + ". " + o.label.padEnd(14) + o.hint + already);
      });
      console.log("    q. skip");
      console.log();
      const pick = (await rl.question("  Choose 1-3 or q > ")).trim().toLowerCase();
      if (pick === "q" || pick === "") break;
      const index = Number(pick);
      const chosen = Number.isInteger(index) && index >= 1 && index <= options.length
        ? options[index - 1]
        : options.find((o) => o.id === pick || o.label.toLowerCase().startsWith(pick));
      if (!chosen) { console.log("  enter 1, 2, 3 or q"); continue; }
      console.log();
      console.log("  " + chosen.label + "  " + chosen.hint);
      console.log("  get a key: " + chosen.url);
      const key = (await rl.question("  Paste your " + chosen.label + " API key > ")).trim();
      if (!key) { console.log("  no key entered - try again or press q to skip"); continue; }
      cfg.keys = { ...(cfg.keys || {}), [chosen.id]: key };
      write();
      step(chosen.label + " saved - it is now tried first, with the scraper as fallback", { stream: process.stdout, tty: true });
      break;
    }
    write();
    if (!cfg.keys || !Object.keys(cfg.keys).length) {
      step("No web key added - the built-in scraper handles search (change later: cc-termux web)", { stream: process.stdout, tty: true });
    }
  } finally {
    rl.close();
  }
}

// The skill pack is content, not code: it is always installed so the agent has the
// conventions available, and never overwrites a skill the user already has.
async function installSkillsQuietly() {
  try {
    const r = await installSkills({ force: false });
    if (r.installed.length) info("skills installed: " + r.installed.join(", "));
  } catch (e) { }
}

function looksLikeShim(file) {
  try {
    const fd = fs.openSync(file, "r");
    const b = Buffer.alloc(4096);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    fs.closeSync(fd);
    return b.subarray(0, n).toString("utf8").includes("cc-launcher.mjs");
  } catch (e) { return false; }
}

function stopManagedGateway() {
  const target = path.join(ROOT, "proxy", "server.mjs");
  let pids = [];
  try {
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const cmd = fs.readFileSync("/proc/" + d + "/cmdline", "utf8");
        const pid = Number(d);
        if (pid !== process.pid && pid !== process.ppid && cmd.split("\0").includes(target)) pids.push(pid);
      } catch (e) { }
    }
  } catch (e) { }
  const pidFile = path.join(cacheDir(), "gateway.pid");
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (pid && pid !== process.pid && pid !== process.ppid && !pids.includes(pid)) pids.push(pid);
  } catch (e) { }
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch (e) { } }
  try { fs.unlinkSync(pidFile); } catch (e) { }
  if (pids.length) log("stopped running gateway so the new code loads on next launch");
}

function installShims(t) {
  const node = process.execPath;
  const scripts = {
    claude: [path.join(ROOT, "bin", "cc-launcher.mjs")],
    "cc-termux": [path.join(ROOT, "bin", "cc-termux")],
    ccp: [path.join(ROOT, "bin", "ccp.mjs")],
  };
  if (t.win) {
    // ROOT\bin is not on PATH, so a shim there is invisible to cmd/PowerShell. Write the
    // .cmd files where Windows already looks, and keep a copy in ROOT\bin.
    const dirs = [
      path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm"),
      path.join(os.homedir(), "AppData", "Local", "Microsoft", "WindowsApps"),
      path.join(ROOT, "bin"),
    ];
    let placed = null;
    for (const dir of dirs) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        for (const [name, argv] of Object.entries(scripts)) {
          const cmd = path.join(dir, name + ".cmd");
          // PowerShell picks .ps1 over .cmd when both sit in the same directory, so an npm
          // leftover would shadow our shim and fail. Move it aside rather than delete it.
          for (const ext of [".ps1", ".bat", ""]) {
            if (!ext) continue;
            const stale = path.join(dir, name + ext);
            try {
              if (fs.existsSync(stale)) {
                const body = fs.readFileSync(stale, "utf8");
                if (!body.includes("cc-launcher.mjs") && !body.includes("cc-termux")) {
                  fs.renameSync(stale, stale + ".cc-termux-backup");
                }
              }
            } catch (e) { }
          }
          fs.writeFileSync(cmd, "@echo off\r\n\"" + node + "\" \"" + argv[0] + "\" %*\r\n");
        }
        placed = dir;
        break;
      } catch (e) { }
    }
    log("windows shims: " + (placed || path.join(ROOT, "bin")) + (placed ? "" : " (add this folder to PATH)"));
    return;
  }
  const canonicalRoot = DEFAULT_ROOT;
  if (path.resolve(ROOT) !== path.resolve(canonicalRoot)) {
    log("custom install root: skipping ~/.local and $PREFIX shims (add " + path.join(ROOT, "bin") + " to PATH)");
    return;
  }
  // PREFIX (Termux) wins; on macOS this detects Homebrew's /opt/homebrew/bin.
  const binDir = prefixBinDir();
  const homeBin = path.join(os.homedir(), ".local", "bin");
  const writeShim = (dir, name, target) => {
    const p = path.join(dir, name);
    fs.mkdirSync(dir, { recursive: true });
    try { fs.rmSync(p, { force: true }); } catch {}
    fs.writeFileSync(p, "#!/bin/sh\nexec \"" + node + "\" \"" + target + "\" \"$@\"\n");
    fs.chmodSync(p, 0o755);
    return p;
  };
  try {
    let ver = "cc-termux";
    try { ver = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim().split("-")[0] || "cc-termux"; } catch (e) { }
    const versionsDir = path.join(os.homedir(), ".local", "share", "claude", "versions");
    fs.mkdirSync(versionsDir, { recursive: true });
    let targetFile = path.join(versionsDir, ver);
    try { if (fs.existsSync(targetFile) && !looksLikeShim(targetFile)) targetFile = path.join(versionsDir, "cc-termux-" + ver); } catch (e) { }
    writeShim(path.dirname(targetFile), path.basename(targetFile), scripts.claude[0]);
    fs.mkdirSync(homeBin, { recursive: true });
    const link = path.join(homeBin, "claude");
    try { if (fs.existsSync(link) && !looksLikeShim(link)) fs.renameSync(link, link + ".official-backup." + Date.now()); } catch (e) { }
    try { fs.rmSync(link, { force: true }); } catch (e) { }
    fs.symlinkSync(targetFile, link);
    writeShim(binDir, "cc-termux", scripts["cc-termux"][0]);
    writeShim(binDir, "ccp", scripts.ccp[0]);
    log("linked " + path.join(homeBin, "claude") + " and " + binDir + "/{cc-termux,ccp}");
  } catch (e) {
    try {
      for (const [name, argv] of Object.entries(scripts)) writeShim(path.join(ROOT, "bin"), name, argv[0]);
      console.log("  could not write shims; they are in " + path.join(ROOT, "bin") + ", add it to PATH");
    } catch (e2) { }
  }
  // remove the old prefix claude so Claude Code does not report an npm leftover
  const oldClaude = path.join(binDir, "claude");
  try { if (fs.existsSync(oldClaude)) { let dst = oldClaude + ".official-backup"; if (fs.existsSync(dst)) dst += "." + Date.now(); fs.renameSync(oldClaude, dst); } } catch (e) { }
  // mark native install + make ~/.local/bin visible to login shells
  try {
    const nativeBin = path.join(ROOT, "bin", process.platform === "win32" ? "claude.exe" : "claude.bin");
    if (fs.existsSync(nativeBin)) {
      const cj = path.join(os.homedir(), ".claude.json");
      let raw = null;
      try { raw = fs.readFileSync(cj, "utf8"); } catch (e) { raw = null; }
      {
        let cfg = null;
        if (raw === null) cfg = {};
        else { try { cfg = JSON.parse(raw); } catch (e) { console.error("cc-termux: ~/.claude.json is not valid JSON; leaving it untouched"); } }
        if (cfg && cfg.installMethod !== "native") { cfg.installMethod = "native"; fs.writeFileSync(cj, JSON.stringify(cfg, null, 2) + "\n"); }
      }
    }
  } catch (e) { }
  ensurePathInRcFiles(os.homedir());
}
(async () => {
  if (has("--list-assets")) { for (const f of runtimeAssets()) console.log(f); return; }
  if (!nodeVersionOk(process.versions.node)) fail("Node.js 18+ is required (found " + process.versions.node + ")");
  process.on("exit", () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { } });
  const t = detectHostTarget();
  if (!CHECK && !process.env.CC_TERMUX_NO_BANNER) {
    banner([
      "cc-termux installer",
      "Claude Code + any provider  \u00b7  Termux, Linux, macOS, Windows",
    ]);
    info("Claude Code is downloaded from Anthropic's official npm registry (registry.npmjs.org); cc-termux does not redistribute it.");
  }
  if (CHECK) {
    console.log("cc-termux install plan");
    let ver = "?";
    try { ver = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf8")).version || "?"; } catch (e) { }
    console.log("  version  : " + ver);
    console.log("  node     : " + process.versions.node);
    console.log("  platform : " + process.platform + " " + process.arch);
    console.log("  termux   : " + (t.termux ? "yes" : "no"));
    console.log("  mode     : " + (t.js ? "JS fallback (2.1.112)" : "native " + t.pkg));
    if (t.loader) console.log("  loader   : alpine " + t.loader + " musl (android bionic)");
    if (t.js && t.reason) console.log("  fallback : " + t.reason);
    console.log("  root     : " + ROOT);
    console.log("  config   : " + CFG);
    console.log("  cache    : " + cacheDir());
    console.log("  shims    : " + (t.win ? ROOT + "\\bin\\*.cmd" : "~/.local/bin/claude and " + prefixBinDir() + "/{cc-termux,ccp}"));
    return;
  }
  fs.mkdirSync(ROOT, { recursive: true });
  if (isWindows) {
    // Windows keeps config and cache outside the install root; create both up front so the
    // install does not depend on a later write, and tell the user where everything lives.
    fs.mkdirSync(path.dirname(CFG), { recursive: true });
    fs.mkdirSync(cacheDir(), { recursive: true });
    log("install root: " + ROOT);
    log("config file : " + CFG);
    log("cache dir   : " + cacheDir());
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cctermux-"));

  if (CODE_ONLY) {
    const existing = path.join(ROOT, "bin", t.bin);
    const existingJs = path.join(ROOT, "js", "cli.js");
    if (!fs.existsSync(existing) && !fs.existsSync(existingJs)) fail("no installed Claude Code build at " + ROOT + " - run: cc-termux update --redownload");
    step("Claude Code is already installed in " + ROOT + " - keeping the binary");
    info("Updating cc-termux files, picker and UI patches...");
  } else if (t.js) {
    log("no native target for " + process.platform + "/" + process.arch + ": installing JS fallback 2.1.112");
    const tgz = path.join(tmp, "cc.tgz");
    await download("https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.112.tgz", tgz, "Claude Code JS fallback from the official Anthropic registry (registry.npmjs.org)", await npmIntegrity("@anthropic-ai/claude-code", "2.1.112"));
    extract(tgz, path.join(tmp, "js"));
    const pkg = path.join(tmp, "js", "package");
    fs.mkdirSync(path.join(ROOT, "js"), { recursive: true });
    for (const f of ["cli.js", "package.json", "sdk-tools.d.ts"]) if (fs.existsSync(path.join(pkg, f))) fs.copyFileSync(path.join(pkg, f), path.join(ROOT, "js", f));
    if (fs.existsSync(path.join(pkg, "vendor"))) fs.cpSync(path.join(pkg, "vendor"), path.join(ROOT, "js", "vendor"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "VERSION"), "2.1.112-js\n");
    for (const stale of ["bin/claude.bin", "bin/claude.exe", ".direct-exec"]) { try { fs.rmSync(path.join(ROOT, stale), { force: true }); } catch (e) { } }
    log("JS fallback installed");
  } else {
    const ver = VERSION_ARG || (TARBALL ? "local" : await latestVersion());
    let tgz = TARBALL;
    if (!tgz) {
      log("downloading Claude Code " + ver + " (" + t.pkg + ")");
      tgz = path.join(tmp, "pkg.tgz");
      const size = await download("https://registry.npmjs.org/@anthropic-ai/claude-code-" + t.pkg + "/-/" + "claude-code-" + t.pkg + "-" + ver + ".tgz", tgz, "Claude Code " + ver + " (" + t.pkg + ") from the official Anthropic registry (registry.npmjs.org)", await npmIntegrity("@anthropic-ai/claude-code-" + t.pkg, ver));
      log("downloaded " + (size / 1e6).toFixed(1) + " MB");
    } else log("using local tarball " + tgz);
    extract(tgz, path.join(tmp, "pkg"));
    let pkg = path.join(tmp, "pkg", "package");
    if (!fs.existsSync(pkg)) pkg = tmp;
    let srcBin = path.join(pkg, t.bin);
    if (!fs.existsSync(srcBin)) srcBin = path.join(pkg, "claude");
    if (!fs.existsSync(srcBin)) fail("binary not found in tarball");
    const dst = path.join(ROOT, "bin", t.bin);
    const rollbackBin = dst + ".rollback";
    const versionPath = path.join(ROOT, "VERSION");
    const rollbackVer = versionPath + ".rollback";
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.existsSync(dst)) fs.copyFileSync(dst, rollbackBin);
    if (fs.existsSync(versionPath)) fs.copyFileSync(versionPath, rollbackVer);
    try {
    fs.copyFileSync(srcBin, dst);
    fs.chmodSync(dst, 0o755);
    for (const stale of [dst + ".orig", dst + ".orig.json"]) { try { fs.rmSync(stale, { force: true }); } catch (e) { } }
    step("Claude Code " + ver + " installed into your device (" + dst + ")");
    log("source: registry.npmjs.org/@anthropic-ai/claude-code-" + t.pkg + " (official Anthropic package)");
    if (t.termux && t.loader) {
      log("installing musl loader (" + t.loader + ")");
      const alpine = path.join(tmp, "alpine.tgz");
      const alpineUrl = "https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/" + t.loader + "/alpine-minirootfs-3.20.3-" + t.loader + ".tar.gz";
      await download(alpineUrl, alpine, "Alpine musl loader (needed on Termux)");
      try {
        const expected = (await fetchText(alpineUrl + ".sha256")).trim().split(/\s+/)[0];
        const actual = crypto.createHash("sha256").update(fs.readFileSync(alpine)).digest("hex");
        if (expected && expected !== actual) throw new Error("Alpine loader checksum mismatch");
      } catch (e) { if (/checksum mismatch/.test(e.message)) throw e; }
      extract(alpine, path.join(tmp, "alpine"));
      const loaderName = "ld-musl-" + t.loader + ".so.1";
      fs.mkdirSync(path.join(ROOT, "lib"), { recursive: true });
      fs.copyFileSync(path.join(tmp, "alpine", "lib", loaderName), path.join(ROOT, "lib", loaderName));
      fs.chmodSync(path.join(ROOT, "lib", loaderName), 0o755);
      try { fs.unlinkSync(path.join(ROOT, "lib", "libc.musl-" + t.loader + ".so.1")); } catch {}
      fs.symlinkSync(loaderName, path.join(ROOT, "lib", "libc.musl-" + t.loader + ".so.1"));
      try { fs.rmSync(path.join(ROOT, ".direct-exec"), { force: true }); } catch (e) { }
      let patchelfAvailable = spawnSync("patchelf", ["--version"], { stdio: "ignore" }).status === 0;
      if (!patchelfAvailable) {
        log("installing patchelf via pkg");
        spawnSync("pkg", ["install", "-y", "patchelf"], { stdio: "ignore" });
        patchelfAvailable = spawnSync("patchelf", ["--version"], { stdio: "ignore" }).status === 0;
      }
      const patched = patchelfAvailable ? spawnSync("patchelf", ["--set-interpreter", path.join(ROOT, "lib", loaderName), dst], { stdio: "ignore" }) : { status: 1 };
      if (patched.status === 0) { fs.writeFileSync(path.join(ROOT, ".direct-exec"), ""); log("ELF interpreter patched (direct exec)"); }
      else log("patchelf unavailable: loader mode (self-relaunch may be limited)");
    }
    // Only record success after the binary and its loader are in place.
    fs.writeFileSync(versionPath, ver + "\n");
    fs.rmSync(rollbackBin, { force: true });
    fs.rmSync(rollbackVer, { force: true });
    } catch (e) {
      try { if (fs.existsSync(rollbackBin)) fs.copyFileSync(rollbackBin, dst); else fs.rmSync(dst, { force: true }); } catch (e2) { }
      try { if (fs.existsSync(rollbackVer)) fs.copyFileSync(rollbackVer, versionPath); } catch (e2) { }
      throw e;
    }
  }

  copyAssets();
  if (!CHECK) step("cc-termux files updated");

  const cfgPath = CFG;
  if (!fs.existsSync(cfgPath) || RESET_CONFIG) {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({
      listen: { host: "127.0.0.1", port: 8788 },
      active: "",
      providers: {},
      routing: {},
    }, null, 2) + "\n", { mode: 0o600 });
    log("created empty config " + cfgPath);
  }

  if (!CHECK) info("Applying optional UI patches to the Claude Code binary...");
  try { spawnSync(process.execPath, [path.join(ROOT, "bin", "cc-patch.mjs"), "--apply"], { stdio: "inherit", env: { ...process.env, CC_TERMUX_ROOT: ROOT } }); } catch {}
  try { spawnSync(process.execPath, [path.join(ROOT, "bin", "cc-heal.mjs"), "--root", ROOT], { stdio: "inherit" }); } catch (e) { }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf8"));
    let sha = process.env.CC_TERMUX_COMMIT_SHA || null;
    let commitDate = process.env.CC_TERMUX_COMMIT_DATE || null;
    if (!sha) {
      const g = spawnSync("git", ["-C", SRC, "rev-parse", "HEAD"], { encoding: "utf8" });
      if (g.status === 0) sha = g.stdout.trim() || null;
    }
    if (!commitDate) {
      const g = spawnSync("git", ["-C", SRC, "show", "-s", "--format=%cI", "HEAD"], { encoding: "utf8" });
      if (g.status === 0) commitDate = g.stdout.trim() || null;
    }
    const short = sha ? String(sha).slice(0, 7) : "";
    const version = short ? pkg.version + "+" + short : pkg.version;
    const stamp = { version, baseVersion: pkg.version, sha, installedAt: new Date().toISOString() };
    if (commitDate) stamp.updatedAt = commitDate;
    fs.writeFileSync(path.join(ROOT, "cc-termux.json"), JSON.stringify(stamp, null, 2) + "\n");
  } catch (e) { }
  stopManagedGateway();
  await askPerformance();
  await askWebProviders();
  await installSkillsQuietly();
  if (!NO_SHIMS) installShims(t);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  log((CODE_ONLY ? "updated " : "installed into ") + ROOT);
  if (!NO_SETUP && process.stdin.isTTY && process.stdout.isTTY) {
    console.log("starting provider setup...");
    const setup = spawnSync(process.execPath, [path.join(ROOT, "bin", "cc-setup.mjs")], { stdio: "inherit" });
    console.log("");
    if (setup.status === 0) {
      step("Ready. Start Claude Code with: claude");
      info("Dashboard: cc-termux status   ·   repair: cc-termux doctor   ·   update: cc-termux update");
    } else {
      info("Setup was not completed. Run \"cc-termux setup\" when ready.");
    }
  } else if (CODE_ONLY || NO_SETUP) {
    step("Update complete. Run \"claude\" when ready.");
    info("Add a provider with: cc-termux setup");
  } else {
    console.log("next: run \"cc-termux setup\" to add a provider, then \"claude\"");
  }
})().catch((e) => fail(e.message));