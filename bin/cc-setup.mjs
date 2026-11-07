#!/usr/bin/env node
// Interactive provider setup: selects a provider, validates the key, fetches models,
// writes config.json/keys.json and regenerates the /model picker.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HOME = os.homedir();
const ROOT = process.env.CC_TERMUX_ROOT || path.join(HOME, ".local", "share", "cc-termux");
const CFG = process.env.CC_TERMUX_CONFIG || path.join(HOME, ".config", "cc-termux", "config.json");
const SETTINGS = path.join(HOME, ".claude", "settings.json");
const CACHE_DIR = path.join(HOME, ".cache", "cc-termux");
const CATALOG = path.join(CACHE_DIR, "catalog.json");
const PRESETS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "presets.json");
function loadPresets() { try { return JSON.parse(fs.readFileSync(PRESETS_PATH, "utf8")); } catch (e) { return { free: [] }; } }
const ESC = String.fromCharCode(27);
const color = (code, str) => process.stdout.isTTY ? ESC + "[" + code + "m" + str + ESC + "[0m" : str;
const cyan = (s) => process.stdout.isTTY ? ESC + "[36m" + s + ESC + "[0m" : s;
const bold = (s) => process.stdout.isTTY ? ESC + "[1m" + s + ESC + "[0m" : s;
const dim = (s) => process.stdout.isTTY ? ESC + "[2m" + s + ESC + "[0m" : s;

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); });
  });
}

function askHidden(prompt) {
  if (!process.stdin.isTTY) return ask(prompt);
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const cleanup = () => { stdin.removeListener("data", onData); stdin.setRawMode(false); stdin.pause(); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") { cleanup(); process.stdout.write("\n"); resolve(buf); return; }
        if (ch === "\u0003") { cleanup(); process.stdout.write("\n"); process.exit(130); }
        if (ch === "\u007f") { buf = buf.slice(0, -1); process.stdout.write("\b \b"); continue; }
        buf += ch;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

const fmtCtx = (n) => !n ? "?" : n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n);

function parseCatalogHtml(html) {
  const rows = html.split("<tr").slice(1);
  const out = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#x27;/g, String.fromCharCode(39)).replace(/\s+/g, " ").trim());
    if (cells.length < 6) continue;
    const idm = cells[1].match(/([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+|[a-z0-9][a-z0-9._-]{4,})$/);
    if (!idm) continue;
    const id = idm[1];
    const nameCell = cells[1].slice(0, cells[1].length - id.length).trim();
    const ctxLabel = cells[3] || "";
    const mm = ctxLabel.match(/^([\d.]+)\s*([KMG])$/i);
    const contextTokens = mm ? Math.round(parseFloat(mm[1]) * ({ K: 1e3, M: 1e6, G: 1e9 })[mm[2].toUpperCase()]) : null;
    out.push({ id, name: nameCell, contextTokens, contextLabel: ctxLabel,
      inUsd: parseFloat((cells[4] || "").replace(/[^0-9.]/g, "")),
      outUsd: parseFloat((cells[5] || "").replace(/[^0-9.]/g, "")), plans: cells[6] || "" });
  }
  return out;
}

async function fetchTokensModels(key) {
  const r = await fetch("https://tokens.bd/v1/models", { headers: { authorization: "Bearer " + key } });
  if (!r.ok) throw new Error("tokens.bd /v1/models HTTP " + r.status + " - check the API key");
  const j = await r.json();
  const ids = new Set((j.data || j || []).map(m => m.id));
  let models = [];
  try {
    const page = await fetch("https://tokens.bd/models");
    models = parseCatalogHtml(await page.text()).filter(m => ids.has(m.id));
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CATALOG, JSON.stringify({ fetchedAt: new Date().toISOString(), models }, null, 1));
  } catch (e) { }
  if (!models.length) models = [...ids].map(id => ({ id, name: id, contextTokens: null, inUsd: null, outUsd: null }));
  return models;
}

async function fetchOpenRouterModels(key) {
  const r = await fetch("https://openrouter.ai/api/v1/models", { headers: key ? { authorization: "Bearer " + key } : {} });
  if (!r.ok) throw new Error("OpenRouter /models HTTP " + r.status);
  const j = await r.json();
  const arr = (j.data || []).map(m => ({ id: m.id, name: m.name || m.id, contextTokens: m.context_length || null,
    inUsd: m.pricing && m.pricing.prompt != null ? +(parseFloat(m.pricing.prompt) * 1e6).toFixed(3) : null,
    outUsd: m.pricing && m.pricing.completion != null ? +(parseFloat(m.pricing.completion) * 1e6).toFixed(3) : null }));
  const ids = arr.map(m => m.id);
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(CATALOG, JSON.stringify({ fetchedAt: new Date().toISOString(), models: arr }, null, 1)); } catch (e) { }
  return arr;
}

async function fetchGeminiModels(key) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" + encodeURIComponent(key) + "&pageSize=200");
  if (!r.ok) throw new Error("Gemini models HTTP " + r.status + " - check the API key");
  const j = await r.json();
  const arr = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
    .filter(m => !/tts|embedding|imagen|veo|live|aqa|native-audio/i.test(m.name || ""))
    .map(m => ({ id: (m.name || "").replace(/^models\//, ""), name: m.displayName || m.name, contextTokens: m.inputTokenLimit || null, inUsd: null, outUsd: null }));
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(CATALOG, JSON.stringify({ fetchedAt: new Date().toISOString(), models: arr }, null, 1)); } catch (e) { }
  return arr;
}

function presetStaticModels(preset) {
  return (preset.models || []).filter(Boolean).map((m) => {
    if (typeof m === "string") return { id: m, name: m, contextTokens: null, inUsd: null, outUsd: null };
    return { id: m.id || m.name, name: m.name || m.id, contextTokens: m.contextTokens || null, inUsd: m.inUsd == null ? null : m.inUsd, outUsd: m.outUsd == null ? null : m.outUsd };
  });
}

async function fetchPresetModels(preset, key) {
  if (preset.kind === "gemini") return await fetchGeminiModels(key);
  if (preset.modelsPath === null && (preset.models || []).length) return presetStaticModels(preset);
  const url = String(preset.baseUrl).replace(/\/$/, "") + (preset.modelsPath || "/models");
  try {
    const r = await fetch(url, { headers: key ? { authorization: "Bearer " + key } : {} });
    if (!r.ok) throw new Error(preset.name + " /models HTTP " + r.status + " - check the key");
    let j;
    try { j = await r.json(); } catch (e) { throw new Error(preset.name + " /models did not return JSON"); }
    const arr = j.data || j.models || j;
    let models = (Array.isArray(arr) ? arr : []).map((m) => ({
      id: m.id || m.name,
      name: m.name || m.id,
      contextTokens: m.context_length || m.max_context_length || m.inputTokenLimit || null,
      inUsd: m.pricing && m.pricing.prompt != null ? +(parseFloat(m.pricing.prompt) * 1e6).toFixed(3) : null,
      outUsd: m.pricing && m.pricing.completion != null ? +(parseFloat(m.pricing.completion) * 1e6).toFixed(3) : null,
    }));
    if (preset.filterSuffix) models = models.filter((m) => String(m.id).endsWith(preset.filterSuffix));
    if (!models.length && (preset.models || []).length) models = presetStaticModels(preset);
    return models;
  } catch (e) {
    if ((preset.models || []).length && !/HTTP (401|403)/.test(e.message)) {
      console.log(dim("  live model list unavailable (" + e.message + "), using preset models"));
      return presetStaticModels(preset);
    }
    throw e;
  }
}

function normalizeBase(base) {
  return String(base || "").replace(/\/+$/, "").replace(/\/(v1beta\/openai|compatibility\/v1|v1)$/, "");
}

async function fetchCustomModels(baseUrl, key, type) {
  const headers = key ? { authorization: "Bearer " + key } : {};
  if (type === "anthropic") { headers["x-api-key"] = key; headers["anthropic-version"] = "2023-06-01"; }
  const r = await fetch(baseUrl.replace(/\/$/, "") + "/models", { headers });
  if (!r.ok) throw new Error("custom /models HTTP " + r.status);
  const j = await r.json();
  const arr = j.data || j.models || j;
  return arr.map(m => ({ id: m.id || m.name, name: m.name || m.id, contextTokens: m.context_length || m.inputTokenLimit || null, inUsd: null, outUsd: null }));
}
function atomicWrite(file, text, mode = 0o600) {
  const tmp = file + "." + process.pid + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch (e) { }
}
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, "utf8")); } catch (e) { return { listen: { host: "127.0.0.1", port: 8788 }, providers: {}, active: "", routing: {} }; }
}
function saveCfg(c) {
  atomicWrite(CFG, JSON.stringify(c, null, 2) + "\n", 0o600);
}
const KEYS_PATH = path.join(path.dirname(CFG), 'keys.json');
function loadKeys() { try { return JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')); } catch (e) { return {}; } }
function saveKeys(k) { atomicWrite(KEYS_PATH, JSON.stringify(k, null, 2) + '\n', 0o600); }
const visible = (c) => Object.entries(c.providers || {}).filter(([, p]) => !p.hidden);
const composite = (p, id) => "prov/" + p + "/" + id;

function sortModels(models) {
  return models.slice().sort((a, b) => (a.inUsd == null ? 1e9 : a.inUsd) - (b.inUsd == null ? 1e9 : b.inUsd) || (b.contextTokens || 0) - (a.contextTokens || 0));
}

function describe(m) {
  const ctx = m.contextTokens ? fmtCtx(m.contextTokens) + " ctx" : "ctx unknown";
  const price = m.inUsd == null ? "" : "  $" + m.inUsd + " in / $" + m.outUsd + " out per Mtok";
  return (m.name && m.name !== m.id ? bold(m.name) + "  " : "") + dim(m.id) + "  " + ctx + price;
}

async function pickModel(models, prompt) {
  const sorted = sortModels(models);
  const pageSize = 15;
  let page = 0;
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  for (;;) {
    const start = page * pageSize;
    console.log();
    sorted.slice(start, start + pageSize).forEach((m, i) => console.log("  " + String(start + i + 1).padStart(3) + ". " + describe(m)));
    console.log(dim("  page " + (page + 1) + "/" + pages + "   n = next page, p = prev page, or type a number"));
    const a = await ask(prompt + " > ");
    if (a.length > 1 && !/^\d+$/.test(a)) {
      const hits = sorted.filter((m) => (m.id + " " + (m.name || "")).toLowerCase().includes(a.toLowerCase()));
      if (hits.length) {
        console.log(cyan("  " + hits.length + " match(es) for \"" + a + "\""));
        hits.slice(0, 15).forEach((m, i) => console.log("  " + String(i + 1).padStart(3) + ". " + describe(m)));
        const pick = Number(await ask("Pick number (empty = search again) > "));
        if (pick >= 1 && pick <= Math.min(hits.length, 15)) return hits[pick - 1];
        continue;
      }
      console.log(cyan("  no match - try another search"));
      continue;
    }
    if ((a === "n" || a === "N") && page < pages - 1) { page++; continue; }
    if ((a === "p" || a === "P") && page > 0) { page--; continue; }
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= sorted.length) return sorted[n - 1];
    if (a.length > 1) { const hit = sorted.find(m => m.id === a || m.id.endsWith("/" + a)); if (hit) return hit; }
    console.log(cyan("  enter a number from 1 to " + sorted.length));
  }
}

function rebuild(c) {
  c.routing = {};
  for (const [name, p] of visible(c)) {
    for (const id of Object.keys(p.modelsById || {})) {
      const native = id.startsWith("claude-") || id.startsWith("anthropic/");
      c.routing[composite(name, id)] = (native && c.providers[name + "~native"] ? name + "~native" : name) + "::" + id;
    }
  }
}

function writeSettings(c) {
  const active = c.providers[c.active] || {};
  let settings = {};
  try { if (fs.existsSync(SETTINGS)) settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch (e) { settings = {}; }
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS + ".cc-termux-backup");
  const options = [];
  for (const [name, p] of visible(c)) {
    for (const [id, info] of Object.entries(p.modelsById || {})) {
      const isActive = name === c.active && id === (active.model || active.defaultModel);
      options.push({
        model: composite(name, id),
        label: (info.name && info.name !== id ? info.name : id) + "  [" + name + "]",
        description: (info.contextTokens ? fmtCtx(info.contextTokens) + " ctx" : "ctx unknown") +
          (info.inUsd == null ? "" : " - $" + info.inUsd + " in / $" + info.outUsd + " out per Mtok") +
          (isActive ? " - current" : ""),
      });
    }
  }
  const switchRows = visible(c).map(([name, p]) => ({
    model: 'provswitch/' + name,
    label: '\u21c4  Switch to ' + name,
    description: 'use ' + (p.model || 'default') + ' \u00b7 ' + p.type + (name === c.active ? ' \u00b7 current' : ''),
  }));
  settings.modelPicker = { replaceBuiltInOptions: true, options: [...switchRows, ...options] };
  if (active.model) settings.model = composite(c.active, active.model);
  else delete settings.model;
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
}

function stopGateway() {
  try { const pid = Number(fs.readFileSync(path.join(CACHE_DIR, "gateway.pid"), "utf8").trim()); if (pid > 0) process.kill(pid); } catch (e) { }
}

function providerName(c, base) {
  if (!c.providers[base]) return base;
  let i = 2; while (c.providers[base + i]) i++;
  return base + i;
}

function addProvider(c, name, opts) {
  const family = opts.family;
  const modelsById = {};
  for (const m of opts.models) modelsById[m.id] = { name: m.name, contextTokens: m.contextTokens || null, inUsd: m.inUsd ?? null, outUsd: m.outUsd ?? null };
  const p = {
    type: opts.type, baseUrl: opts.baseUrl, path: opts.path, apiMode: opts.type === 'openai' ? 'auto' : undefined,
    model: opts.main, defaultModel: opts.main, contextWindow: opts.contextWindow || 128000,
    aliases: opts.aliases, modelsById,
  };
  if (opts.noKey) p.noKey = true;
  c.providers[name] = p;
  const needsNative = family === "tokens" || opts.models.some(m => m.id.startsWith("claude-") || m.id.startsWith("anthropic/"));
  if (needsNative && opts.type === "openai" && family === "tokens") {
    c.providers[name + "~native"] = { hidden: true, type: "anthropic", baseUrl: opts.baseUrl, path: "/v1/messages", model: opts.main, defaultModel: opts.main, contextWindow: p.contextWindow, modelsById: {} };
  }
  const keyStore = loadKeys();
  keyStore[name] = opts.key;
  if (c.providers[name + '~native']) keyStore[name + '~native'] = opts.key;
  saveKeys(keyStore);
  c.active = name;
  c.override = { provider: name, model: opts.main };
  rebuild(c);
  saveCfg(c);
  writeSettings(c);
  return p;
}

function summary(c, name) {
  const p = c.providers[name];
  const total = visible(c).reduce((n, [, q]) => n + Object.keys(q.modelsById || {}).length, 0);
  console.log();
  console.log(cyan("provider: ") + name + (p.hidden ? "" : "") + "   " + p.type + "   " + p.baseUrl);
  console.log(cyan("model   : ") + p.model + "   ctx " + p.contextWindow);
  console.log(cyan("picker  : ") + total + " models from " + visible(c).length + " provider(s)");
  console.log();
  console.log("run " + bold("claude") + " - the gateway restarts automatically.");
  console.log(dim("switch later in a session: /provider <name>   |   add more: cc-termux setup"));
}

async function fetchFor(kind, key, base) {
  if (kind === "tokens") return { models: await fetchTokensModels(key), type: "openai", baseUrl: "https://tokens.bd", path: "/v1/chat/completions", family: "tokens" };
  if (kind === "openrouter") return { models: await fetchOpenRouterModels(key), type: "anthropic", baseUrl: "https://openrouter.ai/api", path: "/v1/messages", family: "openrouter" };
  if (kind === "gemini") return { models: await fetchGeminiModels(key), type: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", path: "/chat/completions", family: "gemini" };
  const type = kind === "custom-anthropic" ? "anthropic" : "openai";
  const norm = normalizeBase(base);
  try {
    return { models: await fetchCustomModels(norm, key, type), type, baseUrl: norm, path: type === "anthropic" ? "/v1/messages" : "/v1/chat/completions", family: "custom" };
  } catch (e) {
    const manual = process.env.CC_SETUP_MODEL;
    if (manual) return { models: [{ id: manual, name: manual, contextTokens: Number(process.env.CC_SETUP_CONTEXT) || 128000, inUsd: null, outUsd: null }], type, baseUrl: norm, path: process.env.CC_SETUP_PATH || (type === "anthropic" ? "/v1/messages" : "/v1/chat/completions"), family: "custom" };
    throw e;
  }
}

function errText(e) {
  const m = String(e.message || e);
  if (/HTTP 40[013]|API key not valid|API_KEY_INVALID/i.test(m)) return "invalid API key - check the key and its permissions (" + m + ")";
  return m;
}

async function fetchAnyModels(p, key) {
  if (p.kind === "gemini" || /generativelanguage/.test(p.baseUrl || "")) return await fetchGeminiModels(key);
  const base = String(p.baseUrl).replace(/\/$/, "");
  const candidates = [...new Set([
    base.replace(/\/(v1|v1beta|v1beta\/openai|openai)$/, "") + "/v1/models",
    base + "/models",
    base + "/v1/models",
  ])];
  let lastErr;
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: key ? { authorization: "Bearer " + key } : {} });
      if (!r.ok) { lastErr = new Error(url + " HTTP " + r.status); continue; }
      const j = await r.json();
      const arr = j.data || j.models || j;
      const models = (Array.isArray(arr) ? arr : []).map((m) => ({
        id: m.id || m.name, name: m.name || m.id,
        contextTokens: m.context_length || m.max_context_length || m.inputTokenLimit || null,
        inUsd: null, outUsd: null,
      }));
      if (models.length) return models;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("no models endpoint responded");
}

async function promptProviderKey(c, name, p) {
  if (p.noKey) return true;
  if (p.apiKeyEnv && process.env[p.apiKeyEnv]) return true;
  if (loadKeys()[name]) return true;
  console.log();
  console.log(cyan("  no API key stored for " + name));
  if (p.keyUrl) console.log(dim("  key page: " + p.keyUrl));
  const key = await askHidden("API key (hidden, empty to skip) > ");
  if (!key) return false;
  const ks = loadKeys(); ks[name] = key; saveKeys(ks);
  try {
    const models = await fetchAnyModels(p, key);
    const map = {};
    for (const m of models) map[m.id] = { name: m.name, contextTokens: m.contextTokens, inUsd: m.inUsd, outUsd: m.outUsd };
    p.modelsById = map;
    if (!p.model || !map[p.model]) p.model = models[0].id;
    p.contextWindow = map[p.model] && map[p.model].contextTokens ? map[p.model].contextTokens : p.contextWindow;
    console.log(cyan("  \u2714 key valid - " + models.length + " models"));
  } catch (e) {
    console.log(cyan("  warning: key saved but validation failed (" + errText(e) + ")"));
  }
  return true;
}

async function presetFlow(c, presetOverride) {
  const presets = loadPresets().free || [];
  if (!presets.length) { console.log(cyan("  no presets found")); return null; }
  let preset = presetOverride;
  if (!preset) {
    console.log();
    presets.forEach((p, i) => console.log("  " + String(i + 1).padStart(2) + ". " + p.name + (p.local ? "  (local)" : "") + (p.noKey ? "  (no key)" : "") + dim("  " + p.baseUrl)));
    const a = await ask("Preset > ");
    preset = presets[Number(a) - 1];
    if (!preset) { console.log(cyan("  invalid preset")); return null; }
  }
  if (preset.notes) console.log(dim("  " + preset.notes));
  let key = "";
  if (!preset.noKey) {
    if (preset.keyUrl) console.log(dim("  get a key: " + preset.keyUrl));
    key = await askHidden("API key (hidden) > ");
    if (!key) { console.log(cyan("  no key entered")); return null; }
  }
  console.log(dim("  fetching models..."));
  let models;
  try { models = await fetchPresetModels(preset, key); }
  catch (e) { console.log(cyan("  " + errText(e))); return null; }
  if (!models.length) { console.log(cyan("  no models returned")); return null; }
  console.log(cyan("  \u2714 " + models.length + " models available"));
  const main = await pickModel(models, "Main model");
  const c2 = c;
  const existing = visible(c2).find(([n, p]) => p.baseUrl === preset.baseUrl || n === preset.id);
  const name = existing ? existing[0] : providerName(c2, preset.id);
  const family = preset.id === "tokens" ? "tokens" : "custom";
  addProvider(c2, name, {
    family, type: "openai", baseUrl: preset.baseUrl, path: preset.path || "/chat/completions",
    key, models, main: main.id, contextWindow: main.contextTokens || 128000,
    aliases: { opus: main.id, sonnet: main.id, haiku: main.id, subagent: main.id },
    noKey: !!(preset.noKey || preset.local),
  });
  summary(c2, name);
  if ((await ask("\nSend a small test request now? (y/N) > ")).toLowerCase().startsWith("y")) await runSmokeTest();
  return name;
}

function parseFlags() {
  const a = process.argv.slice(2);
  const val = (n) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] && !a[i + 1].startsWith("-") ? a[i + 1] : ""; };
  if (a.includes("--help") || a.includes("-h")) {
    console.log("usage: cc-termux setup [--preset id] [--provider openrouter|gemini|tokens|custom]");
    console.log("                         [--key KEY] [--model ID] [--base-url URL] [--type openai|anthropic]");
    console.log("                         [--name NAME] [--test]");
    process.exit(0);
  }
  const map = {
    "--preset": "CC_SETUP_PRESET", "--provider": "CC_SETUP_PROVIDER", "--key": "CC_SETUP_KEY",
    "--model": "CC_SETUP_MODEL", "--background": "CC_SETUP_BACKGROUND", "--base-url": "CC_SETUP_BASE_URL",
    "--type": "CC_SETUP_TYPE", "--path": "CC_SETUP_PATH", "--name": "CC_SETUP_NAME", "--context": "CC_SETUP_CONTEXT",
  };
  for (const [flag, env] of Object.entries(map)) { const v = val(flag); if (v) process.env[env] = v; }
  return { test: a.includes("--test"), hasFlags: Object.keys(map).some((f) => a.includes(f)) };
}

async function runSmokeTest() {
  console.log("\n  sending a small test request through the gateway...");
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin", "cc-termux"), "test", "Reply with exactly: OK"], { encoding: "utf8", timeout: 120000 });
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  console.log("  " + (r.status === 0 ? "\u2714 " : "\u2716 ") + (out.split("\n").pop() || "no output"));
}

async function envMode() {
  const opts = parseFlags();
  if (process.env.CC_SETUP_PRESET) {
    const preset = (loadPresets().free || []).find((p) => p.id === process.env.CC_SETUP_PRESET);
    if (!preset) throw new Error("unknown preset " + process.env.CC_SETUP_PRESET);
    const c = loadCfg();
    const key = process.env.CC_SETUP_KEY || "";
    const models = await fetchPresetModels(preset, key);
    const want = process.env.CC_SETUP_MODEL || "";
    const main = models.find((m) => m.id === want) || sortModels(models)[0];
    const name = providerName(c, preset.id);
    addProvider(c, name, {
      family: "custom", type: "openai", baseUrl: preset.baseUrl, path: preset.path || "/chat/completions",
      key, models, main: main.id, contextWindow: main.contextTokens || 128000,
      aliases: { opus: main.id, sonnet: main.id, haiku: main.id, subagent: main.id },
    });
    summary(c, name);
    if (opts.test) await runSmokeTest();
    return;
  }
  const kind = process.env.CC_SETUP_PROVIDER || "openrouter";
  const key = process.env.CC_SETUP_KEY || process.env.TOKENS_BD_KEY || "";
  const base = process.env.CC_SETUP_BASE_URL || "";
  const f = await fetchFor(kind, key, base);
  if (process.env.CC_SETUP_TYPE) f.type = process.env.CC_SETUP_TYPE;
  if (process.env.CC_SETUP_PATH) f.path = process.env.CC_SETUP_PATH;
  const want = process.env.CC_SETUP_MODEL || "";
  const picked = f.models.find(m => m.id === want);
  if (want && !picked) throw new Error("model " + want + " not found at this provider");
  const main = picked || sortModels(f.models)[0];
  if (!main) throw new Error("no models returned");
  const bgId = process.env.CC_SETUP_BACKGROUND || "";
  const bgPick = bgId && f.models.find(m => m.id === bgId);
  if (bgId && !bgPick) throw new Error("background model " + bgId + " not found at this provider");
  const bg = bgPick || main;
  const ctx = Number(process.env.CC_SETUP_CONTEXT || main.contextTokens || 128000);
  const c = loadCfg();
  let name = process.env.CC_SETUP_NAME || providerName(c, f.family);
  const same = visible(c).find(([, p]) => p.baseUrl === f.baseUrl);
  if (same) name = same[0];
  delete c.providers["native"];
  addProvider(c, name, { family: f.family, type: f.type, baseUrl: f.baseUrl, path: f.path, key, models: f.models, main: main.id, contextWindow: ctx,
    aliases: { opus: main.id, sonnet: main.id, haiku: bg.id, subagent: bg.id } });
  summary(c, name);
}

async function addFlow(c) {
  console.log();
  console.log("  1. OpenRouter          (popular, free models available)");
  console.log("  2. Google Gemini       (AI Studio key)");
  console.log("  3. Free / online provider presets  (Groq, DeepSeek, xAI, NVIDIA, local Ollama...)");
  console.log("  4. Custom OpenAI-compatible endpoint");
  console.log("  5. Custom Anthropic-compatible endpoint");
  console.log("  6. tokens.bd           (many models, cheap)");
  console.log();
  let kind = "";
  while (!kind) {
    const a = await ask("Provider [1] > ");
    kind = ({ "": "openrouter", "1": "openrouter", "2": "gemini", "3": "preset", "p": "preset", "4": "custom-openai", "5": "custom-anthropic", "6": "tokens" })[a] || "";
    if (!kind) console.log(cyan("  enter 1-6"));
  }
  if (kind === "preset") { await presetFlow(loadCfg()); return; }
  let base = "";
  if (kind.startsWith("custom")) {
    base = await ask("Base URL (e.g. https://api.example.com/v1) > ");
    while (!base) base = await ask("Base URL is required > ");
  }
  console.log();
  const key = await askHidden("API key (hidden) > ");
  if (!key) { console.log(cyan("  no key entered")); return null; }
  console.log(dim("  validating key and fetching models..."));
  let f;
  try { f = await fetchFor(kind, key, base); }
  catch (e) { console.log(cyan("  " + errText(e))); return null; }
  if (!f.models.length) { console.log(cyan("  no models returned - key may be invalid or have no access")); return null; }
  console.log(cyan("  \u2714 key valid - " + f.models.length + " models available"));
  const main = await pickModel(f.models, "Main model");
  const bgSame = (await ask("Use the same model for background tasks / subagents? (Y/n) > ")).toLowerCase();
  let bg = main;
  if (bgSame.startsWith("n")) bg = await pickModel(f.models, "Background model");
  let ctx = main.contextTokens || 128000;
  let aliasModels = { opus: main.id, sonnet: main.id, haiku: bg.id, subagent: bg.id };
  const customize = (await ask("Customize context / aliases? (y/N) > ")).toLowerCase();
  if (customize.startsWith("y")) {
    const cc = await ask("Context window tokens [" + ctx + "] > ");
    if (cc) ctx = Number(cc) || ctx;
    for (const a of ["opus", "sonnet", "haiku", "subagent"]) {
      const v = await ask(a + " alias model [" + aliasModels[a] + "] > ");
      if (v) aliasModels[a] = v;
    }
  }
  const name = providerName(c, f.family);
  addProvider(c, name, { family: f.family, type: f.type, baseUrl: f.baseUrl, path: f.path, key, models: f.models, main: main.id, contextWindow: ctx, aliases: aliasModels });
  summary(c, name);
  if ((await ask("\nSend a small test request now? (y/N) > ")).toLowerCase().startsWith("y")) await runSmokeTest();
  return name;
}

async function ttyMode() {
  console.log();
  console.log(bold("  Claude Code on Termux - provider setup"));
  let c = loadCfg();
  let list = visible(c);
  const ks0 = loadKeys();
  const sample = list.filter(([name, p]) => !ks0[name] && !p.apiKeyEnv && !Object.keys(p.modelsById || {}).length);
  if (list.length && sample.length === list.length) {
    console.log();
    console.log(cyan("  " + list.length + " provider entries look like sample data from an older install (no keys, no models)."));
    if ((await ask("Remove them and start clean? (Y/n) > ")).toLowerCase() !== "n") {
      for (const [name] of sample) delete c.providers[name];
      c.active = ""; delete c.override;
      saveCfg(c);
      list = visible(c);
    }
  }
  if (list.length) {
    console.log();
    console.log("  Configured providers:");
    list.forEach(([name, p], i) => {
      console.log("   " + (i + 1) + ". " + (name === c.active ? color("32", "\u2714") : " ") + " " + bold(name.padEnd(14)) +
        (p.model || "-") + dim("   " + p.type + "   " + ((loadKeys()[name] || p.apiKey) ? "key " + (loadKeys()[name] || p.apiKey).slice(0, 6) + "..." : "no key")));
    });
  }
  console.log();
  console.log("  " + (list.length ? "Enter a number to switch provider, " : "") + "a = add provider, r = remove provider, q = quit");
  console.log();
  const a = await ask("Choice > ");
  if (a.toLowerCase() === "q") return;
  if (a.toLowerCase() === "a" || !list.length) { await addFlow(c); return; }
  if (a.toLowerCase() === "r") {
    const pick = Number(await ask("Remove which provider? number > "));
    const entry = list[pick - 1];
    if (!entry) { console.log(cyan("  invalid choice")); return; }
    const [name] = entry;
    if ((await ask("Remove " + name + "? (y/N) > ")).toLowerCase().startsWith("y")) {
      delete c.providers[name];
      delete c.providers[name + "~native"];
      const ks = loadKeys(); delete ks[name]; delete ks[name + "~native"]; saveKeys(ks);
      if (!c.providers[c.active]) { c.active = Object.keys(c.providers).filter((k) => !c.providers[k].hidden)[0] || ""; delete c.override; }
      rebuild(c); saveCfg(c); writeSettings(c); stopGateway();
      console.log(cyan("\n  \u2714 removed " + name));
    }
    return;
  }
  const n = Number(a);
  if (Number.isInteger(n) && n >= 1 && n <= list.length) {
    const name = list[n - 1][0];
    const p = c.providers[name];
    if (!(await promptProviderKey(c, name, p))) { console.log(cyan("  no key configured, provider not switched")); return; }
    c.active = name;
    c.override = { provider: name, model: p.model || null };
    rebuild(c);
    saveCfg(c);
    writeSettings(c);
    console.log(cyan("\n  \u2714 switched to ") + name + " (" + (p.model || "default") + ")");
    console.log(dim("  running sessions switch on their next request; new sessions use this provider"));
    return;
  }
  console.log(cyan("  invalid choice"));
}

(async () => {
  try {
    const flags = parseFlags();
    const flagged = flags.hasFlags || flags.test || process.env.CC_SETUP_PRESET || process.env.CC_SETUP_PROVIDER || process.env.CC_SETUP_KEY;
    if (flagged || process.env.CC_SETUP_NONINTERACTIVE === "1" || !process.stdin.isTTY) return await envMode();
    return await ttyMode();
  } catch (e) {
    console.error(cyan("setup failed: " + e.message));
    process.exit(1);
  }
})();