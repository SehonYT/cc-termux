import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const uninstaller = await import("../bin/cc-uninstall.mjs");

// A sandbox that looks like a real machine with Claude Code already set up.
function sandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-un-"));
  const home = path.join(tmp, "home");
  const claude = path.join(home, ".claude");
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const previous = {};
  const set = (k, v) => { previous[k] = process.env[k]; process.env[k] = v; };
  set("HOME", home);
  set("USERPROFILE", home);
  set("CLAUDE_CONFIG_DIR", claude);
  set("CC_TERMUX_ROOT", path.join(home, ".local", "share", "cc-termux"));
  set("CC_TERMUX_CONFIG", path.join(home, ".config", "cc-termux", "config.json"));
  return {
    tmp, home, claude, bin,
    cleanup() {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test("the removal plan separates what it owns from what it shares", () => {
  const box = sandbox();
  try {
    const plan = uninstaller.removalPlan();
    assert.ok(plan.length >= 8);
    // Claude Code's own settings are never in the delete list.
    for (const item of plan.filter((p) => p.kind === "owned")) {
      assert.doesNotMatch(item.target, /\.claude[/\\]settings\.json$/, "settings.json is shared, not owned");
      assert.doesNotMatch(item.target, /\.claude\.json$/, "~/.claude.json is shared, not owned");
    }
    const shared = plan.filter((p) => p.kind === "restore").map((p) => p.label);
    assert.ok(shared.some((l) => /permission/.test(l)));
    assert.ok(shared.some((l) => /MCP server/.test(l)));
    assert.ok(shared.some((l) => /skills/.test(l)));
  } finally { box.cleanup(); }
});

test("restoring Claude Code removes only what cc-termux added", () => {
  const box = sandbox();
  try {
    const settings = path.join(box.claude, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({
      model: "sonnet",
      statusLine: { type: "command", command: "my-own-statusline" },
      permissions: { allow: ["Bash(git status)", "mcp__web__search", "mcp__web__fetch"], deny: ["Read(~/.ssh/**)"] },
      env: { MY_OWN_KEY: "keep-me", ANTHROPIC_BASE_URL: "http://127.0.0.1:8788", ANTHROPIC_AUTH_TOKEN: "t" },
    }, null, 2));
    fs.writeFileSync(path.join(box.home, ".claude.json"), JSON.stringify({
      mcpServers: { web: { command: "x" }, myOwnServer: { command: "other" } },
      numStartups: 12,
    }, null, 2));

    uninstaller.restoreClaudeCode();
    const s = JSON.parse(fs.readFileSync(settings, "utf8"));
    const cj = JSON.parse(fs.readFileSync(path.join(box.home, ".claude.json"), "utf8"));

    assert.equal(s.model, "sonnet", "an unrelated setting is kept");
    assert.equal(s.env.MY_OWN_KEY, "keep-me", "the user's own env var is kept");
    assert.equal(s.env.ANTHROPIC_BASE_URL, undefined, "the gateway pointer is removed");
    assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.deepEqual(s.permissions.allow, ["Bash(git status)"], "only our allow entries go");
    assert.deepEqual(s.permissions.deny, ["Read(~/.ssh/**)"], "the user's deny rules stay");
    assert.equal(s.statusLine.command, "my-own-statusline", "the user's own status line is kept");
    assert.equal(cj.mcpServers.web, undefined, "our MCP server is removed");
    assert.ok(cj.mcpServers.myOwnServer, "another MCP server the user had is kept");
    assert.equal(cj.numStartups, 12, "unrelated state is kept");
  } finally { box.cleanup(); }
});

test("a settings file with nothing of ours is left byte for byte", () => {
  const box = sandbox();
  try {
    const settings = path.join(box.claude, "settings.json");
    const original = JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] } }, null, 2) + "\n";
    fs.writeFileSync(settings, original);
    const done = uninstaller.restoreClaudeCode();
    assert.equal(fs.readFileSync(settings, "utf8"), original, "an untouched file must not be rewritten");
    assert.ok(done.every((d) => !d.changed || d.what !== "settings.json"));
  } finally { box.cleanup(); }
});

test("a missing or corrupt settings file is not a crash", () => {
  const box = sandbox();
  try {
    const settings = path.join(box.claude, "settings.json");
    // Not JSON at all: it must be left alone rather than destroyed.
    fs.writeFileSync(settings, "{ this is not json");
    uninstaller.restoreClaudeCode();
    assert.equal(fs.readFileSync(settings, "utf8"), "{ this is not json");
    fs.rmSync(settings);
    uninstaller.restoreClaudeCode();
    assert.ok(!fs.existsSync(settings), "a missing file stays missing");
  } finally { box.cleanup(); }
});

test("only a cc-termux shim is replaced by the official launcher", () => {
  const box = sandbox();
  try {
    const shim = path.join(box.bin, "claude");
    const official = path.join(box.bin, "claude.official-backup");
    fs.writeFileSync(official, "#!/bin/sh\nexec /usr/bin/claude \"$@\"\n", { mode: 0o755 });

    // A launcher the user installed themselves must not be touched.
    fs.writeFileSync(shim, "#!/bin/sh\nexec /usr/bin/claude \"$@\"\n", { mode: 0o755 });
    let r = uninstaller.restoreLauncher();
    assert.equal(r.restored, false);
    assert.match(r.reason, /not a cc-termux shim/);
    assert.match(fs.readFileSync(shim, "utf8"), /\/usr\/bin\/claude/);

    // Our shim is replaced by the backup.
    fs.writeFileSync(shim, "#!/bin/sh\nexec node \"\$HOME/.local/share/cc-termux/bin/cc-launcher.mjs\" \"$@\"\n");
    r = uninstaller.restoreLauncher();
    assert.equal(r.restored, true);
    assert.match(fs.readFileSync(shim, "utf8"), /\/usr\/bin\/claude/, "the original is back");
    assert.ok(!fs.readFileSync(shim, "utf8").includes("cc-launcher"), "the shim is gone");
  } finally { box.cleanup(); }
});

test("the skill pack leaves a skill the user edited", async () => {
  const box = sandbox();
  try {
    const skills = await import("../bin/cc-skills.mjs");
    process.env.CC_TERMUX_ROOT = root;
    await skills.installSkills();
    const target = skills.skillsTarget();
    const mine = path.join(target, "my-own");
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, "SKILL.md"), "---\nname: my-own\ndescription: mine\n---\nbody\n");
    // Edit one of ours so it counts as the user's.
    const edited = path.join(target, "ponytail", "SKILL.md");
    fs.writeFileSync(edited, fs.readFileSync(edited, "utf8") + "\n## my note\n");

    const r = await uninstaller.removeSkillPack();
    assert.ok(r.removed.includes("security-audit"), "untouched skills are removed");
    assert.ok(r.kept.includes("ponytail"), "an edited skill is kept");
    assert.ok(fs.existsSync(path.join(mine, "SKILL.md")), "a foreign skill is never removed");
    assert.ok(fs.existsSync(edited), "the edited skill is still on disk");
  } finally { box.cleanup(); }
});

test("the CLI exposes uninstall and the plan is safe by default", () => {
  const cli = fs.readFileSync(path.join(root, "bin", "cc-termux"), "utf8");
  assert.match(cli, /case "uninstall": \{/);
  assert.match(cli, /cc-uninstall\.mjs/);
  const src = fs.readFileSync(path.join(root, "bin", "cc-uninstall.mjs"), "utf8");
  // Deleting requires an explicit flag; the default is a plan.
  assert.match(src, /if \(!yes\) \{/);
  assert.match(src, /dry-run/);
  assert.match(src, /--keep-config/);
});
