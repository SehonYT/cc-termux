import test from "node:test";
import assert from "node:assert/strict";
import { detectTarget, nodeVersionOk, glibcTooOld } from "../bin/cc-platform.mjs";

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