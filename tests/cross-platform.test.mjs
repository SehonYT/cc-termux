import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Every module that runs on a user's machine, not just in tests.
function shippedModules() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.mjs$/.test(e.name) && !/\.test\.mjs$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(root, "bin"));
  walk(path.join(root, "proxy"));
  out.push(path.join(root, "install.mjs"));
  return out;
}

const modules = shippedModules();

test("no shipped module hardcodes a POSIX home path", () => {
  // A hardcoded ~/.local/share/modelmesh ignores MODELMESH_ROOT and the Windows layout.
  // This is the defect that broke doctor on Windows and cc-patch on a custom root.
  for (const file of modules) {
    const src = fs.readFileSync(file, "utf8");
    src.split("\n").forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return; // a comment may quote a path to explain it
      // Only modelmesh's own root must be resolved; ~/.local/share/claude is Claude Code's
      // directory, which is a fixed POSIX layout by its own definition.
      const isOurs = /"modelmesh"|"share",\s*"modelmesh"/.test(line);
      assert.ok(!isOurs || !/homedir\(\)/.test(line),
        path.relative(root, file) + ":" + (i + 1) + " hardcodes a POSIX install root");
      // A tilde inside a printed message is documentation for the reader, not a path the
      // code resolves, so only a tilde that reaches the filesystem counts.
      const tildeUsedAsPath = /"~\/\.local|'~\/\.local/.test(line) && /path\.|fs\.|readFile|writeFile|mkdir|existsSync/.test(line);
      assert.ok(!tildeUsedAsPath,
        path.relative(root, file) + ":" + (i + 1) + " passes a tilde path to the filesystem");
    });
  }
});

test("the install root is always resolved through cc-paths", () => {
  const paths = fs.readFileSync(path.join(root, "bin", "cc-paths.mjs"), "utf8");
  assert.match(paths, /export function installRoot\(/);
  // Anything needing the root must import it rather than recompute it.
  for (const file of modules) {
    const src = fs.readFileSync(file, "utf8");
    if (!/modelmesh/.test(src)) continue;
    const recomputed = /path\.join\(os\.homedir\(\),\s*"\.local",\s*"share",\s*"modelmesh"\)/.test(src);
    if (recomputed) {
      const name = path.relative(root, file);
      assert.ok(/installRoot/.test(src), name + " recomputes the install root instead of importing installRoot");
    }
  }
});

test("chmod is never assumed to work", () => {
  // On Windows chmod is a no-op that does not throw, but the mode is meaningless. A bare
  // chmodSync outside a try is a crash risk on filesystems that refuse it.
  for (const file of modules) {
    const src = fs.readFileSync(file, "utf8");
    src.split("\n").forEach((line, i) => {
      if (!/fs\.chmodSync\(/.test(line)) return;
      // Either wrapped in try, guarded by platform, or inside a mode option.
      const around = src.split("\n").slice(Math.max(0, i - 6), i + 2).join("\n");
      // Safe when wrapped in try/catch, inside a non-Windows branch, or a mode option.
      const safe = /try \{|catch|platform === "win32"|platform !== "win32"|mode:|\{ mode/.test(around) || line.includes("try");
      assert.ok(safe, path.relative(root, file) + ":" + (i + 1) + " chmod is not guarded");
    });
  }
});

test("platform-specific filesystem paths are probed, never assumed", () => {
  for (const file of modules) {
    const src = fs.readFileSync(file, "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      // /proc exists on Linux and Android only.
      if (/"\/proc/.test(line)) {
        const around = lines.slice(Math.max(0, i - 12), i + 2).join("\n");
        assert.ok(/platform === "linux"|platform !== "win32"|try \{|existsSync\("\/proc/.test(around),
          path.relative(root, file) + ":" + (i + 1) + " reads /proc without a platform guard or an existence check");
      }
      // /usr/local is a real path on POSIX and meaningless on Windows.
      if (/"\/usr\/local"/.test(line)) {
        const around = lines.slice(Math.max(0, i - 6), i + 3).join("\n");
        assert.ok(/exists\(|existsSync|win32|platform/.test(around),
          path.relative(root, file) + ":" + (i + 1) + " assumes /usr/local exists");
      }
    });
  }
});

test("a runtime-written shim is only written on a platform that can run it", () => {
  for (const file of modules) {
    const src = fs.readFileSync(file, "utf8");
    if (!/#!\/bin\/sh/.test(src)) continue;
    // A POSIX shell shim must be guarded, or Windows gets an unexecutable file.
    assert.ok(/win32|\.cmd/.test(src),
      path.relative(root, file) + " writes a POSIX shim without handling Windows");
  }
});

test("process signals are guarded where the platform lacks them", () => {
  for (const file of modules) {
    const src = fs.readFileSync(file, "utf8");
    src.split("\n").forEach((line, i) => {
      if (!/process\.kill\(/.test(line)) return;
      // SIGTERM/SIGKILL are not meaningful on Windows; signal 0 is a portable liveness probe.
      const sig = /process\.kill\([^,]+,\s*"(SIGTERM|SIGKILL|SIGHUP|SIGINT)"/.test(line);
      if (!sig) return;
      const around = src.split("\n").slice(Math.max(0, i - 8), i + 2).join("\n");
      assert.ok(/try \{|catch|win32|platform/.test(around),
        path.relative(root, file) + ":" + (i + 1) + " sends a POSIX signal unguarded");
    });
  }
});

test("the Windows shim directory is never a POSIX path", () => {
  const heal = fs.readFileSync(path.join(root, "bin", "cc-heal.mjs"), "utf8");
  // resolvePrefix must branch before falling through to /usr/local.
  const fn = /export function resolvePrefix\([\s\S]*?\n\}/.exec(heal)[0];
  assert.match(fn, /win32/, "resolvePrefix handles win32");
  assert.ok(fn.indexOf("win32") < fn.indexOf("/usr/local"), "the win32 branch comes first");
  assert.match(fn, /LOCALAPPDATA|APPDATA/, "and uses the Windows app data directory");
});

test("paths built for a child process survive Windows separators", () => {
  // path.join output is passed to spawned processes; the separator must come from the host.
  for (const file of modules) {
    const src = fs.readFileSync(file, "utf8");
    src.split("\n").forEach((line, i) => {
      // A hand-built path with a literal separator is the defect.
      assert.ok(!/path\.join\([^)]*\)\s*\+\s*"\//.test(line),
        path.relative(root, file) + ":" + (i + 1) + " concatenates a forward slash onto a joined path");
    });
  }
});

test("a pre-rename install root is migrated, not abandoned", () => {
  // The reported upgrade failure: an install at ~/.local/share/cc-termux, updated by a
  // binary that now resolves the new name, so the installer looked for the Claude Code
  // binary in a directory the migration had already emptied.
  const paths = fs.readFileSync(path.join(root, "bin", "cc-paths.mjs"), "utf8");
  assert.match(paths, /export function migrateDir/, "there is a migration helper");
  // Merging, not skipping: a destination created moments earlier is empty, and treating it
  // as already-migrated is what left the real data behind.
  const fn = /export function migrateDir\(from, to\) \{[\s\S]*?\n\}/.exec(paths)[0];
  assert.ok(!/if \(exists\(to\) \|\| !exists\(from\)\) return to;/.test(fn), "an existing destination must not short-circuit");
  assert.match(fn, /fs\.readdirSync\(from\)/, "it walks the old directory");
  assert.match(fn, /if \(exists\(dst\)\) continue;/, "and keeps whatever is already there");
  assert.match(fn, /rmdirSync\(from\)/, "removing the old directory only when it is empty");

  const installer = fs.readFileSync(path.join(root, "install.mjs"), "utf8");
  assert.match(installer, /function canonicalRoot\(requested\)/, "the installer resolves an old --root");
  // installRoot() migrates as a side effect, so the requested path may already be gone.
  assert.match(installer, /if \(!fs\.existsSync\(requested\)\) \{/, "a requested path that vanished is followed to the canonical one");
  assert.match(installer, /install root moved to/, "and the move is reported");
});

test("the updater migrates the root before handing it to the installer", () => {
  const updater = fs.readFileSync(path.join(root, "bin", "cc-update.mjs"), "utf8");
  // The device's own updater is the old one and passes the old path on.
  assert.match(updater, /paths\.migrateDir\(root, canonical\)/, "the updater migrates first");
  assert.match(updater, /install root moved/, "and says what it did");
});

test("the config, cache and root paths are absolute on every platform", () => {
  // Exercised through the real resolvers, so a change to them is caught here.
  const prev = { ...process.env };
  try {
    delete process.env.MODELMESH_ROOT;
    delete process.env.MODELMESH_CONFIG;
    delete process.env.MODELMESH_CACHE;
    return import("../bin/cc-paths.mjs").then((p) => {
      for (const [name, value] of [["installRoot", p.installRoot()], ["configFile", p.configFile()], ["cacheDir", p.cacheDir()], ["claudeDir", p.claudeDir()]]) {
        assert.ok(path.isAbsolute(value), name + " must be absolute, got " + value);
        assert.ok(!value.includes(".."), name + " must not contain a traversal");
      }
    });
  } finally {
    for (const [k, v] of Object.entries(prev)) process.env[k] = v;
  }
});
