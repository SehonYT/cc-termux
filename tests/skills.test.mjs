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
  for (const needed of ["ponytail", "agent-browser", "frontend-design", "webapp-quality", "cc-termux-web", "ux-review", "security-audit", "secrets-and-keys", "dep-audit"]) {
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
  assert.match(text, /chain:generated/, "the order is generated, never hardcoded");
  assert.match(text, /untrusted data/i, "must repeat the injection rule");
});

test("the skills module installs, reports and removes without touching other skills", async () => {
  await withTarget(async (tmp) => {
    // A skill the user wrote must survive install and remove.
    const mine = path.join(tmp, ".claude", "skills", "my-own");
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, "SKILL.md"), "---\nname: my-own\ndescription: mine\n---\n\nbody\n");

    const before = skills.skillStatus();
    assert.ok(before.length >= 5);
    assert.ok(before.every((s) => !s.installed), "nothing is installed in a fresh home");

    const installed = await skills.installSkills();
    assert.equal(installed.installed.length, before.length);
    for (const s of skills.skillStatus()) assert.ok(s.installed, s.id + " should be installed");
    assert.ok(fs.existsSync(path.join(mine, "SKILL.md")), "the user's own skill is untouched");

    // Installing twice must be safe: the second run refreshes, it never re-installs.
    const again = await skills.installSkills();
    assert.equal(again.installed.length, 0, "nothing is installed twice");
    assert.equal(again.kept.length + again.updated.length, before.length, "every skill is accounted for");
    assert.ok(fs.existsSync(path.join(mine, "SKILL.md")), "the user's own skill survives a second run");

    const removed = skills.removeSkills();
    assert.equal(removed.removed.length, before.length);
    assert.ok(fs.existsSync(path.join(mine, "SKILL.md")), "remove must not delete a foreign skill");
    assert.ok(skills.skillStatus().every((s) => !s.installed));
  });
});

// Every test below that writes skills redirects the target and awaits the now-async API.
function withTarget(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-skillup-"));
  const prevDir = process.env.CLAUDE_CONFIG_DIR;
  const prevRoot = process.env.CC_TERMUX_ROOT;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, ".claude");
  process.env.CC_TERMUX_ROOT = root;
  return Promise.resolve()
    .then(() => fn(tmp))
    .finally(() => {
      if (prevDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevDir;
      if (prevRoot === undefined) delete process.env.CC_TERMUX_ROOT; else process.env.CC_TERMUX_ROOT = prevRoot;
      fs.rmSync(tmp, { recursive: true, force: true });
    });
}

test("an update never overwrites a skill the user edited", async () => {
  await withTarget(async () => {
    await skills.installSkills();
    const file = path.join(skills.skillsTarget(), "ponytail", "SKILL.md");
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, original + "\n## my own note\n");
    const cmp = skills.compareSkill({ id: "ponytail", name: "ponytail", dir: "ponytail" });
    assert.equal(cmp.state, "modified");
    assert.deepEqual(cmp.edited, ["SKILL.md"]);

    const r = await skills.installSkills();
    assert.ok(r.kept.some((k) => k.id === "ponytail"), "the edited skill must be reported as kept");
    assert.match(fs.readFileSync(file, "utf8"), /my own note/, "the edit must survive the update");
  });
});

test("--force is the only way to overwrite an edited skill", async () => {
  await withTarget(async () => {
    await skills.installSkills();
    const file = path.join(skills.skillsTarget(), "ponytail", "SKILL.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8") + "\n## note to be replaced\n");
    await skills.installSkills({ force: true });
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /note to be replaced/);
  });
});

test("a deleted file is restored even when another file was edited", async () => {
  await withTarget(async () => {
    await skills.installSkills();
    const dir = path.join(skills.skillsTarget(), "frontend-design");
    fs.writeFileSync(path.join(dir, "SKILL.md"), fs.readFileSync(path.join(dir, "SKILL.md"), "utf8") + "\n## keep me\n");
    fs.rmSync(path.join(dir, "LICENSE.txt"));
    await skills.installSkills();
    assert.ok(fs.existsSync(path.join(dir, "LICENSE.txt")), "the missing file must come back");
    assert.match(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), /keep me/, "the edit is still kept");
  });
});

test("status distinguishes installed, outdated and locally modified", async () => {
  await withTarget(async () => {
    assert.ok(skills.skillStatus().every((s) => !s.installed), "nothing installed yet");
    await skills.installSkills();
    assert.ok(skills.skillStatus().every((s) => s.installed && s.state === "unchanged"));
    const file = path.join(skills.skillsTarget(), "ux-review", "SKILL.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8") + "\nlocal\n");
    const one = skills.skillStatus().find((s) => s.id === "ux-review");
    assert.equal(one.state, "modified");
    assert.match(skills.formatSkills(skills.skillStatus()), /! ux-review/, "the marker must show in the listing");
  });
});

test("the security skills carry real guidance", () => {
  const audit = fs.readFileSync(path.join(packDir, "security-audit", "SKILL.md"), "utf8");
  assert.ok(audit.length > 5000, "the audit skill is substantial");
  // Cloudflare's skill ships reference docs and runnable validators beside SKILL.md.
  for (const extra of ["HUNTING.md", "RECONNAISSANCE.md", "report-schema.json", "validate-findings.cjs"]) {
    assert.ok(fs.existsSync(path.join(packDir, "security-audit", extra)), "missing " + extra);
  }
  assert.ok(fs.existsSync(path.join(packDir, "security-audit", "LICENSE.txt")), "vendored code keeps its licence");

  const secrets = fs.readFileSync(path.join(packDir, "secrets-and-keys", "SKILL.md"), "utf8");
  assert.match(secrets, /0o600/, "config files must be created private");
  assert.match(secrets, /[Rr]otate/, "a leaked key needs rotation, not just deletion");
  assert.match(secrets, /git diff --cached/, "a pre-commit check belongs in the skill");

  const deps = fs.readFileSync(path.join(packDir, "dep-audit", "SKILL.md"), "utf8");
  assert.match(deps, /typosquat|real package/i, "package identity is the first check");
  assert.match(deps, /lockfile/i);
  assert.match(deps, /install script/i);
});

test("the generated provider line is built from the live provider table", async () => {
  const line = await skills.providerChainSummary();
  assert.ok(line.length > 0, "a summary is produced");
  const wp = await import("../bin/cc-webproviders.mjs");
  const google = wp.PROVIDER_INFO.google.label;
  assert.ok(line.includes(google), "Antigravity grounding leads the summary");
  for (const id of ["tavily", "brave", "jina", "local"]) {
    const label = wp.PROVIDER_INFO[id].label.replace(/ \(.*\)$/, "");
    assert.ok(line.includes(label), "the summary must name " + id);
  }
  // The skill carries the sentence, not a hardcoded copy of the order.
  const text = fs.readFileSync(path.join(packDir, "cc-termux-web", "SKILL.md"), "utf8");
  assert.match(text, /chain:generated/, "the generated line needs its marker");
  assert.match(text, /cc-termux web status/, "the skill must point at the live order");
});

test("install refreshes the generated line in place", async () => {
  await withTarget(async () => {
    await skills.installSkills();
    const file = path.join(skills.skillsTarget(), "cc-termux-web", "SKILL.md");
    // Simulate a stale order written by an older install.
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^1\. .*$/m, "1. DuckDuckGo, then Bing."));
    await skills.installSkills({ force: true });
    const line = await skills.providerChainSummary();
    const updated = fs.readFileSync(file, "utf8");
    // Compare on plain strings: the sentence is data, not a pattern.
    assert.ok(updated.includes("1. " + line + "."), "the stale order is replaced with the generated one");
    assert.ok(!updated.includes("DuckDuckGo, then Bing."), "the old text is gone");
  });
});

test("vendored skills are pinned to an upstream source", () => {
  const vendored = catalog.skills.filter((s) => s.upstream);
  assert.ok(vendored.length >= 3, "ponytail, frontend-design and security-audit are vendored");
  for (const skill of vendored) {
    assert.match(skill.upstream.base, /^https:\/\/raw\.githubusercontent\.com\//);
    assert.ok(Array.isArray(skill.upstream.files) && skill.upstream.files.length, skill.id + " pins its files");
    // Every pinned file must be one we actually ship, or a sync would write a new file.
    for (const file of skill.upstream.files) {
      assert.ok(fs.existsSync(path.join(packDir, skill.dir, file)), skill.id + " pins " + file + " but does not ship it");
    }
  }
  // agent-browser is adapted for Termux, so it must NOT be synced: an upstream overwrite
  // would silently drop the platform guidance.
  const browser = catalog.skills.find((s) => s.id === "agent-browser");
  assert.equal(browser.upstream, undefined, "the adapted skill must stay out of sync");
});

test("a sync reports changes and writes nothing without --apply", async () => {
  await withTarget(async () => {
    await skills.installSkills();
    const upstream = new Map();
    for (const skill of skills.vendoredSources()) {
      for (const file of skill.upstream.files) {
        upstream.set(skill.upstream.base + "/" + file, "upstream content for " + file);
      }
    }
    const fakeFetch = async (url) => ({ ok: true, status: 200, text: async () => upstream.get(url) ?? "x" });

    // Everything differs from the fake upstream, so every file is reported.
    const dry = await skills.syncUpstream({ fetchImpl: fakeFetch, only: ["ponytail"] });
    assert.equal(dry.length, 1);
    assert.equal(dry[0].changes[0].status, "different");
    const file = path.join(skills.skillsTarget(), "ponytail", "SKILL.md");
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /upstream content/, "a dry run must not write");

    const applied = await skills.syncUpstream({ fetchImpl: fakeFetch, only: ["ponytail"], apply: true });
    assert.equal(applied[0].changes[0].status, "different");
    assert.match(fs.readFileSync(file, "utf8"), /upstream content for SKILL\.md/, "--apply writes it");
  });
});

test("a sync survives an unreachable or failing upstream", async () => {
  await withTarget(async () => {
    await skills.installSkills();
    const before = fs.readFileSync(path.join(skills.skillsTarget(), "ponytail", "SKILL.md"), "utf8");
    const failing = async () => { throw new Error("network down"); };
    const results = await skills.syncUpstream({ fetchImpl: failing, only: ["ponytail"], apply: true });
    assert.equal(results[0].changes[0].status, "fetch-failed");
    assert.equal(fs.readFileSync(path.join(skills.skillsTarget(), "ponytail", "SKILL.md"), "utf8"), before, "a failed fetch changes nothing");
    assert.match(skills.formatSync(results), /could not check/);
  });
});

test("sync output names what changed", async () => {
  await withTarget(async () => {
    await skills.installSkills();
    const upstream = new Map();
    for (const skill of skills.vendoredSources()) {
      for (const file of skill.upstream.files) upstream.set(skill.upstream.base + "/" + file, "new");
    }
    const fakeFetch = async (url) => ({ ok: true, status: 200, text: async () => upstream.get(url) ?? "x" });
    const r = await skills.syncUpstream({ fetchImpl: fakeFetch, only: ["ponytail"] });
    const text = skills.formatSync(r);
    assert.match(text, /ponytail/);
    assert.match(text, /1 file\(s\) changed upstream/);
    assert.match(text, /~ SKILL\.md/);
  });
});

test("the CLI exposes sync with a dry run by default", () => {
  const src = fs.readFileSync(path.join(root, "bin", "cc-skills.mjs"), "utf8");
  const cli = fs.readFileSync(path.join(root, "bin", "cc-termux"), "utf8");
  assert.match(src, /cmd === "sync"/);
  assert.match(src, /--apply/);
  assert.match(src, /run again with --apply/);
  assert.match(cli, /skills \[install\|status/);
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
