#!/usr/bin/env node
// Starts the gateway on its own, for a CLI, editor or app that is not Claude Code.
//
// Everything a client needs is printed in a block that can be copied: the base URL, the
// token, the model ids, and how to reach the MCP server and the skills from that tool.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { installRoot, configFile, configDir, cacheDir } from "./cc-paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), "utf8")); } catch (e) { return {}; }
}

/** Every model this gateway can serve, in the provider/model form clients should use. */
export function modelList(cfg = readConfig()) {
  const out = [];
  for (const [name, p] of Object.entries(cfg.providers || {})) {
    if (p.hidden) continue;
    for (const id of Object.keys(p.modelsById || {})) out.push(name + "/" + id);
  }
  return out;
}

/** The token the gateway requires. Generated once and kept beside the config. */
export function gatewayToken(cfg = readConfig()) {
  if (cfg.gatewayToken) return cfg.gatewayToken;
  const token = crypto.randomBytes(24).toString("base64url");
  try {
    const next = { ...cfg, gatewayToken: token };
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  } catch (e) { }
  return token;
}

/** Where the MCP server and the skills live, so another tool can be pointed at them. */
export function assetPaths(root = ROOT) {
  return {
    mcp: path.join(root, "bin", "cc-mcp.mjs"),
    skills: path.join(root, "skills"),
    claudeSkills: path.join(os.homedir(), ".claude", "skills"),
  };
}

/** The block a user copies into whatever tool they are configuring. */
export function startInstructions({ host = "127.0.0.1", port = 8788, token, cfg = readConfig() } = {}) {
  const base = "http://" + host + ":" + port;
  const models = modelList(cfg);
  const assets = assetPaths();
  return [
    "",
    "  Point any tool at this gateway",
    "  " + "-".repeat(64),
    "",
    "    Base URL       " + base,
    "    OpenAI API     " + base + "/v1        (chat completions, most tools)",
    "    Anthropic API  " + base + "/v1/messages (Claude Code and others)",
    "    API key        " + (token || "(generated on first start)"),
    "",
    "    Models         " + (models.length ? models.length + " available, e.g. " + models.slice(0, 3).join(", ") : "none yet - run: modelmesh setup"),
    "",
    "  For a tool that reads MCP servers (Claude Desktop, Cursor, Zed, Windsurf):",
    "",
    "    " + assets.mcp,
    "",
    "  For a tool that reads skills:",
    "",
    "    " + assets.skills + "   (installed copy: " + assets.claudeSkills + ")",
    "",
    "  Environment variables some tools accept:",
    "",
    "    OPENAI_BASE_URL=" + base + "/v1",
    "    OPENAI_API_KEY=" + (token || "<token>"),
    "    ANTHROPIC_BASE_URL=" + base,
    "    ANTHROPIC_AUTH_TOKEN=" + (token || "<token>"),
    "",
    "  " + "-".repeat(64),
    "  Ctrl-C stops the gateway.",
    "",
  ].join("\n");
}

function healthy(base, timeoutMs = 800) {
  return fetch(base + "/health", { signal: AbortSignal.timeout(timeoutMs) })
    .then((r) => r.ok).catch(() => false);
}

export async function start({ port, quiet = false, foreground = true } = {}) {
  const cfg = readConfig();
  const host = (cfg.listen && cfg.listen.host) || "127.0.0.1";
  const chosen = port || (cfg.listen && cfg.listen.port) || 8788;
  const base = "http://" + host + ":" + chosen;

  if (await healthy(base)) {
    if (!quiet) {
      console.log("  gateway already running on " + base);
      console.log(startInstructions({ host, port: chosen, token: gatewayToken(cfg), cfg }));
    }
    return { alreadyRunning: true, base };
  }

  const token = gatewayToken(cfg);
  const child = spawn(process.execPath, [path.join(ROOT, "proxy", "server.mjs")], {
    env: { ...process.env, MODELMESH_GATEWAY_TOKEN: token },
    stdio: foreground ? ["ignore", "inherit", "inherit"] : ["ignore", "ignore", "ignore"],
    detached: !foreground,
  });
  if (!foreground) child.unref();

  for (let i = 0; i < 150; i++) {
    if (await healthy(base)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!(await healthy(base))) throw new Error("the gateway did not come up on " + base);

  if (!quiet) console.log(startInstructions({ host, port: chosen, token, cfg }));
  return { base, token, child };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? Number(args[portArg + 1]) : undefined;
  const background = args.includes("--background") || args.includes("-d");
  try {
    const r = await start({ port, foreground: !background });
    if (background) process.exit(0);
  } catch (e) {
    console.error("modelmesh start: " + e.message);
    process.exit(1);
  }
}
