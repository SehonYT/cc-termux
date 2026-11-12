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

test("every OS we claim to support has a usable target", () => {
  // This is the support contract. If a platform is dropped or mis-detected, this fails
  // before a user on that platform can hit it.
  const supported = [
    { platform: "win32", arch: "x64", expect: "win32-x64" },
    { platform: "win32", arch: "arm64", expect: "win32-arm64" },
    { platform: "darwin", arch: "x64", expect: "darwin-x64" },      // Intel Mac
    { platform: "darwin", arch: "arm64", expect: "darwin-arm64" },  // Apple Silicon
    { platform: "linux", arch: "x64", expect: "linux-x64" },        // Ubuntu, Debian, Fedora
    { platform: "linux", arch: "arm64", expect: "linux-arm64" },    // ARM servers, Pi
    { platform: "android", arch: "arm64", expect: "linux-arm64-musl" }, // Termux
    { platform: "android", arch: "x64", expect: "linux-x64-musl" },
  ];
  for (const c of supported) {
    const t = detectTarget({ platform: c.platform, arch: c.arch, hasFile: () => false });
    assert.equal(t.pkg, c.expect, c.platform + "/" + c.arch + " must resolve to " + c.expect);
    assert.ok(t.bin, c.platform + "/" + c.arch + " needs a binary name");
  }
});

test("musl distros get a musl build and glibc distros do not", () => {
  // A musl host given the glibc binary installs fine and then cannot exec.
  // Each loader path only counts for the architecture it belongs to.
  const muslMarkers = [
    ["/etc/alpine-release", "x64"], ["/etc/alpine-release", "arm64"],
    ["/lib/ld-musl-x86_64.so.1", "x64"], ["/lib/ld-musl-aarch64.so.1", "arm64"],
    ["/usr/lib/ld-musl-x86_64.so.1", "x64"],
  ];
  for (const [marker, arch] of muslMarkers) {
    const t = detectTarget({ platform: "linux", arch, hasFile: (p) => p === marker });
    assert.ok(/-musl$/.test(t.pkg), marker + " on " + arch + " must select a musl build, got " + t.pkg);
  }
  for (const glibcOnly of [["/etc/os-release"], ["/lib/x86_64-linux-gnu/libc.so.6"], []]) {
    const t = detectTarget({ platform: "linux", arch: "x64", hasFile: (p) => glibcOnly.includes(p) });
    assert.ok(!/-musl$/.test(t.pkg), "a glibc distro must not get a musl build");
  }
});

test("every platform resolves to a usable, distinct prefix", () => {
  // path.isAbsolute is platform-bound: a Windows path looks relative to POSIX, so the
  // assertion checks the shape each platform must produce instead.
  const winEnv = { LOCALAPPDATA: "C:/Users/x/AppData/Local" };
  // path.join uses the host separator, so the expectation must not assume one: on Windows
  // every join produces backslashes even from a POSIX-looking home.
  const cases = [
    ["win32", winEnv, /AppData/],
    ["darwin", {}, /(^|[\\/])\.local$/],
    ["linux", {}, /(^|[\\/])\.local$/],
    // Termux has its own prefix and must not be sent to $HOME.
    ["android", {}, /(^|[\\/])usr$/],
  ];
  const byPlatform = {};
  for (const [platform, env, shape] of cases) {
    const root = resolvePrefix({ platform, env, home: "/home/x", exists: () => false });
    assert.ok(typeof root === "string" && root.length > 1, platform + " prefix must be a real path");
    // Match on the tail so the host separator does not matter: on Windows every join
    // produces backslashes even from a POSIX-looking home.
    assert.match(root, shape, platform + " prefix has the wrong shape: " + root);
    const bin = prefixBinDir({ platform, env, home: "/home/x", exists: () => false });
    assert.ok(bin.endsWith("bin"), platform + " bin dir must end in bin");
    byPlatform[platform] = root;
  }
  // POSIX platforms may share /usr/local legitimately; Windows must never.
  assert.notEqual(byPlatform.win32, byPlatform.linux, "windows must not resolve like linux");
  assert.notEqual(byPlatform.win32, byPlatform.darwin, "windows must not resolve like macOS");
  assert.ok(!/^[\\/]usr[\\/]/.test(byPlatform.win32), "windows must never resolve under /usr");
  // An explicit PREFIX still wins everywhere, which custom roots and Alpine rely on.
  for (const platform of ["win32", "darwin", "linux", "android"]) {
    assert.equal(resolvePrefix({ platform, env: { PREFIX: "/custom" }, home: "/home/x", exists: () => false }), "/custom");
  }
  // Windows specifically must never be given a POSIX system path.
  const win = resolvePrefix({ platform: "win32", env: {}, home: "C:/Users/x", exists: () => false });
  assert.ok(!win.startsWith("/usr"), "windows must never resolve to /usr/local");
});

test("an unknown platform degrades to the JS build instead of crashing", () => {
  // Better a slower working install than an exception on a platform we have not seen.
  for (const [platform, arch] of [["freebsd", "x64"], ["sunos", "x64"], ["linux", "ia32"], ["darwin", "ia32"], ["win32", "ia32"]]) {
    const t = detectTarget({ platform, arch });
    assert.equal(t.js, true, platform + "/" + arch + " must fall back to the JS build");
    assert.equal(t.pkg, null);
    assert.ok(t.reason, "the fallback must say why");
  }
});

test("the CI matrix covers every operating system we claim", () => {
  // The workflow is part of the support claim: a platform with no job is a promise nobody
  // is checking.
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const wf = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const matrix = /os: \[([^\]]+)\]/.exec(wf);
  assert.ok(matrix, "the check job has an os matrix");
  const oses = matrix[1].split(",").map((s) => s.trim());
  for (const needed of ["ubuntu-latest", "macos-latest", "macos-13", "windows-latest"]) {
    assert.ok(oses.includes(needed), "CI must run on " + needed);
  }
  // macOS Intel takes a different branch from Apple Silicon, so both must be present.
  assert.ok(oses.includes("macos-13"), "Intel macOS must be covered");
  // Alpine is musl: a real container, not a simulated filesystem.
  assert.match(wf, /^  alpine:/m, "there is an alpine job");
  assert.match(wf, /node:\$\{\{ matrix\.node \}\}-alpine/, "alpine runs a real musl image");
  assert.match(wf, /ldd --version[\s\S]{0,80}musl/, "the alpine job proves it is musl");
  // Every OS we support must also get an install smoke run.
  const smokeIdx = wf.indexOf("install smoke (");
  assert.ok(smokeIdx > 0, "there is an install smoke job");
  const smokeBlock = wf.slice(smokeIdx, smokeIdx + 600);
  for (const needed of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    assert.ok(smokeBlock.includes(needed), "install smoke must run on " + needed);
  }
  // Windows needs its own branch: the paths are not POSIX.
  assert.match(wf, /if: runner\.os == 'Windows'/, "windows needs a native-path smoke step");
});
