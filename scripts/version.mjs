#!/usr/bin/env node
// Build version: <base>+<short commit>, e.g. 0.2.0+6ce099b.
// Git tags use a dash instead of + for tooling friendliness: v0.2.0-6ce099b.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

function sha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

export function buildVersion(baseVersion = base, commit = sha()) {
  const short = String(commit || "").slice(0, 7);
  return short ? baseVersion + "+" + short : baseVersion;
}

export function buildTag(baseVersion = base, commit = sha()) {
  return "v" + buildVersion(baseVersion, commit).replace("+", "-");
}

export function labelVersion(version, commit) {
  if (!commit) return String(version || "");
  return String(version || "").split("+")[0] + "+" + String(commit).slice(0, 7);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--tag")) console.log(buildTag());
  else console.log(buildVersion());
}