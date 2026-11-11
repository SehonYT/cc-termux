#!/usr/bin/env node
// Platform detection shared by the installer and the test suite.
// Native builds exist for linux/darwin/win32 on x64+arm64; everything else uses the JS build.

export function detectTarget({
  platform = process.platform,
  arch = process.arch,
  cpuinfo = "",
  hasFile = () => false,
  forceJs = false,
} = {}) {
  const cpuArch = /CPU architecture:\s*(\d+)/i.exec(cpuinfo);
  const arm64Capable = (cpuArch && Number(cpuArch[1]) >= 8) || /aarch64/i.test(cpuinfo);
  const js = (reason) => ({ js: true, pkg: null, bin: platform === "win32" ? "claude.exe" : "claude.bin", win: platform === "win32", termux: platform === "android", reason });

  if (forceJs) return js("forced JS mode");
  if (platform === "win32") {
    if (arch === "x64") return { pkg: "win32-x64", bin: "claude.exe", win: true };
    if (arch === "arm64") return { pkg: "win32-arm64", bin: "claude.exe", win: true };
    return js("no win32 build for " + arch);
  }
  if (platform === "darwin") {
    if (arch === "arm64") return { pkg: "darwin-arm64", bin: "claude.bin" };
    if (arch === "x64") return { pkg: "darwin-x64", bin: "claude.bin" };
    return js("no darwin build for " + arch);
  }
  if (platform === "android") {
    if (arch === "x64") return { pkg: "linux-x64-musl", loader: "x86_64", bin: "claude.bin", termux: true };
    if (arch === "arm64") return { pkg: "linux-arm64-musl", loader: "aarch64", bin: "claude.bin", termux: true };
    // 32-bit Termux on an ARMv8 kernel can still exec the arm64 build through the musl loader.
    if (arch === "arm" && arm64Capable) return { pkg: "linux-arm64-musl", loader: "aarch64", bin: "claude.bin", termux: true };
    return js("Termux " + arch + " without an AArch64 kernel");
  }
  if (platform === "linux") {
    const musl = isMusl({ arch, hasFile });
    if (arch === "x64") return { pkg: musl ? "linux-x64-musl" : "linux-x64", bin: "claude.bin" };
    if (arch === "arm64") return { pkg: musl ? "linux-arm64-musl" : "linux-arm64", bin: "claude.bin" };
    return js("no linux build for " + arch);
  }
  return js("unsupported platform " + platform + "/" + arch);
}

// Alpine and other musl images put the loader in different places, so check every known
// path plus the distro marker. Missing one installs the glibc build, which then cannot exec.
export function isMusl({ arch = process.arch, hasFile = () => false } = {}) {
  const names = arch === "arm64" || arch === "arm" ? ["aarch64", "armhf", "armv7"] : ["x86_64", "i386"];
  const roots = ["/lib", "/usr/lib", "/lib64", "/usr/lib64"];
  for (const root of roots) {
    for (const name of names) if (hasFile(root + "/ld-musl-" + name + ".so.1")) return true;
  }
  // Alpine marks itself even when the loader lives somewhere unusual.
  return hasFile("/etc/alpine-release");
}

export function nodeVersionOk(version = process.versions.node) {
  const major = Number(String(version).split(".")[0]);
  return Number.isFinite(major) && major >= 18;
}

export function glibcTooOld(lddOutput = "") {
  const m = /GLIBC\s+(\d+)\.(\d+)/i.exec(String(lddOutput));
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major < 2 || (major === 2 && minor < 27);
}