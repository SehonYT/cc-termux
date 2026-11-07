#!/usr/bin/env node
// Installer for Linux, macOS, Windows and Termux.
//
// Resolves the official Claude Code package for the host platform, installs it under
// the install root, writes launcher shims and runs the provider setup wizard.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectTarget, nodeVersionOk, glibcTooOld } from "./bin/cc-platform.mjs";
import { extractTgz } from "./bin/cc-tar.mjs";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argVal = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = argVal("--root", process.env.CC_TERMUX_ROOT || path.join(os.homedir(), ".local", "share", "cc-termux"));
const CFG = process.env.CC_TERMUX_CONFIG || path.join(os.homedir(), ".config", "cc-termux", "config.json");
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

async function download(url, file) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(file, buf);
      return buf.length;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        const wait = 1000 * attempt;
        log("download attempt " + attempt + " failed (" + (e.name || e.message) + "), retrying in " + wait + "ms");
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw new Error("download failed: " + (lastErr && (lastErr.message || lastErr.name)) + " - " + url);
}

function pkgTarballUrl(pkg, ver) {
  const name = "claude-code-" + pkg.replace(/^linux-|^darwin-|^win32-/, "");
  return "https://registry.npmjs.org/@anthropic-ai/claude-code-" + pkg + "/-/" + "claude-code-" + pkg + "-" + ver + ".tgz";
}

function copyAssets() {
  const files = ["proxy/server.mjs", "bin/cc-launcher.mjs", "bin/cc-setup.mjs", "bin/cc-termux", "bin/cc-env.mjs", "bin/cc-patch.mjs", "bin/ccp.mjs", "bin/cc-heal.mjs", "bin/cc-platform.mjs", "bin/cc-tar.mjs", "bin/cc-update.mjs", "patches.json", "presets.json", "config.example.json", "install.mjs", "install.sh", "install.ps1", "get.sh", "get.ps1", "scripts/ensure-node.sh", "scripts/version.mjs", "package.json", "README.md", "LICENSE", "NOTICE"];
  for (const f of files) {
    const from = path.join(SRC, f);
    const to = path.join(ROOT, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(from)) { fs.copyFileSync(from, to); if (!f.endsWith(".json")) fs.chmodSync(to, 0o755); }
  }
  try { fs.chmodSync(path.join(ROOT, "bin", "cc-launcher.mjs"), 0o755); } catch {}
  const cmds = path.join(SRC, "commands");
  if (fs.existsSync(cmds)) {
    const dst = path.join(os.homedir(), ".claude", "commands");
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(cmds)) fs.copyFileSync(path.join(cmds, f), path.join(dst, f));
  }
}
function installShims(t) {
  const node = process.execPath;
  const scripts = {
    claude: [path.join(ROOT, "bin", "cc-launcher.mjs")],
    "cc-termux": [path.join(ROOT, "bin", "cc-termux")],
    ccp: [path.join(ROOT, "bin", "ccp.mjs")],
  };
  if (t.win) {
    for (const [name, argv] of Object.entries(scripts)) {
      const line = "@echo off\r\n\"" + node + "\" \"" + argv[0] + "\" %*\r\n";
      fs.writeFileSync(path.join(ROOT, "bin", name + ".cmd"), line);
    }
    console.log("  windows shims written to " + path.join(ROOT, "bin") + " (add that folder to PATH)");
    return;
  }
  const prefix = process.env.PREFIX || (t.termux ? "/data/data/com.termux/files/usr" : "/usr/local");
  const binDir = path.join(prefix, "bin");
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
    const targetFile = path.join(versionsDir, ver);
    writeShim(path.dirname(targetFile), path.basename(targetFile), scripts.claude[0]);
    fs.mkdirSync(homeBin, { recursive: true });
    const link = path.join(homeBin, "claude");
    try { if (fs.existsSync(link) && !fs.lstatSync(link).isSymbolicLink()) fs.renameSync(link, link + ".official-backup." + Date.now()); } catch (e) { }
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
    const cj = path.join(os.homedir(), ".claude.json");
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cj, "utf8")); } catch (e) { cfg = {}; }
    if (cfg.installMethod !== "native") { cfg.installMethod = "native"; fs.writeFileSync(cj, JSON.stringify(cfg, null, 2) + "\n"); }
  } catch (e) { }
  for (const rc of [path.join(os.homedir(), ".bashrc"), path.join(os.homedir(), ".profile")]) {
    try {
      if (!fs.existsSync(rc)) continue;
      const text = fs.readFileSync(rc, "utf8");
      if (!text.includes("# cc-termux PATH")) fs.appendFileSync(rc, "\n# cc-termux PATH\nexport PATH=\"$HOME/.local/bin:$PATH\"\n");
    } catch (e) { }
  }
}
(async () => {
  if (!nodeVersionOk(process.versions.node)) fail("Node.js 18+ is required (found " + process.versions.node + ")");
  const t = detectHostTarget();
  if (CHECK) {
    console.log("cc-termux install plan");
    console.log("  platform : " + process.platform + " " + process.arch);
    console.log("  termux   : " + (t.termux ? "yes" : "no"));
    console.log("  mode     : " + (t.js ? "JS fallback (2.1.112)" : "native " + t.pkg));
    if (t.loader) console.log("  loader   : alpine " + t.loader + " musl (android bionic)");
    if (t.js && t.reason) console.log("  fallback : " + t.reason);
    console.log("  root     : " + ROOT);
    console.log("  config   : " + CFG);
    console.log("  shims    : " + (t.win ? ROOT + "\\bin\\*.cmd" : (process.env.PREFIX || (t.termux ? "/data/data/com.termux/files/usr" : "/usr/local")) + "/bin/{claude,cc-termux,ccp}"));
    return;
  }
  fs.mkdirSync(ROOT, { recursive: true });
  copyAssets();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cctermux-"));

  if (CODE_ONLY) {
    const existing = path.join(ROOT, "bin", t.bin);
    const existingJs = path.join(ROOT, "js", "cli.js");
    if (!fs.existsSync(existing) && !fs.existsSync(existingJs)) fail("no installed Claude Code build at " + ROOT + " - run: cc-termux update --redownload");
    log("code-only update: keeping the installed Claude Code build");
  } else if (t.js) {
    log("no native target for " + process.platform + "/" + process.arch + ": installing JS fallback 2.1.112");
    const tgz = path.join(tmp, "cc.tgz");
    await download("https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.112.tgz", tgz);
    extract(tgz, path.join(tmp, "js"));
    const pkg = path.join(tmp, "js", "package");
    fs.mkdirSync(path.join(ROOT, "js"), { recursive: true });
    for (const f of ["cli.js", "package.json", "sdk-tools.d.ts"]) if (fs.existsSync(path.join(pkg, f))) fs.copyFileSync(path.join(pkg, f), path.join(ROOT, "js", f));
    if (fs.existsSync(path.join(pkg, "vendor"))) fs.cpSync(path.join(pkg, "vendor"), path.join(ROOT, "js", "vendor"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "VERSION"), "2.1.112-js\n");
    log("JS fallback installed");
  } else {
    const ver = VERSION_ARG || (TARBALL ? "local" : await latestVersion());
    let tgz = TARBALL;
    if (!tgz) {
      log("downloading Claude Code " + ver + " (" + t.pkg + ")");
      tgz = path.join(tmp, "pkg.tgz");
      const size = await download("https://registry.npmjs.org/@anthropic-ai/claude-code-" + t.pkg + "/-/" + "claude-code-" + t.pkg + "-" + ver + ".tgz", tgz);
      log("downloaded " + (size / 1e6).toFixed(1) + " MB");
    } else log("using local tarball " + tgz);
    extract(tgz, path.join(tmp, "pkg"));
    let pkg = path.join(tmp, "pkg", "package");
    if (!fs.existsSync(pkg)) pkg = tmp;
    let srcBin = path.join(pkg, t.bin);
    if (!fs.existsSync(srcBin)) srcBin = path.join(pkg, "claude");
    if (!fs.existsSync(srcBin)) fail("binary not found in tarball");
    const dst = path.join(ROOT, "bin", t.bin);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(srcBin, dst);
    fs.chmodSync(dst, 0o755);
    fs.writeFileSync(path.join(ROOT, "VERSION"), ver + "\n");
    log("installed binary " + dst);
    if (t.termux && t.loader) {
      log("installing musl loader (" + t.loader + ")");
      const alpine = path.join(tmp, "alpine.tgz");
      await download("https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/" + t.loader + "/alpine-minirootfs-3.20.3-" + t.loader + ".tar.gz", alpine);
      extract(alpine, path.join(tmp, "alpine"));
      const loaderName = "ld-musl-" + t.loader + ".so.1";
      fs.mkdirSync(path.join(ROOT, "lib"), { recursive: true });
      fs.copyFileSync(path.join(tmp, "alpine", "lib", loaderName), path.join(ROOT, "lib", loaderName));
      fs.chmodSync(path.join(ROOT, "lib", loaderName), 0o755);
      try { fs.unlinkSync(path.join(ROOT, "lib", "libc.musl-" + t.loader + ".so.1")); } catch {}
      fs.symlinkSync(loaderName, path.join(ROOT, "lib", "libc.musl-" + t.loader + ".so.1"));
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
  }

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

  try { spawnSync(process.execPath, [path.join(ROOT, "bin", "cc-patch.mjs"), "--apply"], { stdio: "inherit", env: { ...process.env, CC_TERMUX_ROOT: ROOT } }); } catch {}
  try { spawnSync(process.execPath, [path.join(ROOT, "bin", "cc-heal.mjs"), "--root", ROOT], { stdio: "inherit" }); } catch (e) { }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf8"));
    let sha = null;
    try {
      const { remoteInfo } = await import(path.join(ROOT, "bin", "cc-update.mjs"));
      sha = (await remoteInfo({})).sha;
    } catch (e) { }
    const short = sha ? String(sha).slice(0, 7) : "";
    const version = short ? pkg.version + "+" + short : pkg.version;
    fs.writeFileSync(path.join(ROOT, "cc-termux.json"), JSON.stringify({ version, baseVersion: pkg.version, sha, installedAt: new Date().toISOString() }, null, 2) + "\n");
  } catch (e) { }
  if (!NO_SHIMS) installShims(t);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  log("installed into " + ROOT);
  if (!NO_SETUP && process.stdin.isTTY && process.stdout.isTTY) {
    console.log("starting provider setup...");
    spawnSync(process.execPath, [path.join(ROOT, "bin", "cc-setup.mjs")], { stdio: "inherit" });
  } else {
    console.log("next: run \"claude\" (or \"cc-termux setup\") to configure a provider");
  }
})().catch((e) => fail(e.message));