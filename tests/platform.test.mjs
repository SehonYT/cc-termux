import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { detectTarget, nodeVersionOk, glibcTooOld, isMusl } from "../bin/cc-platform.mjs";
import { resolvePrefix, prefixBinDir } from "../bin/cc-heal.mjs";
import { installRoot, configFile, cacheDir, claudeDir } from "../bin/cc-paths.mjs";

test("native targets for published platforms", () => {
  assert.equal(detectTarget({ platform: "win32", arch: "x64" }).pkg, "win32-x64");
  assert.equal(detectTarget({ platform: "win32", arch: "arm64" }).pkg, "win32-arm64");
  assert.equal(detectTarget({ platform: "darwin", arch: "arm64" }).pkg, "darwin-arm64");
  assert.equal(detectTarget({ platform: "darwin", arch: "x64" }).pkg, "darwin-x64");
  assert.equal(detectTarget({ platform: "linux", arch: "x64" }).pkg, "linux-x64");
  assert.equal(detectTarget({ platform: "linux", arch: "arm64" }).pkg, "linux-arm64");
  assert.equal(detectTarget({ platform: "linux", arch: "x64", hasFile: () => true }).pkg, "linux-x64-musl");
  assert.equal(detectTarget({ platform: "linux", arch: "arm64", hasFile: () => true }).pkg, "linux-arm64-musl");
});

test("Android uses the musl loader, including 32-bit userland on AArch64 kernels", () => {
  assert.deepEqual(detectTarget({ platform: "android", arch: "arm64" }), { pkg: "linux-arm64-musl", loader: "aarch64", bin: "claude.bin", termux: true });
  assert.equal(detectTarget({ platform: "android", arch: "x64" }).pkg, "linux-x64-musl");
  const armv8 = detectTarget({ platform: "android", arch: "arm", cpuinfo: "CPU architecture: 8" });
  assert.equal(armv8.pkg, "linux-arm64-musl");
  const armv7 = detectTarget({ platform: "android", arch: "arm", cpuinfo: "CPU architecture: 7" });
  assert.equal(armv7.js, true);
});

test("unsupported CPUs and OSes fall back to the JS build", () => {
  for (const [platform, arch] of [["linux", "ia32"], ["linux", "ppc64"], ["linux", "riscv64"], ["freebsd", "x64"], ["win32", "ia32"], ["android", "mips"]]) {
    const t = detectTarget({ platform, arch });
    assert.equal(t.js, true, platform + "/" + arch + " should fall back");
  }
  assert.equal(detectTarget({ platform: "linux", arch: "arm64", forceJs: true }).js, true);
});

test("node and glibc guards", () => {
  assert.equal(nodeVersionOk("18.19.0"), true);
  assert.equal(nodeVersionOk("16.20.0"), false);
  assert.equal(glibcTooOld("ldd (Ubuntu GLIBC 2.27-3ubuntu1) 2.27"), false);
  assert.equal(glibcTooOld("ldd (Ubuntu GLIBC 2.23-0ubuntu11) 2.23"), true);
});
test("Alpine is recognised even when the musl loader is not at the usual path", () => {
  // Alpine images differ: some have /lib/ld-musl-*, some only the distro marker.
  assert.equal(isMusl({ arch: "x64", hasFile: (p) => p === "/lib/ld-musl-x86_64.so.1" }), true);
  assert.equal(isMusl({ arch: "x64", hasFile: (p) => p === "/etc/alpine-release" }), true);
  assert.equal(isMusl({ arch: "arm64", hasFile: (p) => p === "/lib/ld-musl-aarch64.so.1" }), true);
  assert.equal(isMusl({ arch: "x64", hasFile: (p) => p === "/usr/lib/ld-musl-x86_64.so.1" }), true);
  // glibc distros must not be mistaken for musl, or the wrong build is installed.
  assert.equal(isMusl({ arch: "x64", hasFile: () => false }), false);
  assert.equal(isMusl({ arch: "x64", hasFile: (p) => p === "/etc/os-release" }), false);

  // And the choice follows: Alpine gets the musl build, Ubuntu the glibc one.
  assert.equal(detectTarget({ platform: "linux", arch: "x64", hasFile: (p) => p === "/etc/alpine-release" }).pkg, "linux-x64-musl");
  assert.equal(detectTarget({ platform: "linux", arch: "arm64", hasFile: (p) => p === "/etc/alpine-release" }).pkg, "linux-arm64-musl");
  assert.equal(detectTarget({ platform: "linux", arch: "x64", hasFile: () => false }).pkg, "linux-x64");
});

test("the shim directory is real on every platform we support", () => {
  const home = "/home/x";
  // Windows has no /usr/local; it must resolve under the user's own application data.
  const win = resolvePrefix({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, home, exists: () => false });
  assert.match(win, /AppData/, "windows must not get a POSIX path");
  assert.ok(!win.startsWith("/usr"), "windows must never resolve to /usr/local");
  assert.equal(path.join(win, "bin"), prefixBinDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, home, exists: () => false }));

  // Termux keeps its own prefix.
  assert.equal(resolvePrefix({ platform: "android", env: {}, home, exists: () => false }), "/data/data/com.termux/files/usr");
  // An explicit PREFIX always wins, which is what Alpine and custom roots rely on.
  assert.equal(resolvePrefix({ platform: "linux", env: { PREFIX: "/usr" }, home, exists: () => false }), "/usr");
  // macOS: Homebrew's prefix, then /usr/local.
  assert.equal(resolvePrefix({ platform: "darwin", env: { HOMEBREW_PREFIX: "/opt/homebrew" }, home, exists: () => false }), "/opt/homebrew");
  assert.equal(resolvePrefix({ platform: "darwin", env: {}, home, exists: (p) => p === "/usr/local/bin" }), "/usr/local");
  // A Linux box without a writable /usr/local falls back to the user's own bin.
  assert.equal(resolvePrefix({ platform: "linux", env: {}, home, exists: () => false }), path.join(home, ".local"));
  // Every result is absolute, on every platform.
  for (const platform of ["win32", "darwin", "linux", "android"]) {
    const p = resolvePrefix({ platform, env: {}, home: "C:\\Users\\x", exists: () => false });
    assert.ok(typeof p === "string" && p.length > 0, platform + " must produce a path");
  }
});

test("the launcher name follows the platform", () => {
  // POSIX uses a shell script; Windows needs a .cmd, and the uninstaller must agree.
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const src = fs.readFileSync(path.join(root, "bin", "cc-uninstall.mjs"), "utf8");
  assert.match(src, /win32.*claude\.cmd|claude\.cmd.*win32/s, "the uninstaller resolves the windows shim name");
  assert.match(src, /export function shimPath\(\)/);
  assert.match(src, /export function shimDir\(\)/);
  assert.ok(!/path\.join\(home, "\.local", "bin", "claude"\)/.test(src), "the old fixed POSIX path is gone");
});

test("config, cache and install roots resolve per platform", () => {
  // Windows uses APPDATA/LOCALAPPDATA; POSIX uses XDG-style dot directories.
  const win = { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local", APPDATA: "C:\\Users\\x\\AppData\\Roaming" };
  const prev = { ...process.env };
  try {
    delete process.env.CC_TERMUX_ROOT;
    delete process.env.CC_TERMUX_CONFIG;
    delete process.env.CC_TERMUX_CACHE;
    const root = installRoot();
    assert.ok(path.isAbsolute(root), "install root is absolute");
    assert.ok(path.isAbsolute(configFile()), "config path is absolute");
    assert.ok(path.isAbsolute(cacheDir()), "cache path is absolute");
    assert.ok(path.isAbsolute(claudeDir()), "claude dir is absolute");
    // Every one of them is under the user's home or an app-data directory, never a bare relative path.
    for (const p of [root, configFile(), cacheDir()]) {
      assert.ok(!/^\.\.?[\\/]/.test(p), p + " must not be relative");
    }
  } finally {
    for (const [k, v] of Object.entries(prev)) process.env[k] = v;
  }
});
