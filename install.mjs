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

const SRC = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argVal = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = argVal("--root", process.env.CC_TERMUX_ROOT || path.join(os.homedir(), ".local", "share", "cc-termux"));
const CFG = process.env.CC_TERMUX_CONFIG || path.join(os.homedir(), ".config", "cc-termux", "config.json");
const CHECK = has("--check");
const NO_SETUP = has("--no-setup");
const NO_SHIMS = has("--no-shims");
const TARBALL = argVal("--tarball", "");
const VERSION_ARG = argVal("--version", "");

const log = (m) => console.log("\x1b[36mcc-termux\x1b[0m " + m);
const fail = (m) => { console.error("\x1b[31merror\x1b[0m " + m); process.exit(1); };

function arm64Capable() {
  try {
    const cpu = fs.readFileSync("/proc/cpuinfo", "utf8");
    const m = cpu.match(/CPU architecture:\s*(\d+)/i);
    if (m && Number(m[1]) >= 8) return true;
    if (/aarch64/i.test(cpu)) return true;
  } catch (e) { }
  return false;
}

function target() {
  const p = process.platform, a = process.arch;
  if (p === "android") {
    if (a === "x64") return { pkg: "linux-x64-musl", loader: "x86_64", bin: "claude.bin", termux: true };
    // 32-bit Termux on an ARMv8/aarch64 kernel can still exec the official arm64 binary.
    if (a === "arm64" || arm64Capable()) return { pkg: "linux-arm64-musl", loader: "aarch64", bin: "claude.bin", termux: true };
    return { js: true, pkg: null, bin: "claude.bin", termux: true };
  }
  if (p === "linux") {
    const musl = fs.existsSync("/lib/ld-musl-x86_64.so.1") || fs.existsSync("/lib/ld-musl-aarch64.so.1");
    if (a === "x64") return { pkg: musl ? "linux-x64-musl" : "linux-x64", bin: "claude.bin" };
    if (a === "arm64") return { pkg: musl ? "linux-arm64-musl" : "linux-arm64", bin: "claude.bin" };
    return { js: true, pkg: null, bin: "claude.bin" };
  }
  if (p === "darwin") return { pkg: a === "arm64" ? "darwin-arm64" : "darwin-x64", bin: "claude.bin" };
  if (p === "win32") return { pkg: a === "arm64" ? "win32-arm64" : "win32-x64", bin: "claude.exe", win: true };
  return { js: true, pkg: null, bin: "claude.bin" };
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
  return run("tar", ["-xzf", tgz, "-C", dest]);
}

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("download HTTP " + r.status + " " + url);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf.length;
}

function pkgTarballUrl(pkg, ver) {
  const name = "claude-code-" + pkg.replace(/^linux-|^darwin-|^win32-/, "");
  return "https://registry.npmjs.org/@anthropic-ai/claude-code-" + pkg + "/-/" + "claude-code-" + pkg + "-" + ver + ".tgz";
}

function copyAssets() {
  const files = ["proxy/server.mjs", "bin/cc-launcher.mjs", "bin/cc-setup.mjs", "bin/cc-termux", "bin/cc-env.mjs", "bin/cc-patch.mjs", "bin/ccp.mjs", "presets.json", "config.example.json"];
  for (const f of files) {
    const from = path.join(SRC, f);
    const to = path.join(ROOT, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(from)) { fs.copyFileSync(from, to); if (!f.endsWith(".json") && !f.endsWith(".mjs")) fs.chmodSync(to, 0o755); }
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
  const writeShim = (dir, name, target) => {
    const p = path.join(dir, name);
    fs.mkdirSync(dir, { recursive: true });
    try { fs.rmSync(p, { force: true }); } catch {}
    fs.writeFileSync(p, "#!/bin/sh\nexec \"" + node + "\" \"" + target + "\" \"$@\"\n");
    fs.chmodSync(p, 0o755);
    return p;
  };
  try {
    for (const [name, argv] of Object.entries(scripts)) writeShim(binDir, name, argv[0]);
    log("linked " + binDir + "/{claude,cc-termux,ccp}");
  } catch (e) {
    for (const [name, argv] of Object.entries(scripts)) writeShim(path.join(ROOT, "bin"), name, argv[0]);
    console.log("  could not write to " + binDir + "; shims are in " + path.join(ROOT, "bin") + ", add it to PATH");
  }
}

(async () => {
  const t = target();
  if (CHECK) {
    console.log("cc-termux install plan");
    console.log("  platform : " + process.platform + " " + process.arch);
    console.log("  termux   : " + (t.termux ? "yes" : "no"));
    console.log("  mode     : " + (t.js ? "JS fallback (2.1.112)" : "native " + t.pkg));
    if (t.loader) console.log("  loader   : alpine " + t.loader + " musl (android bionic)");
    console.log("  root     : " + ROOT);
    console.log("  config   : " + CFG);
    console.log("  shims    : " + (t.win ? ROOT + "\\bin\\*.cmd" : (process.env.PREFIX || (t.termux ? "/data/data/com.termux/files/usr" : "/usr/local")) + "/bin/{claude,cc-termux,ccp}"));
    return;
  }
  fs.mkdirSync(ROOT, { recursive: true });
  copyAssets();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cctermux-"));

  if (t.js) {
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
      const patched = spawnSync("patchelf", ["--set-interpreter", path.join(ROOT, "lib", loaderName), dst], { stdio: "ignore" });
      if (patched.status === 0) { fs.writeFileSync(path.join(ROOT, ".direct-exec"), ""); log("ELF interpreter patched (direct exec)"); }
      else log("patchelf unavailable: loader mode (self-relaunch may be limited)");
    }
  }

  const cfgPath = CFG;
  if (!fs.existsSync(cfgPath)) {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "config.example.json"), cfgPath);
    fs.chmodSync(cfgPath, 0o600);
    log("created config " + cfgPath);
  }

  try { spawnSync(process.execPath, [path.join(ROOT, "bin", "cc-patch.mjs"), "--apply"], { stdio: "inherit", env: { ...process.env, CC_TERMUX_ROOT: ROOT } }); } catch {}
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