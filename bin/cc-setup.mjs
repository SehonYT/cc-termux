#!/usr/bin/env node
// Interactive provider setup: selects a provider, validates the key, fetches models,
// writes config.json/keys.json and regenerates the /model picker.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { login as antigravityLogin, ensureProject as antigravityEnsureProject, loadCredentials as antigravityCreds, fetchAvailableModels, updateProviderModels } from "./cc-antigravity.mjs";
import { installStatusLine, refreshStatusLine } from "./cc-statusline.mjs";
import { installRoot, configFile, claudeDir, cacheDir } from "./cc-paths.mjs";
import { fetchPlans as naraPlans, fetchNaraModels as naraModels, splitByTier as naraSplit, readNaraCache, writeNaraCache } from "./cc-nara.mjs";

const ROOT = installRoot();
const CFG = configFile();
const SETTINGS = path.join(claudeDir(), "settings.json");
const CACHE_DIR = cacheDir();
const CATALOG = path.join(CACHE_DIR, "catalog.json");
const PRESETS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "presets.json");
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
async function fetchT(url, opts = {}) {
  const { retries = 3, timeoutMs = 10000, ...rest } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
      if (!RETRY_STATUS.has(res.status) || attempt === retries - 1) return res;
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : Math.min(5000, 600 * 2 ** attempt);
      console.log(dim("  network hiccup (" + res.status + ") - retrying in " + Math.round(wait) + "ms..."));
      try { await res.body?.cancel(); } catch (e) { }
      await new Promise((r) => setTimeout(r, wait));
    } catch (e) {
      lastErr = e;
      if (attempt === retries - 1) throw e;
      const wait = Math.min(5000, 600 * 2 ** attempt);
      console.log(dim("  network hiccup - retrying in " + Math.round(wait) + "ms..."));
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr || new Error("network request failed");
}
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
  const r = await fetchT("https://tokens.bd/v1/models", { headers: { authorization: "Bearer " + key } });
  if (!r.ok) throw new Error("tokens.bd /v1/models HTTP " + r.status + " - check the API key");
  const j = await r.json();
  const ids = new Set((j.data || j || []).map(m => m.id));
  let models = [];
  try {
    const page = await fetchT("https://tokens.bd/models");
    models = parseCatalogHtml(await page.text()).filter(m => ids.has(m.id));
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CATALOG, JSON.stringify({ fetchedAt: new Date().toISOString(), models }, null, 1));
  } catch (e) { }
  if (!models.length) models = [...ids].map(id => ({ id, name: id, contextTokens: null, inUsd: null, outUsd: null }));
  return models;
}

// Free means both prices are "0", which also catches aliases like openrouter/free.
function openRouterTier(m) {
  const p = m.pricing || {};
  const inUsd = p.prompt != null ? parseFloat(p.prompt) * 1e6 : null;
  const outUsd = p.completion != null ? parseFloat(p.completion) * 1e6 : null;
  const priced = (inUsd != null && inUsd > 0) || (outUsd != null && outUsd > 0);
  if (priced) return "paid";
  // Both prices are zero, or the model exposes none at all: fall back to the id suffix,
  // which is what OpenRouter itself uses on the free variants.
  if (inUsd === 0 && outUsd === 0) return "free";
  return String(m.id || "").endsWith(":free") ? "free" : "paid";
}

// A paid-only key cannot call free models older than the cut-off: OpenRouter answers
// "is not available for free" / 402. The wizard offers them but labels the tier.
async function fetchOpenRouterModels(key, { tier = "free" } = {}) {
  const r = await fetchT("https://openrouter.ai/api/v1/models", { headers: key ? { authorization: "Bearer " + key } : {} });
  if (!r.ok) throw new Error("OpenRouter /models HTTP " + r.status);
  const j = await r.json();
  const all = (j.data || []).map(m => {
    const p = m.pricing || {};
    return {
      id: m.id, name: m.name || m.id, contextTokens: m.context_length || null,
      inUsd: p.prompt != null ? +(parseFloat(p.prompt) * 1e6).toFixed(3) : null,
      outUsd: p.completion != null ? +(parseFloat(p.completion) * 1e6).toFixed(3) : null,
      tier: openRouterTier(m),
      tools: (m.supported_parameters || []).includes("tools"),
    };
  });
  const freeCount = all.filter(m => m.tier === "free").length;
  let arr = all;
  if (tier === "free") arr = all.filter(m => m.tier === "free");
  else if (tier === "paid") arr = all.filter(m => m.tier === "paid");
  // Free models must be able to call tools, otherwise Claude Code cannot do anything with them.
  const usable = arr.filter(m => m.tier !== "free" || m.tools);
  const skipped = arr.length - usable.length;
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(CATALOG, JSON.stringify({ fetchedAt: new Date().toISOString(), tier, freeCount, models: usable }, null, 1)); } catch (e) { }
  if (tier === "paid") console.log(dim("  " + freeCount + " free model(s) available on this provider (run: cc-termux setup, choose the free option)"));
  if (skipped) console.log(dim("  skipped " + skipped + " free model(s) that cannot call tools"));
  return usable;
}

// /api/plans gives the free/paid split without a key; /v1/models then reports what the
// key itself is entitled to, which is the authoritative list.
async function fetchNaraRouterModels(key, { tier = "free" } = {}) {
  const cache = readNaraCache() || {};
  let plans = cache.plans || null;
  if (!plans) {
    plans = await naraPlans();
    writeNaraCache({ ...cache, plans, plansAt: new Date().toISOString() });
  }
  const models = await naraModels(key, { tier, plans });
  const { free, paidOnly } = naraSplit(plans);
  if (tier === "free" && models.length < free.length) {
    console.log(dim("  your key reaches " + models.length + " of the " + free.length + " free-tier models"));
  }
  if (tier === "paid" && paidOnly.length) {
    console.log(dim("  " + free.length + " free-tier model(s) exist on this provider too"));
  }
  return models;
}

// Drop image, TTS, Live, embedding, video and agent ids: they cannot answer a chat call.
function geminiChatModel(id) {
  return !/(-tts|-image|image-preview|nano-banana|embedding|imagen|veo|lyria|live|transcribe|robotics|computer-use|deep-research|antigravity-|-aqa|native-audio|gemma-)/i.test(id);
}

// Google marks the family in the description; everything before the first period is stable.
const GEMINI_PRICE = {
  "gemini-4-carbon": [2, 10], "gemini-4-argon": [2, 10],
  "gemini-3.8-flash": [0.75, 3.75], "gemini-3.7-flash": [0.75, 3.75], "gemini-3.6-flash": [0.75, 3.75],
  "gemini-3.5-flash": [0.75, 3.75], "gemini-3.5-flash-lite": [0.3, 2.5], "gemini-3.1-flash-lite": [0.25, 1.5],
  "gemini-3.1-pro-preview": [2, 12], "gemini-3-flash-preview": [0.5, 3],
  "gemini-2.5-flash": [0.3, 2.5], "gemini-2.5-flash-lite": [0.1, 0.4], "gemini-2.5-pro": [1.25, 10],
};

// Published free-tier availability; a 429 on a free key means quota or billing.
const GEMINI_FREE = /^(gemini-3\.8-flash|gemini-3\.7-flash|gemini-3\.6-flash|gemini-3\.5-flash|gemini-3\.5-flash-lite|gemini-3\.1-flash-lite|gemini-3-flash-preview)$/;
const GEMINI_PAID = /^(gemini-4-carbon|gemini-4-argon|gemini-3\.1-pro-preview)$/;
// Gemini 2.5 is retired for keys created after its shutdown: the API lists it but every
// call answers 404 "no longer available to new users".
const GEMINI_RETIRED = /^(gemini-2\.\d|gemini-1\.\d)/;

function geminiTier(id) {
  if (GEMINI_FREE.test(id)) return "free";
  if (GEMINI_PAID.test(id)) return "paid";
  return "unknown";
}

async function fetchGeminiModels(key) {
  const r = await fetchT("https://generativelanguage.googleapis.com/v1beta/models?key=" + encodeURIComponent(key) + "&pageSize=200");
  if (!r.ok) throw new Error("Gemini models HTTP " + r.status + " - check the API key");
  const j = await r.json();
  const arr = (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map(m => ({ id: (m.name || "").replace(/^models\//, ""), name: m.displayName || m.name, contextTokens: m.inputTokenLimit || null, inUsd: null, outUsd: null }))
    .filter(m => geminiChatModel(m.id) && !GEMINI_RETIRED.test(m.id))
    .map(m => {
      const price = GEMINI_PRICE[m.id] || null;
      return { ...m, inUsd: price ? price[0] : null, outUsd: price ? price[1] : null, tier: geminiTier(m.id) };
    })
    .sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "free" ? -1 : b.tier === "free" ? 1 : 0) || a.id.localeCompare(b.id));
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
    const r = await fetchT(url, { headers: key ? { authorization: "Bearer " + key } : {} });
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
  if (type === "anthropic") { headers["anthropic-version"] = "2023-06-01"; if (key) headers["x-api-key"] = key; }
  const base = baseUrl.replace(/\/$/, "");
  let last = null;
  for (const url of [base + "/v1/models", base + "/models"]) {
    try {
      const r = await fetchT(url, { headers });
      if (!r.ok) { last = new Error("custom /models HTTP " + r.status); continue; }
      const j = await r.json();
      const arr = j.data || j.models || j;
      if (!Array.isArray(arr)) continue;
      const models = arr.map(m => ({ id: m.id || m.name, name: m.name || m.id, contextTokens: m.context_length || m.inputTokenLimit || null, inUsd: null, outUsd: null }));
      if (models.length) return models;
    } catch (e) { last = e; }
  }
  throw last || new Error("custom /models unavailable");
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

async function pickModel(models, prompt, defaultId) {
  const sorted = sortModels(models);
  const pageSize = 15;
  let page = 0;
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  for (;;) {
    const start = page * pageSize;
    console.log();
    sorted.slice(start, start + pageSize).forEach((m, i) => console.log("  " + String(start + i + 1).padStart(3) + ". " + describe(m)));
    const def = defaultId ? sorted.find((m) => m.id === defaultId) : null;
    console.log(dim("  page " + (page + 1) + "/" + pages + "   n = next page, p = prev page, or type a number" + (def ? "   Enter = " + def.id : "")));
    const a = await ask(prompt + (def ? " [" + def.id + "]" : "") + " > ");
    if (!a && def) return def;
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
  for (const m of opts.models) {
    modelsById[m.id] = { name: m.name, contextTokens: m.contextTokens || null, inUsd: m.inUsd ?? null, outUsd: m.outUsd ?? null };
    if (m.tier) modelsById[m.id].tier = m.tier;
  }
  const p = {
    type: opts.type, baseUrl: opts.baseUrl, path: opts.path, apiMode: opts.type === 'openai' ? 'auto' : undefined,
    model: opts.main, defaultModel: opts.main, contextWindow: opts.contextWindow || 128000,
    aliases: opts.aliases, modelsById,
  };
  if (opts.noKey) p.noKey = true;
  // Remember which tier list this provider was built from, so a refresh can keep it.
  if (opts.tier) p.tier = opts.tier;
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

async function ensureStatusLine() {
  try { installStatusLine(); await refreshStatusLine({ force: true }); } catch (e) { }
}

function summary(c, name) {
  const p = c.providers[name];
  const total = visible(c).reduce((n, [, q]) => n + Object.keys(q.modelsById || {}).length, 0);
  const model = (p.modelsById && p.modelsById[p.model] && p.modelsById[p.model].name) || p.model || "-";
  const keyState = (p.noKey || p.type === "antigravity") ? "not required" : ((loadKeys()[name] || p.apiKeyEnv) ? "saved" : "missing");
  console.log();
  console.log("  " + cyan("✔ Provider ready"));
  console.log("  " + dim("provider") + "  " + bold(name) + dim("  " + p.type));
  console.log("  " + dim("model") + "     " + model + (p.contextWindow ? dim("  " + fmtCtx(p.contextWindow) + " context") : ""));
  console.log("  " + dim("key") + "       " + keyState);
  console.log("  " + dim("picker") + "    " + total + " models from " + visible(c).length + " provider(s)");
  console.log();
  console.log("  " + bold("Next:") + " run " + cyan("claude"));
  console.log("  " + dim("Switch later: /model or /provider inside Claude  ·  add another: cc-termux setup"));
  console.log();
}


// "free" keeps only zero-cost models, "paid" keeps only billed ones, "all" keeps both.
// Non-interactive runs pick it with CC_SETUP_TIER; the wizard asks.
async function askTier(kind = "openrouter") {
  if (!process.stdin.isTTY) return process.env.CC_SETUP_TIER || "free";
  console.log();
  console.log("  " + bold((kind === "nararouter" ? "NaraRouter" : "OpenRouter") + " model tier"));
  console.log("  " + dim("1") + " free only    " + dim("zero-cost models, no credits needed"));
  console.log("  " + dim("2") + " paid only    " + dim("models billed against your credits"));
  console.log("  " + dim("3") + " everything   " + dim("both lists, labelled in the picker"));
  const a = (await ask("Choose [1] > ")).trim().toLowerCase();
  return a === "2" || a === "paid" ? "paid" : a === "3" || a === "all" ? "all" : "free";
}

async function fetchFor(kind, key, base, tier) {
  if (kind === "tokens") return { models: await fetchTokensModels(key), type: "openai", baseUrl: "https://tokens.bd", path: "/v1/chat/completions", family: "tokens" };
  if (kind === "nararouter") {
    const t = tier || process.env.CC_SETUP_TIER || "free";
    return { models: await fetchNaraRouterModels(key, { tier: t }), type: "openai", baseUrl: "https://router.bynara.id/v1", path: "/chat/completions", family: "nararouter", tier: t };
  }
  if (kind === "openrouter") {
    const t = tier || process.env.CC_SETUP_TIER || (process.stdin.isTTY ? "free" : "free");
    return { models: await fetchOpenRouterModels(key, { tier: t }), type: "anthropic", baseUrl: "https://openrouter.ai/api", path: "/v1/messages", family: "openrouter", tier: t };
  }
  if (kind === "gemini") return { models: await fetchGeminiModels(key), type: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", path: "/chat/completions", family: "gemini" };
  const type = kind === "custom-anthropic" ? "anthropic" : "openai";
  const norm = normalizeBase(base);
  try {
    return { models: await fetchCustomModels(norm, key, type), type, baseUrl: norm, path: type === "anthropic" ? "/v1/messages" : "/v1/chat/completions", family: "custom" };
  } catch (e) {
    let manual = process.env.CC_SETUP_MODEL;
    if (!manual && process.stdin.isTTY) manual = (await ask("Model ID (empty = abort; the endpoint has no /models) > ")).trim();
    if (manual) return { models: [{ id: manual, name: manual, contextTokens: Number(process.env.CC_SETUP_CONTEXT) || 128000, inUsd: null, outUsd: null }], type, baseUrl: norm, path: process.env.CC_SETUP_PATH || (type === "anthropic" ? "/v1/messages" : "/v1/chat/completions"), family: "custom" };
    throw e;
  }
}

function errText(e) {
  const m = String(e.message || e);
  if (e && (e.name === "TimeoutError" || e.name === "AbortError" || /aborted|timeout/i.test(m))) return "request timed out - check the base URL and network";
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(m)) return "could not reach the endpoint - check the base URL, port and network";
  if (/HTTP 40[013]|API key not valid|API_KEY_INVALID/i.test(m)) return "invalid API key - check the key and its permissions (" + m + ")";
  return m;
}

async function fetchAnyModels(p, key) {
  if (p.kind === "gemini" || /generativelanguage/.test(p.baseUrl || "")) return await fetchGeminiModels(key);
  // Refresh an OpenRouter provider with the tier it was created with, so a free-only
  // setup never silently gains 460+ paid models.
  if (p.tier && /openrouter\.ai/.test(p.baseUrl || "")) return await fetchOpenRouterModels(key, { tier: p.tier });
  const base = String(p.baseUrl).replace(/\/$/, "");
  const candidates = [...new Set([
    base.replace(/\/(v1|v1beta|v1beta\/openai|openai)$/, "") + "/v1/models",
    base + "/models",
    base + "/v1/models",
  ])];
  let lastErr;
  for (const url of candidates) {
    try {
      const r = await fetchT(url, { headers: key ? { authorization: "Bearer " + key } : {} });
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
  if (p.noKey || p.type === "antigravity") return true;
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
    console.log("  " + bold("Choose a provider preset"));
    const pageSize = 10;
    let page = 0;
    let query = "";
    for (;;) {
      const filtered = query
        ? presets.filter((p) => (p.id + " " + p.name + " " + (p.baseUrl || "")).toLowerCase().includes(query.toLowerCase()))
        : presets;
      const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
      if (page >= pages) page = pages - 1;
      const start = page * pageSize;
      console.log();
      filtered.slice(start, start + pageSize).forEach((p, i) => {
        const tags = [
          p.local ? "local" : "",
          p.noKey ? "no key" : "",
          p.auth === "antigravity" ? "OAuth" : "",
        ].filter(Boolean).join(", ");
        console.log("  " + String(start + i + 1).padStart(2) + ". " + p.name + (tags ? dim("  " + tags) : "") + dim("  " + (p.baseUrl || "")));
      });
      if (!filtered.length) console.log(cyan("  no matching provider"));
      console.log(dim("  page " + (page + 1) + "/" + pages + "  ·  n/p = page  ·  type to search  ·  Enter = back"));
      const a = await ask("Preset > ");
      if (!a || a === "q" || a === "b") return null;
      if (a === "n" || a === "N") { if (page < pages - 1) page++; continue; }
      if (a === "p" || a === "P") { if (page > 0) page--; continue; }
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= filtered.length) { preset = filtered[n - 1]; break; }
      query = a;
      page = 0;
    }
  }
  if (preset.notes) console.log(dim("  " + preset.notes));
  if (preset.auth === "antigravity") {
    let creds = antigravityCreds();
    if (!creds || !creds.access_token) {
      if (!process.stdin.isTTY) { console.log(cyan("  Antigravity OAuth needs a terminal; run: cc-termux antigravity login")); return null; }
      console.log(dim("  starting Google OAuth login..."));
      try { creds = await antigravityLogin({ log: (m) => console.log(m) }); }
      catch (e) { console.log(cyan("  login failed: " + e.message)); return null; }
    }
    try { creds = await antigravityEnsureProject({ log: (m) => console.log(dim("  " + m)) }); }
    catch (e) { console.log(cyan("  " + e.message)); return null; }
    let amodels = [];
    try { amodels = await fetchAvailableModels({ timeoutMs: 12000 }); } catch (e) { }
    if (!amodels.length) { console.log(dim("  could not fetch live models - using known catalog")); amodels = presetStaticModels(preset); }
    if (!amodels.length) { console.log(cyan("  no Antigravity models configured")); return null; }
    console.log(cyan("  \u2714 " + amodels.length + " Antigravity models available" + (creds.email ? " for " + creds.email : "")));
    const amain = await pickModel(amodels, "Main model", "claude-sonnet-4-6");
    const existingA = visible(c).find(([n, p]) => p.type === "antigravity" || n === "antigravity");
    const aname = existingA ? existingA[0] : providerName(c, "antigravity");
    addProvider(c, aname, {
      family: "antigravity", type: "antigravity", baseUrl: preset.baseUrl, path: preset.path,
      key: "", noKey: true, models: amodels, main: amain.id, contextWindow: amain.contextTokens || 1048576,
      aliases: { opus: amain.id, sonnet: amain.id, haiku: amain.id, subagent: amain.id },
    });
    summary(c, aname);
    try { installStatusLine(); await refreshStatusLine({ force: true }); } catch (e) { }
    if ((await ask("\nSend a small test request now? (y/N) > ")).toLowerCase().startsWith("y")) await runSmokeTest();
    return aname;
  }
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
  await ensureStatusLine();
  if ((await ask("\nSend a small test request now? (y/N) > ")).toLowerCase().startsWith("y")) await runSmokeTest();
  return name;
}

function parseFlags() {
  const a = process.argv.slice(2);
  const val = (n) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] && !a[i + 1].startsWith("-") ? a[i + 1] : ""; };
  if (a.includes("--help") || a.includes("-h")) {
    console.log("usage: cc-termux setup [options]");
    console.log("");
    console.log("Connect Claude Code to a provider (interactive wizard by default).");
    console.log("");
    console.log("  Run with no arguments for the interactive wizard.");
    console.log("");
    console.log("  Options:");
    console.log("    --preset <id>        use a built-in preset (openrouter, gemini, antigravity, groq, ollama...)");
    console.log("    --provider <kind>    openrouter | gemini | tokens | custom-openai | custom-anthropic");
    console.log("    --base-url <url>     custom endpoint (local gateway: http://127.0.0.1:8080/v1)");
    console.log("    --key <key>          API key (omit for local/no-key gateways)");
    console.log("    --model <id>         main model id");
    console.log("    --background <id>    background/subagent model");
    console.log("    --name <name>        provider name in config");
    console.log("    --context <tokens>   context window override");
    console.log("    --type openai|anthropic");
    console.log("    --path <path>        request path override");
    console.log("    --test               send a smoke-test request after setup");
    console.log("");
    console.log("  Examples:");
    console.log("    cc-termux setup --preset antigravity");
    console.log("    cc-termux setup --provider custom-openai --base-url http://127.0.0.1:8080/v1 --model local-model");
    console.log("    cc-termux setup --preset groq --key gsk_... --test");
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
    if (preset.auth === "antigravity") {
      let creds = antigravityCreds();
      if (!creds) throw new Error("run: cc-termux antigravity login");
      creds = await antigravityEnsureProject({ log: () => { } });
      let amodels = [];
      try { amodels = await fetchAvailableModels({ timeoutMs: 12000 }); } catch (e) { }
      if (!amodels.length) amodels = presetStaticModels(preset);
      const want = process.env.CC_SETUP_MODEL || "";
      const main = (want && amodels.find((m) => m.id === want)) || amodels.find((m) => m.id === "claude-sonnet-4-6") || amodels[0];
      if (!main) throw new Error("no antigravity models");
      const c0 = loadCfg();
      const existing = visible(c0).find(([n, p]) => p.type === "antigravity" || n === "antigravity");
      const name0 = process.env.CC_SETUP_NAME || (existing ? existing[0] : providerName(c0, "antigravity"));
      addProvider(c0, name0, { family: "antigravity", type: "antigravity", baseUrl: preset.baseUrl, path: preset.path, key: "", noKey: true, models: amodels, main: main.id, contextWindow: main.contextTokens || 1048576, aliases: { opus: main.id, sonnet: main.id, haiku: main.id, subagent: main.id } });
      summary(c0, name0);
      await ensureStatusLine();
      if (opts.test) await runSmokeTest();
      return;
    }
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
      noKey: !!(preset.noKey || preset.local),
    });
    summary(c, name);
    await ensureStatusLine();
    if (opts.test) await runSmokeTest();
    return;
  }
  const kind = process.env.CC_SETUP_PROVIDER || "openrouter";
  const key = process.env.CC_SETUP_KEY || process.env.TOKENS_BD_KEY || "";
  const base = process.env.CC_SETUP_BASE_URL || "";
  const f = await fetchFor(kind, key, base, process.env.CC_SETUP_TIER);
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
  addProvider(c, name, { family: f.family, type: f.type, baseUrl: f.baseUrl, path: f.path, key, noKey: !key, models: f.models, main: main.id, contextWindow: ctx,
    aliases: { opus: main.id, sonnet: main.id, haiku: bg.id, subagent: bg.id }, tier: f.tier });
  summary(c, name);
  await ensureStatusLine();
}

async function addFlow(c) {
  console.log();
  console.log("  1. OpenRouter          " + dim("recommended - many free models"));
  console.log("  2. Google Gemini       " + dim("AI Studio API key"));
  console.log("  3. Free / local presets " + dim("Groq, DeepSeek, xAI, NVIDIA, Ollama, LM Studio..."));
  console.log("  4. Custom OpenAI-compatible  " + dim("local gateway or any OpenAI endpoint"));
  console.log("  5. Custom Anthropic-compatible  " + dim("local gateway or Anthropic endpoint"));
  console.log("  6. tokens.bd           " + dim("many models, cheap"));
  console.log("  7. Google Antigravity  " + dim("Google account OAuth - Gemini 3.8, Claude 4.6"));
  console.log();
  let kind = "";
  while (!kind) {
    const a = await ask("Provider [1] > ");
    kind = ({ "": "openrouter", "1": "openrouter", "2": "gemini", "3": "preset", "p": "preset", "4": "custom-openai", "5": "custom-anthropic", "6": "tokens", "7": "antigravity", "a": "antigravity" })[a] || "";
    if (a === "b" || a === "0") return null;
    if (!kind) console.log(cyan("  enter 1-7 (b = back)"));
  }
  if (kind === "preset") { await presetFlow(loadCfg()); return; }
  if (kind === "antigravity") {
    const preset = (loadPresets().free || []).find((p) => p.auth === "antigravity");
    if (!preset) { console.log(cyan("  Antigravity preset missing")); return null; }
    return await presetFlow(loadCfg(), preset);
  }
  let base = "";
  if (kind.startsWith("custom")) {
    base = await ask("Base URL (e.g. https://api.example.com/v1) > ");
    while (!base) base = await ask("Base URL is required > ");
  }
  console.log();
  const key = await askHidden("API key (hidden, empty = no key / local gateway) > ");
  if (!key) console.log(dim("  no key - calling the endpoint without Authorization"));
  console.log(dim("  fetching models..."));
  const tier = (kind === "openrouter" || kind === "nararouter") ? await askTier(kind) : undefined;
  let f;
  try { f = await fetchFor(kind, key, base, tier); }
  catch (e) { console.log(cyan("  " + errText(e))); return null; }
  if (!f.models.length) { console.log(cyan("  no models returned - key may be invalid or have no access")); return null; }
  if (kind.startsWith("custom")) {
    const customPath = (await ask("Request path [" + f.path + "] > ")).trim();
    if (customPath) f.path = customPath.startsWith("/") ? customPath : "/" + customPath;
  }
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
  const same = visible(c).find(([, p]) => p.baseUrl === f.baseUrl && p.type === f.type);
  const name = same ? same[0] : providerName(c, f.family);
  addProvider(c, name, { family: f.family, type: f.type, baseUrl: f.baseUrl, path: f.path, key, noKey: !key, models: f.models, main: main.id, contextWindow: ctx, aliases: aliasModels, tier: f.tier });
  if (f.tier === "free") console.log(dim("  free tier only - no credits are spent; switch to paid with: cc-termux setup"));
  summary(c, name);
  if ((await ask("\nSend a small test request now? (y/N) > ")).toLowerCase().startsWith("y")) await runSmokeTest();
  return name;
}

async function ttyMode() {
  let stamp = {};
  try { stamp = JSON.parse(fs.readFileSync(path.join(ROOT, "cc-termux.json"), "utf8")); } catch (e) { }
  console.log();
  console.log(bold("  cc-termux setup"));
  console.log(dim("  Claude Code + any provider  ·  " + (stamp.version || "dev") + "  ·  " + process.platform + " " + process.arch));
  let c = loadCfg();
  for (;;) {
    let list = visible(c);
    const ks0 = loadKeys();
    const sample = list.filter(([name, p]) => !ks0[name] && !p.apiKeyEnv && !Object.keys(p.modelsById || {}).length);
    if (list.length && sample.length === list.length) {
      console.log();
      console.log(cyan("  " + list.length + " provider entries look like stale sample data (no keys, no models)."));
      if ((await ask("Remove them and start clean? (Y/n) > ")).toLowerCase() !== "n") {
        for (const [name] of sample) delete c.providers[name];
        c.active = ""; delete c.override;
        saveCfg(c);
        list = visible(c);
      }
    }
    if (list.length) {
      console.log();
      console.log("  " + dim("#") + "  " + dim("provider".padEnd(15)) + dim("type".padEnd(12)) + dim("model"));
      list.forEach(([name, p], i) => {
        const model = (c.override && c.override.provider === name && c.override.model) ? c.override.model : (p.model || p.defaultModel || "-");
        const key = p.type === "antigravity" ? "Google OAuth" : p.noKey ? "no key" : ((ks0[name] || p.apiKeyEnv) ? "key saved" : "no key");
        console.log("  " + String(i + 1).padStart(2) + (name === c.active ? color("32", " ✔ ") : "   ") + bold(name.padEnd(15)) + dim(String(p.type).padEnd(12)) + model + dim("   " + key));
      });
    } else {
      console.log();
      console.log(dim("  No providers configured yet - let's add one."));
    }
    console.log();
    console.log("  " + (list.length ? "number = switch provider   " : "") + "a = add provider   " + (list.length ? "r = remove   " : "") + "t = test   q = quit");
    console.log();
    const a = (await ask("Choice > ")).toLowerCase();
    if (a === "q") return;
    if (a === "t") { await runSmokeTest(); continue; }
    if (a === "a" || !list.length) {
      const added = await addFlow(c);
      if (!added) continue;
      if ((await ask("Add another provider? (y/N) > ")).toLowerCase().startsWith("y")) continue;
      return;
    }
    if (a === "r") {
      const pick = Number(await ask("Remove which provider? number > "));
      const entry = list[pick - 1];
      if (!entry) { console.log(cyan("  invalid choice")); continue; }
      const [name] = entry;
      if ((await ask("Remove " + name + "? (y/N) > ")).toLowerCase().startsWith("y")) {
        delete c.providers[name];
        delete c.providers[name + "~native"];
        const ks = loadKeys(); delete ks[name]; delete ks[name + "~native"]; saveKeys(ks);
        if (!c.providers[c.active]) { c.active = Object.keys(c.providers).filter((k) => !c.providers[k].hidden)[0] || ""; delete c.override; }
        rebuild(c); saveCfg(c); writeSettings(c); stopGateway();
        await ensureStatusLine();
        console.log(cyan("\n  ✔ removed " + name + " - restarts on next launch"));
      }
      continue;
    }
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= list.length) {
      const name = list[n - 1][0];
      const p = c.providers[name];
      if (!(await promptProviderKey(c, name, p))) { console.log(cyan("  no key configured, provider not switched")); continue; }
      c.active = name;
      c.override = { provider: name, model: p.model || null };
      rebuild(c);
      saveCfg(c);
      writeSettings(c);
      await ensureStatusLine();
      console.log(cyan("\n  ✔ switched to ") + name + " (" + (p.model || "default") + ")");
      console.log(dim("  running sessions switch on their next request; new sessions use this provider"));
      return;
    }
    console.log(cyan("  invalid choice"));
  }
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