import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const installer = path.join(repo, "install.mjs");
const isWin = process.platform === "win32";

// Sandbox with an isolated HOME/USERPROFILE, APPDATA and LOCALAPPDATA, so the installer
// never touches the developer's real cc-termux install.
function sandbox(label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), label));
  const home = path.join(tmp, "home");
  const appData = path.join(tmp, "appdata");
  const localAppData = path.join(tmp, "localappdata");
  const work = path.join(tmp, "work");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  return { tmp, home, appData, localAppData, work };
}

// Isolated environment for a child process. PREFIX keeps POSIX shims inside the sandbox;
// APPDATA/LOCALAPPDATA do the same for Windows .cmd shims.
function envFor(s, extra = {}) {
  const env = { ...process.env };
  for (const k of ["CC_TERMUX_ROOT", "CC_TERMUX_CONFIG", "CC_TERMUX_CACHE", "CC_TERMUX_NO_PROMPT", "CC_TERMUX_NO_TUNE", "CC_TERMUX_COMMIT_SHA", "CC_TERMUX_COMMIT_DATE"]) delete env[k];
  env.HOME = s.home;
  env.USERPROFILE = s.home;
  env.APPDATA = s.appData;
  env.LOCALAPPDATA = s.localAppData;
  env.PREFIX = path.join(s.work, "prefix");
  env.CC_TERMUX_NO_BANNER = "1";
  env.CC_TERMUX_NO_PROMPT = "1";
  return { ...env, ...extra };
}

function run(args, env, opts = {}) {
  return spawnSync(process.execPath, args, { cwd: repo, env, encoding: "utf8", ...opts });
}

function nativeRoot() {
  return isWin ? path.join("__LOCALAPPDATA__", "cc-termux") : path.join("__HOME__", ".local", "share", "cc-termux");
}
function resolveInSandbox(s, rel) {
  return rel.replace("__HOME__", s.home).replace("__LOCALAPPDATA__", s.localAppData);
}
function configPath(s) {
  return isWin ? path.join(s.appData, "cc-termux", "config.json") : path.join(s.home, ".config", "cc-termux", "config.json");
}
function claudeShim(s) {
  return isWin ? path.join(s.appData, "npm", "claude.cmd") : path.join(s.home, ".local", "bin", "claude");
}

test("installer --code-only really installs assets, config and shims (per-OS layout)", () => {
  const s = sandbox("cc-codeonly-");
  try {
    const root = resolveInSandbox(s, nativeRoot());
    const binName = isWin ? "claude.exe" : "claude.bin";
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    const binPath = path.join(root, "bin", binName);
    const original = Buffer.from("fake-claude-binary-" + Date.now());
    fs.writeFileSync(binPath, original);
    fs.writeFileSync(path.join(root, "VERSION"), "9.9.9\n");

    const r = run([installer, "--code-only", "--root", root, "--no-setup"], envFor(s));
    assert.equal(r.status, 0, r.stderr || r.stdout);

    // The pre-existing Claude Code build must survive a code-only run.
    assert.deepEqual(fs.readFileSync(binPath), original, "binary must not be replaced");
    assert.equal(fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(), "9.9.9");

    // A real install copied every runtime asset into the root.
    for (const f of ["bin/cc-launcher.mjs", "bin/cc-mcp.mjs", "bin/cc-paths.mjs", "bin/cc-heal.mjs", "proxy/server.mjs", "patches.json", "install.mjs"]) {
      assert.ok(fs.existsSync(path.join(root, f)), "missing installed asset: " + f);
    }

    // Config is created at the resolver's location for this OS.
    const cfg = configPath(s);
    assert.ok(fs.existsSync(cfg), "config must be created at " + cfg);
    const parsed = JSON.parse(fs.readFileSync(cfg, "utf8"));
    assert.deepEqual(parsed.providers, {});
    assert.equal(parsed.listen.port, 8788);

    // Shims are written where the OS expects the user-facing command.
    const shim = claudeShim(s);
    assert.ok(fs.existsSync(shim), "missing claude shim at " + shim);
    assert.match(fs.readFileSync(shim, "utf8"), /cc-launcher\.mjs/);
    if (!isWin) {
      assert.ok(fs.existsSync(path.join(s.work, "prefix", "bin", "cc-termux")), "cc-termux shim in isolated prefix");
      assert.ok(fs.existsSync(path.join(s.work, "prefix", "bin", "ccp")), "ccp shim in isolated prefix");
    } else {
      // Windows layout also includes the new cache directory.
      assert.ok(fs.existsSync(path.join(s.localAppData, "cc-termux", "cache")), "Windows cache dir must be created");
      assert.ok(fs.existsSync(path.join(s.appData, "npm", "cc-termux.cmd")), "cc-termux .cmd shim");
    }

    // The installed CLI is usable.
    const cli = run([path.join(root, "bin", "cc-termux"), "path"], envFor(s, { CC_TERMUX_ROOT: root }));
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.ok(cli.stdout.includes(root), "the CLI must resolve the same install root: " + cli.stdout);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("installer --check prints the resolver paths and honours env overrides", () => {
  const s = sandbox("cc-check-");
  const root = path.join(s.work, "custom-root");
  const cfg = path.join(s.work, "custom-config", "config.json");
  const cache = path.join(s.work, "custom-cache");
  try {
    const r = run([installer, "--check"], envFor(s, { CC_TERMUX_ROOT: root, CC_TERMUX_CONFIG: cfg, CC_TERMUX_CACHE: cache }));
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok(r.stdout.includes("root     : " + root), r.stdout);
    assert.ok(r.stdout.includes("config   : " + cfg), r.stdout);
    assert.ok(r.stdout.includes("cache    : " + cache), r.stdout);
    // --check is a plan only: it must not create any of those paths.
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(path.dirname(cfg)), false);
    assert.equal(fs.existsSync(cache), false);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

// The Windows branch is unreachable by env injection alone, so this probe flips
// process.platform to win32 in a child process and feeds it a fake APPDATA/home.
function resolverProbe(s, extraEnv = {}) {
  const probe = path.join(s.tmp, "cc-paths-probe.mjs");
  const href = JSON.stringify(pathToFileURL(path.join(repo, "bin", "cc-paths.mjs")).href);
  fs.writeFileSync(probe, [
    "Object.defineProperty(process, \"platform\", { value: \"win32\", configurable: true });",
    "const p = await import(" + href + ");",
    "console.log(JSON.stringify({ root: p.installRoot(), config: p.configFile(), cache: p.cacheDir(), claude: p.claudeDir(), windows: p.isWindows }));",
    "",
  ].join("\n"));
  const env = { ...process.env };
  for (const k of ["CC_TERMUX_ROOT", "CC_TERMUX_CONFIG", "CC_TERMUX_CACHE", "CLAUDE_CONFIG_DIR"]) delete env[k];
  env.HOME = s.home;
  env.USERPROFILE = s.home;
  env.LOCALAPPDATA = s.localAppData;
  env.APPDATA = s.appData;
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [probe], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim());
}

test("windows layout: LOCALAPPDATA/APPDATA defaults, legacy fallback and env overrides", () => {
  const s = sandbox("cc-winpaths-");
  try {
    const local = s.localAppData;
    const roaming = s.appData;
    let out = resolverProbe(s);
    assert.equal(out.windows, true);
    assert.equal(out.root, path.join(local, "cc-termux"));
    assert.equal(out.config, path.join(roaming, "cc-termux", "config.json"));
    assert.equal(out.cache, path.join(local, "cc-termux", "cache"));
    assert.equal(out.claude, path.join(s.home, ".claude"), "Claude's own config is never relocated");

    // An existing legacy install (~/.local/share/cc-termux) keeps winning until the new
    // location exists, so upgrades from the old Windows layout keep working.
    fs.mkdirSync(path.join(s.home, ".local", "share", "cc-termux"), { recursive: true });
    fs.mkdirSync(path.join(s.home, ".config", "cc-termux"), { recursive: true });
    fs.writeFileSync(path.join(s.home, ".config", "cc-termux", "config.json"), "{}");
    fs.mkdirSync(path.join(s.home, ".cache", "cc-termux"), { recursive: true });
    out = resolverProbe(s);
    assert.equal(out.root, path.join(s.home, ".local", "share", "cc-termux"));
    assert.equal(out.config, path.join(s.home, ".config", "cc-termux", "config.json"));
    assert.equal(out.cache, path.join(s.home, ".cache", "cc-termux"));

    // Explicit env overrides always beat both layouts.
    out = resolverProbe(s, {
      CC_TERMUX_ROOT: path.join(s.work, "r"),
      CC_TERMUX_CONFIG: path.join(s.work, "c", "config.json"),
      CC_TERMUX_CACHE: path.join(s.work, "k"),
      CLAUDE_CONFIG_DIR: path.join(s.work, "claude"),
    });
    assert.equal(out.root, path.join(s.work, "r"));
    assert.equal(out.config, path.join(s.work, "c", "config.json"));
    assert.equal(out.cache, path.join(s.work, "k"));
    assert.equal(out.claude, path.join(s.work, "claude"));
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});
