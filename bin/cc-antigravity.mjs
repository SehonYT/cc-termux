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
  try {
    await postJson(ONBOARD_USER_URL, accessToken, { tier_id: tierId, metadata }, fetchImpl);
    data = await postJson(LOAD_CODE_ASSIST_URL, accessToken, { metadata }, fetchImpl);
    projectId = projectIdFrom(data);
    tierId = (data.currentTier && (data.currentTier.id || data.currentTier.name)) || tierId;
  } catch (e) { log("onboardUser/retry failed: " + e.message); }
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

function askLine(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); });
  });
}

export async function login({ log = console.log, timeoutMs = 300000, fetchImpl = fetch } = {}) {
  const state = crypto.randomBytes(16).toString("hex");
  let server = null;
  let redirectUri = "";
  const resultPromise = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://localhost");
      if (u.pathname !== "/callback") { res.writeHead(404); res.end("not found"); return; }
      const code = u.searchParams.get("code");
      const gotState = u.searchParams.get("state");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h2>Authentication complete</h2><p>You can close this tab and return to Termux.</p></body></html>");
      if (err) return reject(new Error("Google OAuth error: " + err));
      if (!code) return reject(new Error("no code in callback"));
      if (gotState !== state) return reject(new Error("OAuth state mismatch"));
      resolve(code);
    });
    server.on("error", reject);
    server.listen(0, "0.0.0.0", () => {
      const port = server.address().port;
      redirectUri = "http://localhost:" + port + "/callback";
      const url = buildAuthUrl(redirectUri, state);
      log("Open this URL in a browser:\n\n" + url + "\n");
      if (!openBrowser(url)) log("(could not open a browser automatically)");
      log("Waiting for Google to redirect back...");
    });
  });
  let timer;
  try {
    const code = await Promise.race([
      resultPromise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("OAuth timed out")), timeoutMs); }),
    ]);
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
    if (!creds.project_id) throw new Error("Google account has no Cloud Code project. Run 'agy login' once or create a GCP project, then retry.");
    saveCredentials(creds);
    return creds;
  } finally {
    clearTimeout(timer);
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
  if (cmd === "login") {
    login().then((c) => { console.log("Antigravity login OK" + (c.email ? " (" + c.email + ")" : "")); }).catch((e) => { console.error("Antigravity login failed: " + e.message); process.exit(1); });
  } else if (cmd === "logout") {
    clearCredentials(); console.log("Antigravity credentials removed");
  } else if (cmd === "status") status();
  else console.log("usage: cc-antigravity [login|status|logout]");
}
