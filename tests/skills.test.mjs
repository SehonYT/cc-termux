import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skills = await import("../bin/cc-skills.mjs");
const packDir = path.join(root, "skills");
const catalog = JSON.parse(fs.readFileSync(path.join(packDir, "catalog.json"), "utf8"));

test("every catalog entry ships a valid SKILL.md", () => {
  assert.ok(catalog.skills.length >= 5, "the pack should carry several skills");
  const ids = catalog.skills.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  for (const skill of catalog.skills) {
    const file = path.join(packDir, skill.dir, "SKILL.md");
    assert.ok(fs.existsSync(file), skill.id + " is missing skills/" + skill.dir + "/SKILL.md");
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /^---\r?\n/, skill.id + " needs YAML frontmatter");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    assert.ok(fm, skill.id + " frontmatter is not closed");
    // Claude Code resolves a skill by its directory name, so name must match.
    assert.match(fm[1], new RegExp("^name:\\s*" + skill.name + "\\s*\\r?$", "m"),
      skill.id + " frontmatter name must equal the directory name");
    assert.match(fm[1], /^description:/m, skill.id + " needs a description, it is what triggers the skill");
    assert.ok(text.length > 400, skill.id + " looks empty");
  }
});

test("our own skill descriptions say when to use them, not just what they are", () => {
  // A vendored skill keeps its upstream wording verbatim; only the ones written for
  // cc-termux are held to the trigger-word rule.
  const ours = catalog.skills.filter((s) => s.source === "cc-termux");
  assert.ok(ours.length >= 3, "cc-termux writes several of these");
  for (const skill of ours) {
    const text = fs.readFileSync(path.join(packDir, skill.dir, "SKILL.md"), "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)[1];
    const desc = fm.slice(fm.indexOf("description:"));
    // The description is the only thing the model sees before loading the skill, so it
    // has to carry trigger words, not a summary.
    assert.ok(/[Uu]se (when|whenever|for|on|any)/.test(desc),
      skill.id + " description should say when to use it");
  }
});

test("vendored skills keep their upstream source and licence", () => {
  const vendored = catalog.skills.filter((s) => /github\.com/.test(s.source));
  assert.ok(vendored.length >= 3, "ponytail, agent-browser and frontend-design are vendored");
  for (const skill of vendored) {
    assert.ok(skill.license, skill.id + " must name its upstream licence");
    assert.match(skill.source, /^https:\/\/github\.com\//);
  }
  // frontend-design ships under its own licence file.
  assert.ok(fs.existsSync(path.join(packDir, "frontend-design", "LICENSE.txt")),
    "frontend-design must ship its licence text");
});

test("the pack covers coding, browser, design and cc-termux's own tools", () => {
  const ids = catalog.skills.map((s) => s.id);
  for (const needed of ["ponytail", "agent-browser", "frontend-design", "webapp-quality", "cc-termux-web", "ux-review"]) {
    assert.ok(ids.includes(needed), "pack is missing " + needed);
  }
  const browser = fs.readFileSync(path.join(packDir, "agent-browser", "SKILL.md"), "utf8");
  // Verified on a real Termux device: the package installs chromium-browser and x11-repo
  // is Termux's own repository, while Playwright refuses to run on Android at all.
  assert.match(browser, /chromium-browser/, "the binary is chromium-browser, not chromium");
  assert.match(browser, /pkg install x11-repo && pkg update && pkg install chromium/);
  assert.match(browser, /official repository/, "x11-repo is Termux's own repo");
  assert.match(browser, /headless with no display/, "no X server is needed");
  assert.match(browser, /remote-debugging-port/, "CDP is how tools drive it");
  assert.match(browser, /Unsupported platform: android/, "Playwright and Puppeteer do not run here");
  assert.match(browser, /Never install a browser yourself/, "installing is the user's call, not the agent's");
  assert.match(browser, /never build a browser from source/, "a source build is not a task");
  // The Rust CLI does not run on Termux, so the skill must offer a working fallback.
  assert.match(browser, /Fallback without a browser/);
  assert.match(browser, /mcp__web__fetch/);
  assert.match(browser, /never\s+pretend you opened a page/i, "the honesty rule must survive rewording");
  assert.match(browser, /Never bypass a captcha or bot challenge/);
});

test("the cc-termux-web skill documents the real chain order", () => {
  const text = fs.readFileSync(path.join(packDir, "cc-termux-web", "SKILL.md"), "utf8");
  assert.match(text, /mcp__web__search/);
  assert.match(text, /mcp__web__fetch/);
  assert.match(text, /Antigravity/, "Google grounding is first when Antigravity is active");
  assert.match(text, /Built-in scrapers/, "and the scrapers are always last");
  assert.match(text, /untrusted data/i, "must repeat the injection rule");
});

test("the skills module installs, reports and removes without touching other skills", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-skills-"));
  // claudeDir() uses os.homedir(), which ignores HOME on this platform, so the target is
  // redirected with CLAUDE_CONFIG_DIR instead. Never touch the real ~/.claude.
  const prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  const prevRoot = process.env.CC_TERMUX_ROOT;
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, ".claude");
    process.env.CC_TERMUX_ROOT = path.join(root);
    // A skill the user wrote must survive install and remove.
    const mine = path.join(tmp, ".claude", "skills", "my-own");
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, "SKILL.md"), "---\nname: my-own\ndescription: mine\n---\n\nbody\n");

    {
      const mod = skills;
      const before = mod.skillStatus();
      assert.ok(before.length >= 5);
      assert.ok(before.every((s) => !s.installed), "nothing is installed in a fresh home");

      const installed = mod.installSkills();
      assert.equal(installed.installed.length, before.length);
      for (const s of mod.skillStatus()) assert.ok(s.installed, s.id + " should be installed");
      assert.ok(fs.existsSync(path.join(mine, "SKILL.md")), "the user's own skill is untouched");

      // Installing twice must be safe.
      const again = mod.installSkills();
      assert.equal(again.installed.length, before.length);

      const removed = mod.removeSkills();
      assert.equal(removed.removed.length, before.length);
      assert.ok(fs.existsSync(path.join(mine, "SKILL.md")), "remove must not delete a foreign skill");
      assert.ok(mod.skillStatus().every((s) => !s.installed));
    }
  } finally {
    if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir;
    if (prevRoot === undefined) delete process.env.CC_TERMUX_ROOT; else process.env.CC_TERMUX_ROOT = prevRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the installer ships the pack and the launcher restores it", () => {
  const installer = fs.readFileSync(path.join(root, "install.mjs"), "utf8");
  const launcher = fs.readFileSync(path.join(root, "bin", "cc-launcher.mjs"), "utf8");
  const cli = fs.readFileSync(path.join(root, "bin", "cc-termux"), "utf8");
  const setup = fs.readFileSync(path.join(root, "bin", "cc-setup.mjs"), "utf8");
  assert.match(installer, /"docs", "skills"\]/, "the installer must ship skills/");
  assert.match(installer, /installSkillsQuietly\(\)/);
  assert.match(installer, /installSkills\(\{ force: false \}\)/, "an existing skill must not be overwritten");
  assert.match(launcher, /installSkills\(\{ force: false \}\)/, "the launcher restores missing skills");
  assert.match(cli, /case "skills": \{/);
  assert.match(setup, /if \(a === "s"\) \{ await skillsFlow\(\); continue; \}/);
  assert.match(setup, /async function skillsFlow\(\)/);
});
