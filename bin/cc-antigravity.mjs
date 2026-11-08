#!/usr/bin/env node
// Google Antigravity OAuth (Cloud Code API) for cc-termux.
// Ported/adapted from OmniRoute (MIT, (c) 2026 diegosouzapw): public desktop OAuth
// client, loopback redirect, loadCodeAssist/onboardUser project discovery.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MASK = "omniroute-public-v1";
const ID_BYTES = [94,93,89,88,66,95,67,68,83,29,69,76,83,65,29,14,69,5,66,6,3,92,1,64,94,25,23,23,72,66,70,87,26,29,12,65,25,91,7,89,9,93,66,92,16,4,75,76,0,5,17,66,14,12,66,17,93,10,24,29,12,0,12,26,26,17,72,30,1,76,15,6,14];
const SECRET_BYTES = [40,34,45,58,34,55,88,63,80,21,54,34,48,88,81,85,97,18,125,37,92,3,37,48,87,6,44,38,25,10,67,19,40,40,5];
function unmask(bytes) { let out = ""; for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] ^ MASK.charCodeAt(i % MASK.length)); return out; }
export const CLIENT_ID = process.env.CC_TERMUX_ANTIGRAVITY_CLIENT_ID || unmask(ID_BYTES);
export const CLIENT_SECRET = process.env.CC_TERMUX_ANTIGRAVITY_CLIENT_SECRET || unmask(SECRET_BYTES);
export const AUTH_URL = process.env.CC_TERMUX_ANTIGRAVITY_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = process.env.CC_TERMUX_ANTIGRAVITY_TOKEN_URL || "https://oauth2.googleapis.com/token";
export const USERINFO_URL = process.env.CC_TERMUX_ANTIGRAVITY_USERINFO_URL || "https://www.googleapis.com/oauth2/v1/userinfo";
export const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
export const BOOTSTRAP_URL = process.env.CC_TERMUX_ANTIGRAVITY_BOOTSTRAP_URL || "https://cloudcode-pa.googleapis.com";
export const GENERATE_URL = process.env.CC_TERMUX_ANTIGRAVITY_GENERATE_URL || "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
export const FETCH_MODELS_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
];
export const QUOTA_SUMMARY_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
];
export const QUOTA_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
];
export function usageCachePath() {
  return path.join(process.env.CC_TERMUX_CACHE || path.join(os.homedir(), ".cache", "cc-termux"), "antigravity-usage.json");
}
export function readUsageCache() {
  try { return JSON.parse(fs.readFileSync(usageCachePath(), "utf8")); } catch (e) { return null; }
}
export function writeUsageCache(data) {
  try {
    fs.mkdirSync(path.dirname(usageCachePath()), { recursive: true });
    fs.writeFileSync(usageCachePath(), JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  } catch (e) { }
  return data;
}
export const LOAD_CODE_ASSIST_URL = BOOTSTRAP_URL + "/v1internal:loadCodeAssist";
export const ONBOARD_USER_URL = BOOTSTRAP_URL + "/v1internal:onboardUser";
export const USER_AGENT = "antigravity/ide/2.5.5 darwin/arm64";
export const X_GOOG_API_CLIENT = "gl-node/22.21.1";

export function configDir() {
  const cfg = process.env.CC_TERMUX_CONFIG || path.join(os.homedir(), ".config", "cc-termux", "config.json");
  return path.dirname(cfg);
}
export function credsPath() { return path.join(configDir(), "antigravity.json"); }

function atomicWrite(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch (e) { }
}
export function loadCredentials() {
  try { return JSON.parse(fs.readFileSync(credsPath(), "utf8")); } catch (e) { return null; }
}
export function saveCredentials(creds) {
  atomicWrite(credsPath(), JSON.stringify(creds, null, 2) + "\n");
  return creds;
}
export function clearCredentials() { try { fs.unlinkSync(credsPath()); } catch (e) { } }

export function metadataForHost(platform = process.platform, arch = process.arch) {
  const platformEnum = platform === "darwin" ? (arch === "arm64" ? 2 : 1)
    : (platform === "linux" || platform === "android") ? (arch === "arm64" ? 4 : 3)
    : platform === "win32" ? 5 : 0;
  return { ideType: 9, platform: platformEnum, pluginType: 2 };
}

export function buildAuthUrl(redirectUri, state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return AUTH_URL + "?" + p.toString();
}

export async function exchangeCode(code, redirectUri, fetchImpl = fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": USER_AGENT },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error("token exchange failed: HTTP " + res.status + " " + (await res.text()).slice(0, 300));
  return await res.json();
}

export async function refreshToken(refresh_token, fetchImpl = fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": USER_AGENT },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error("token refresh failed: HTTP " + res.status + " " + (await res.text()).slice(0, 300));
  return await res.json();
}

export function antigravityHeaders(accessToken, extra = {}) {
  return {
    "content-type": "application/json",
    authorization: "Bearer " + accessToken,
    "user-agent": USER_AGENT,
    "x-goog-api-client": X_GOOG_API_CLIENT,
    ...extra,
  };
}

function projectIdFrom(data) {
  const p = data && data.cloudaicompanionProject;
  if (typeof p === "string") return p;
  if (p && typeof p === "object" && typeof p.id === "string") return p.id;
  return "";
}

async function postJson(url, accessToken, body, fetchImpl = fetch, timeout = 15000) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: antigravityHeaders(accessToken),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(url + " HTTP " + res.status + " " + text.slice(0, 300));
  try { return JSON.parse(text); } catch (e) { return {}; }
}

export async function discoverProject(accessToken, { fetchImpl = fetch, log = () => { } } = {}) {
  const metadata = metadataForHost();
  let data = {};
  try { data = await postJson(LOAD_CODE_ASSIST_URL, accessToken, { metadata }, fetchImpl); }
  catch (e) { log("loadCodeAssist failed: " + e.message); }
  let projectId = projectIdFrom(data);
  let tierId = (data.currentTier && (data.currentTier.id || data.currentTier.name)) || "legacy-tier";
  if (projectId) {
    // Fire-and-forget onboarding for accounts that already have a project.
    postJson(ONBOARD_USER_URL, accessToken, { tier_id: tierId, metadata }, fetchImpl).catch(() => { });
    return { projectId, tierId };
  }
  for (let attempt = 1; attempt <= 3 && !projectId; attempt++) {
    try {
      await postJson(ONBOARD_USER_URL, accessToken, { tier_id: tierId, metadata }, fetchImpl);
      data = await postJson(LOAD_CODE_ASSIST_URL, accessToken, { metadata }, fetchImpl);
      projectId = projectIdFrom(data);
      tierId = (data.currentTier && (data.currentTier.id || data.currentTier.name)) || tierId;
    } catch (e) { log("onboardUser/discovery attempt " + attempt + " failed: " + e.message); }
    if (!projectId && attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  return { projectId, tierId };
}

export async function fetchUserInfo(accessToken, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(USERINFO_URL + "?alt=json", { headers: { authorization: "Bearer " + accessToken } });
    if (!res.ok) return {};
    return await res.json();
  } catch (e) { return {}; }
}

export async function ensureAccessToken(creds, { fetchImpl = fetch, force = false } = {}) {
  if (!creds) throw new Error("not logged in; run: cc-termux antigravity login");
  const expiresAt = Number(creds.expires_at || 0);
  if (!force && creds.access_token && expiresAt > Date.now() + 60_000) return creds.access_token;
  if (!creds.refresh_token) throw new Error("access token expired and no refresh token; run: cc-termux antigravity login");
  const t = await refreshToken(creds.refresh_token, fetchImpl);
  const next = {
    ...creds,
    access_token: t.access_token,
    refresh_token: t.refresh_token || creds.refresh_token,
    expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000,
    scope: t.scope || creds.scope,
  };
  saveCredentials(next);
  return next.access_token;
}

function openBrowser(url) {
  const cmds = process.platform === "win32" ? [["cmd", ["/c", "start", "", url]]]
    : process.platform === "darwin" ? [["open", [url]]]
    : [["termux-open-url", [url]], ["xdg-open", [url]], ["open", [url]]];
  for (const [cmd, args] of cmds) {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.on("error", () => { });
      child.unref();
      return true;
    } catch (e) { }
  }
  return false;
}

let activePrompt = null;
function askLine(prompt) {
  return new Promise((resolve) => {
    activePrompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    activePrompt.question(prompt, (a) => { const rl = activePrompt; activePrompt = null; try { rl.close(); } catch (e) { } resolve(a.trim()); });
  });
}
function closePrompt() { if (activePrompt) { try { activePrompt.close(); } catch (e) { } activePrompt = null; } }

// The Cloud Code catalog includes legacy aliases and plan-gated/internal models.
// The official Antigravity CLI only exposes: Claude Opus 4.6, Claude Sonnet 4.6,
// Gemini 3.8 Flash tiers, GPT-OSS 120B and (paid plans only) Gemini 4 Argon.
const OFFICIAL_MODEL_RE = /^(claude-opus-4-6-thinking|claude-sonnet-4-6|gemini-3\.8-flash-(high|medium|low)|gpt-oss-120b-medium)$/;
const ARGON_MODEL_RE = /^gemini-4-argon-(high|medium|low)$/;
export function parseAvailableModels(data) {
  const src = (data && data.models) || {};
  const models = [];
  const seen = new Set();
  const sortedIds = [];
  for (const sort of (data && data.agentModelSorts) || []) {
    for (const group of (sort && sort.groups) || []) {
      for (const id of (group && group.modelIds) || []) if (typeof id === "string") sortedIds.push(id);
    }
  }
  const add = (id, info) => {
    if (!id || seen.has(id) || !info || typeof info !== "object") return;
    if (info.isInternal === true || info.disabled === true) return;
    if (/^(tab_|chat_)/i.test(id) || /(^|[-_])(image|imagen|tts|audio|embedding|embed|video|veo|transcribe|tab)([-_]|$)/i.test(id)) return;
    seen.add(id);
    models.push({ id, name: info.displayName || id, contextTokens: Number(info.maxTokens) || 0, maxOutputTokens: Number(info.maxOutputTokens) || 0, recommended: info.recommended === true });
  };
  if (sortedIds.length) {
    for (const id of sortedIds) add(id, src[id]);
  } else {
    for (const [id, info] of Object.entries(src)) {
      const official = OFFICIAL_MODEL_RE.test(id) || ARGON_MODEL_RE.test(id);
      if (!official && process.env.CC_TERMUX_ANTIGRAVITY_ALL_MODELS !== "1") continue;
      add(id, info);
    }
  }
  return models;
}

function quotaWindowOf(bucket) {
  const w = String(bucket.window || "").toLowerCase();
  if (w === "5h" || w === "session") return "session";
  if (w === "weekly" || w === "7d") return "weekly";
  const text = (String(bucket.bucketId || "") + " " + String(bucket.displayName || "")).toLowerCase();
  if (/\b5h\b|five.?hour|session/.test(text)) return "session";
  if (/weekly|7d|seven.?day/.test(text)) return "weekly";
  return null;
}

function quotaGroupOf(displayName, groupId, bucketText) {
  const text = (String(displayName || "") + " " + String(groupId || "") + " " + (bucketText || "")).toLowerCase();
  if (/argon/.test(text) || /gemini[\s_-]*4/.test(text)) return { id: "argon", label: "Gemini 4 Argon" };
  if (/gemini/.test(text)) return { id: "gemini", label: "Gemini" };
  if (/claude|gpt|\b3p\b|third/.test(text)) return { id: "claude", label: "Claude & GPT" };
  return { id: String(groupId || displayName || "quota").replace(/[^a-z0-9]+/gi, "_"), label: displayName || groupId || "Quota" };
}

export function parseQuotaSummary(data) {
  const root = (data && data.quotaSummary) || data || {};
  const rawGroups = Array.isArray(root.groups) ? root.groups : [];
  const groups = [];
  for (const raw of rawGroups) {
    if (!raw || typeof raw !== "object") continue;
    const buckets = Array.isArray(raw.buckets) ? raw.buckets : [];
    const text = String(raw.displayName || "") + " " + buckets.map((b) => b.bucketId || "").join(" ");
    const g = quotaGroupOf(raw.displayName, raw.groupId || raw.id, text);
    const windows = {};
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object" || bucket.disabled === true) continue;
      const win = quotaWindowOf(bucket);
      if (!win) continue;
      const frac = Number(bucket.remaining && bucket.remaining.remainingFraction != null ? bucket.remaining.remainingFraction : bucket.remainingFraction);
      if (!Number.isFinite(frac)) continue;
      windows[win] = {
        percent: Math.max(0, Math.min(100, frac * 100)),
        resetAt: bucket.resetTime || (bucket.remaining && bucket.remaining.resetTime) || null,
        description: bucket.description || "",
      };
    }
    if (Object.keys(windows).length) groups.push({ ...g, windows });
  }
  return { groups };
}

export async function postCloud(urls, accessToken, body, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  let lastError = null;
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: antigravityHeaders(accessToken),
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401 || res.status === 403) throw new Error("Antigravity auth error " + res.status);
      if (!res.ok) { lastError = new Error(url + " HTTP " + res.status); continue; }
      return await res.json();
    } catch (e) { lastError = e; }
  }
  throw lastError || new Error("Antigravity API unavailable");
}

export async function fetchAvailableModels({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const creds = loadCredentials();
  if (!creds) throw new Error("not logged in; run: cc-termux antigravity login");
  const token = await ensureAccessToken(creds, { fetchImpl });
  const data = await postCloud(FETCH_MODELS_URLS, token, creds.project_id ? { project: creds.project_id } : {}, { fetchImpl, timeoutMs });
  return parseAvailableModels(data);
}

export async function fetchQuotaSummary({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const creds = loadCredentials();
  if (!creds) throw new Error("not logged in; run: cc-termux antigravity login");
  const token = await ensureAccessToken(creds, { fetchImpl });
  const data = await postCloud(QUOTA_SUMMARY_URLS, token, creds.project_id ? { project: creds.project_id } : {}, { fetchImpl, timeoutMs });
  return parseQuotaSummary(data);
}

export async function fetchQuotaBuckets({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const creds = loadCredentials();
  if (!creds) throw new Error("not logged in; run: cc-termux antigravity login");
  const token = await ensureAccessToken(creds, { fetchImpl });
  const data = await postCloud(QUOTA_URLS, token, creds.project_id ? { project: creds.project_id } : {}, { fetchImpl, timeoutMs });
  const byFamily = new Map();
  for (const b of (data && data.buckets) || []) {
    if (!b || typeof b !== "object") continue;
    const id = String(b.modelId || "");
    const family = /argon/.test(id) ? "argon" : /gemini/.test(id) ? "gemini" : /claude|gpt/.test(id) ? "claude" : "other";
    const frac = Number(b.remainingFraction);
    if (!Number.isFinite(frac)) continue;
    const cur = byFamily.get(family) || { id: family, label: family === "claude" ? "Claude & GPT" : family === "gemini" ? "Gemini" : family, windows: {} };
    const resetAt = b.resetTime || null;
    const prev = cur.windows.session;
    cur.windows.session = { percent: Math.min(prev ? prev.percent : 100, Math.max(0, Math.min(100, frac * 100))), resetAt: prev && prev.resetAt && resetAt ? (Date.parse(prev.resetAt) < Date.parse(resetAt) ? prev.resetAt : resetAt) : (prev && prev.resetAt) || resetAt || null, description: "" };
    byFamily.set(family, cur);
  }
  return { groups: [...byFamily.values()] };
}

export async function getAntigravityUsage({ force = false, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!force) {
    const cached = readUsageCache();
    if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < 60_000) return cached;
  }
  const creds = loadCredentials();
  if (!creds) throw new Error("not logged in; run: cc-termux antigravity login");
  let groups = [];
  let source = "summary";
  try { groups = (await fetchQuotaSummary({ fetchImpl, timeoutMs })).groups; } catch (e) { groups = []; }
  if (!groups.length) {
    try { groups = (await fetchQuotaBuckets({ fetchImpl, timeoutMs })).groups; source = "models"; } catch (e) { groups = []; }
  }
  const data = { groups, source, fetchedAt: Date.now(), email: creds.email || "", project: creds.project_id || "" };
  writeUsageCache(data);
  return data;
}

export async function updateProviderModels({ log = console.log, timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const models = await fetchAvailableModels({ fetchImpl, timeoutMs });
  if (!models.length) throw new Error("Antigravity returned no models");
  const cfgFile = process.env.CC_TERMUX_CONFIG || path.join(os.homedir(), ".config", "cc-termux", "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  const name = Object.keys(cfg.providers || {}).find((n) => cfg.providers[n].type === "antigravity") || "antigravity";
  const p = cfg.providers[name];
  if (!p) throw new Error("no antigravity provider configured; run cc-termux setup");
  const old = new Set(Object.keys(p.modelsById || {}));
  p.modelsById = {};
  for (const m of models) p.modelsById[m.id] = { name: m.name, contextTokens: m.contextTokens || 0, inUsd: null, outUsd: null };
  if (!p.modelsById[p.model]) p.model = p.modelsById["claude-sonnet-4-6"] ? "claude-sonnet-4-6" : models[0].id;
  if (cfg.override && cfg.override.provider === name && !p.modelsById[cfg.override.model]) cfg.override.model = p.model;
  p.defaultModel = p.defaultModel && p.modelsById[p.defaultModel] ? p.defaultModel : p.model;
  p.aliases = p.aliases || {};
  for (const k of Object.keys(p.aliases)) if (!p.modelsById[p.aliases[k]]) p.aliases[k] = p.model;
  cfg.routing = cfg.routing || {};
  for (const k of Object.keys(cfg.routing)) if (k.startsWith("prov/" + name + "/") || k.startsWith(name + "::")) delete cfg.routing[k];
  for (const m of models) cfg.routing["prov/" + name + "/" + m.id] = name + "::" + m.id;
  const tmp = cfgFile + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, cfgFile);
  // Refresh Claude Code's /model picker entries for this provider.
  const settingsFile = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json") : path.join(os.homedir(), ".claude", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    if (settings.modelPicker && Array.isArray(settings.modelPicker.options)) {
      if (typeof settings.model === "string" && settings.model.startsWith("prov/" + name + "/") && !models.some((m) => "prov/" + name + "/" + m.id === settings.model)) settings.model = "prov/" + name + "/" + p.model;
      settings.modelPicker.options = settings.modelPicker.options.filter((o) => !String(o.model || "").startsWith("prov/" + name + "/"));
      for (const m of models) {
        settings.modelPicker.options.push({
          model: "prov/" + name + "/" + m.id,
          label: (m.name || m.id) + "  [" + name + "]",
          description: (m.contextTokens ? Math.round(m.contextTokens / 1000) + "K ctx" : "antigravity") + (m.recommended ? " · recommended" : ""),
        });
      }
      const st = settingsFile + "." + process.pid + ".tmp";
      fs.writeFileSync(st, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(st, settingsFile);
    }
  } catch (e) { }
  log("updated " + models.length + " live Antigravity models (added " + models.filter((m) => !old.has(m.id)).length + ", removed " + [...old].filter((id) => !models.some((m) => m.id === id)).length + ")");
  return models;
}

export function parseCallbackInput(input, expectedState) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("empty input");
  let code = null, state = expectedState || null, error = null, errorDescription = null;
  try {
    const u = new URL(raw);
    code = u.searchParams.get("code");
    state = u.searchParams.get("state") || u.hash.replace(/^#/, "") || state;
    error = u.searchParams.get("error");
    errorDescription = u.searchParams.get("error_description");
  } catch (e) {
    const [c, s] = raw.split("#", 2);
    code = c || null;
    state = s || state;
  }
  if (error) throw new Error(errorDescription || error);
  if (!code) throw new Error("no authorization code found in the pasted value");
  if (expectedState && state && state !== expectedState) throw new Error("OAuth state mismatch");
  return { code, state };
}

export async function login({ log = console.log, timeoutMs = 300000, fetchImpl = fetch, browser = true } = {}) {
  const state = crypto.randomBytes(16).toString("hex");
  let server = null;
  let redirectUri = "";
  const resultPromise = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") { res.writeHead(404); res.end("not found"); return; }
      const code = u.searchParams.get("code");
      const gotState = u.searchParams.get("state");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h2>Authentication complete</h2><p>You can close this tab and return to Termux.</p></body></html>");
      if (err) return reject(new Error("Google OAuth error: " + err));
      if (!code) return reject(new Error("no code in callback"));
      if (gotState !== state) return reject(new Error("OAuth state mismatch"));
      resolve({ code });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      redirectUri = "http://127.0.0.1:" + port + "/callback";
      const url = buildAuthUrl(redirectUri, state);
      log("Open this URL in a browser:\n\n" + url + "\n");
      if (browser && !openBrowser(url)) log("(could not open a browser automatically)");
      log("If Google shows an authorization code or a callback URL instead of redirecting,");
      log("paste it below. Otherwise just wait for the browser redirect.");
    });
  });
  // Accept a manually pasted callback URL / raw code too (headless/browser code screens).
  let manualInput = process.env.CC_TERMUX_ANTIGRAVITY_CODE || process.env.CC_TERMUX_OAUTH_CALLBACK_URL || "";
  const manualPromise = (async () => {
    if (manualInput) return parseCallbackInput(manualInput, state);
    if (!process.stdin.isTTY) return await new Promise(() => { }); // headless: wait for callback/env code
    for (;;) {
      let input = "";
      try { input = await askLine("Paste callback URL, code, or just press Enter to keep waiting > "); } catch (e) { return await new Promise(() => { }); }
      if (!input) continue; // keep waiting for the browser callback
      try { return parseCallbackInput(input, state); }
      catch (e) { log("Could not use that value: " + e.message); log("Paste the full callback URL or the code, or wait for the redirect."); }
    }
  })();
  let timer;
  try {
    const result = await Promise.race([
      resultPromise,
      manualPromise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("OAuth timed out; retry or paste a code/URL")), timeoutMs); }),
    ]);
    const code = typeof result === "string" ? result : result.code;
    clearTimeout(timer);
    const tokens = await exchangeCode(code, redirectUri, fetchImpl);
    const user = await fetchUserInfo(tokens.access_token, fetchImpl);
    const project = await discoverProject(tokens.access_token, { fetchImpl, log });
    const creds = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
      scope: tokens.scope, email: user.email || "", project_id: project.projectId || "", tier_id: project.tierId || "",
      client_profile: "ide", created_at: new Date().toISOString(),
    };
    if (!creds.project_id && process.stdin.isTTY) {
      console.log("Google did not return a Cloud Code project id.");
      const manual = (await askLine("GCP project id (leave empty to abort) > ")).trim();
      if (/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(manual)) creds.project_id = manual;
    }
    if (!creds.project_id) throw new Error("Google account has no Cloud Code project. Run 'agy login' once, create/enter a GCP project, then retry.");
    saveCredentials(creds);
    return creds;
  } finally {
    clearTimeout(timer);
    closePrompt();
    if (server) try { server.close(); } catch (e) { }
  }
}

export async function ensureProject({ log = console.log, fetchImpl = fetch } = {}) {
  const creds = loadCredentials();
  if (!creds) throw new Error("not logged in; run: cc-termux antigravity login");
  const token = await ensureAccessToken(creds, { fetchImpl });
  if (creds.project_id) return creds;
  const project = await discoverProject(token, { fetchImpl, log });
  if (!project.projectId) throw new Error("no Cloud Code project found; run 'agy login' or add a GCP project id");
  creds.project_id = project.projectId;
  creds.tier_id = project.tierId || creds.tier_id;
  saveCredentials(creds);
  return creds;
}

function status() {
  const c = loadCredentials();
  if (!c) { console.log("Antigravity: not logged in"); return; }
  console.log("Antigravity: logged in" + (c.email ? " as " + c.email : ""));
  console.log("  project: " + (c.project_id || "(missing)"));
  console.log("  tier:    " + (c.tier_id || "unknown"));
  console.log("  expires: " + new Date(Number(c.expires_at || 0)).toISOString());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] || "status";
  if (cmd === "usage") {
    getAntigravityUsage({ force: true }).then((u) => {
      if (!u.groups.length) { console.log("Antigravity usage unavailable"); return; }
      for (const g of u.groups) {
        const parts = [];
        const rel = (iso) => { const t = Date.parse(iso || ""); if (!Number.isFinite(t)) return ""; const m = Math.round((t - Date.now()) / 60000); if (m <= 0) return " now"; if (m < 60) return " " + m + "m"; const h = Math.floor(m / 60); if (h >= 24) { const d = Math.floor(h / 24); return " " + d + "d" + (h % 24 ? (h % 24) + "h" : ""); } return " " + h + "h" + (m % 60 ? (m % 60) + "m" : ""); };
        if (g.windows.session) parts.push("5h " + Math.round(g.windows.session.percent) + "%" + (rel(g.windows.session.resetAt) ? " (resets" + rel(g.windows.session.resetAt) + ")" : ""));
        if (g.windows.weekly) parts.push("weekly " + Math.round(g.windows.weekly.percent) + "%" + (rel(g.windows.weekly.resetAt) ? " (resets" + rel(g.windows.weekly.resetAt) + ")" : ""));
        console.log(g.label + ": " + parts.join("  "));
      }
    }).catch((e) => { console.error("usage: " + e.message); process.exit(1); });
  } else if (cmd === "models") {
    (process.argv.includes("--update") ? updateProviderModels({ timeoutMs: 15000 }) : fetchAvailableModels({ timeoutMs: 15000 })).then((models) => {
      if (process.argv.includes("--json")) { console.log(JSON.stringify(models, null, 2)); return; }
      console.log(models.length + " models");
      for (const m of models) console.log("  " + m.id + "  " + m.name + (m.contextTokens ? "  " + Math.round(m.contextTokens / 1000) + "K ctx" : ""));
    }).catch((e) => { console.error("models: " + e.message); process.exit(1); });
  } else if (cmd === "login") {
    login().then((c) => { console.log("Antigravity login OK" + (c.email ? " (" + c.email + ")" : "")); }).catch((e) => { console.error("Antigravity login failed: " + e.message); process.exit(1); });
  } else if (cmd === "logout") {
    clearCredentials(); console.log("Antigravity credentials removed");
  } else if (cmd === "status") status();
  else console.log("usage: cc-antigravity [login|status|logout]");
}
