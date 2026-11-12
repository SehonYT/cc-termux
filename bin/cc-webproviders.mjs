#!/usr/bin/env node
// Web search providers: Tavily, Brave, Jina, then the built-in scraper.
// The chain is tried in order; quota, rate limit or failure moves to the next one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir } from "./cc-paths.mjs";

export const WEB_PROVIDERS = ["google", "tavily", "brave", "jina", "local"];

export const PROVIDER_INFO = {
  google: {
    label: "Google Search (Antigravity)",
    keyUrl: "",
    env: "",
    needsKey: false,
    antigravityOnly: true,
    note: "Google's own index through your Antigravity account; no key needed",
  },
  tavily: {
    label: "Tavily",
    keyUrl: "https://app.tavily.com/home",
    env: "TAVILY_API_KEY",
    needsKey: false,
    note: "keyless works with a daily cap; a free key raises the limit",
  },
  brave: {
    label: "Brave Search API",
    keyUrl: "https://api-dashboard.search.brave.com/app/keys",
    env: "BRAVE_API_KEY",
    needsKey: true,
    note: "free plan: 1 query/second, 2000/month",
  },
  jina: {
    label: "Jina Reader",
    keyUrl: "https://jina.ai/reader",
    env: "JINA_API_KEY",
    needsKey: true,
    note: "s.jina.ai search and r.jina.ai page reading; free tier without a key",
  },
  local: {
    label: "Local scraper (built in)",
    keyUrl: "",
    env: "",
    needsKey: false,
    note: "Bing, DuckDuckGo, Google, Brave and Startpage scrapers; no key, always available",
  },
};

export function webConfigPath() {
  const dir = configDir();
  return path.join(dir, "web.json");
}
export function readWebConfig() {
  try { return JSON.parse(fs.readFileSync(webConfigPath(), "utf8")); } catch (e) { return {}; }
}
export function writeWebConfig(cfg) {
  try {
    const file = webConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (e) { }
  } catch (e) { }
  return cfg;
}

export function providerKey(name, cfg = readWebConfig()) {
  const info = PROVIDER_INFO[name] || {};
  const stored = (cfg.keys || {})[name];
  if (stored) return stored;
  if (info.env && process.env[info.env]) return process.env[info.env];
  return "";
}

// The chain the user configured, minus providers that need a key and have none.
// "local" is always appended as the final fallback.
export function resolveChain(name, cfg = readWebConfig(), { antigravity = false } = {}) {
  const stored = (cfg.chains || {})[name];
  const list = Array.isArray(stored) && stored.length ? stored.slice() : WEB_PROVIDERS.slice(0, -1);
  const out = [];
  for (const id of list) {
    const info = PROVIDER_INFO[id];
    if (!info) continue;
    if (info.antigravityOnly && !antigravity) continue;
    if (info.needsKey && !providerKey(id, cfg)) continue;
    out.push(id);
  }
  if (!out.includes("local")) out.push("local");
  return out;
}

export function hasAnyRemoteKey(cfg = readWebConfig()) {
  return WEB_PROVIDERS.slice(0, -1).some((id) => providerKey(id, cfg));
}

// ------------------------------------------------------------------ providers

export function isQuotaError(status, text) {
  if (status === 429 || status === 402 || status === 403) return true;
  return /quota|rate.?limit|too many requests|daily_cap|credits?|insufficient|exceeded|unauthorized|invalid api key|authentication/i.test(String(text || ""));
}

// Tavily: POST /search. Keyless works with an X-Tavily-Access-Mode header, so it is a
// usable provider even before the user adds a key.
export async function tavilySearch(query, { maxResults = 8, key = "", fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const headers = { "content-type": "application/json" };
  const body = { query, max_results: Math.min(20, maxResults), search_depth: "basic" };
  if (key) headers.authorization = "Bearer " + key;
  else headers["X-Tavily-Access-Mode"] = "keyless";
  const res = await fetchImpl("https://api.tavily.com/search", {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (e) { }
  if (!res.ok || (j && j.error)) {
    const msg = (j && j.error && (j.error.message || j.error.code)) || text.slice(0, 200) || ("HTTP " + res.status);
    const err = new Error("Tavily: " + msg);
    err.status = res.status;
    err.quota = isQuotaError(res.status, msg);
    throw err;
  }
  const rows = (j.results || []).map((r) => ({
    title: String(r.title || ""), url: String(r.url || ""),
    snippet: String(r.content || r.snippet || "").slice(0, 500),
  }));
  return { rows, answer: j.answer ? String(j.answer) : "", provider: "tavily" };
}

// Brave: GET /res/v1/web/search with the subscription token in a header.
export async function braveSearch(query, { maxResults = 8, key = "", fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  if (!key) { const e = new Error("Brave: no API key"); e.quota = true; throw e; }
  const url = "https://api.search.brave.com/res/v1/web/search?q=" + encodeURIComponent(query) +
    "&count=" + Math.min(20, maxResults) + "&extra_snippets=true";
  const res = await fetchImpl(url, {
    headers: { accept: "application/json", "accept-encoding": "gzip", "x-subscription-token": key },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (e) { }
  if (!res.ok || (j && j.error)) {
    const msg = (j && j.error && (j.error.detail || j.error.code)) || text.slice(0, 200) || ("HTTP " + res.status);
    const err = new Error("Brave: " + msg);
    err.status = res.status;
    err.quota = isQuotaError(res.status, msg) || res.status === 422;
    throw err;
  }
  const rows = ((j.web && j.web.results) || []).map((r) => ({
    title: String(r.title || ""), url: String(r.url || ""),
    snippet: String(r.description || (Array.isArray(r.extra_snippets) ? r.extra_snippets[0] : "") || "").slice(0, 500),
  }));
  return { rows, answer: "", provider: "brave" };
}

// Jina: s.jina.ai/<query> returns SERP text; r.jina.ai/<url> reads one page.
export async function jinaSearch(query, { maxResults = 8, key = "", fetchImpl = fetch, timeoutMs = 25000 } = {}) {
  const headers = { accept: "application/json", "x-respond-with": "markdown" };
  if (key) headers.authorization = "Bearer " + key;
  const res = await fetchImpl("https://s.jina.ai/" + encodeURIComponent(query), { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (e) { }
  if (!res.ok || (j && j.code >= 400)) {
    const msg = (j && (j.readableMessage || j.message)) || text.slice(0, 200) || ("HTTP " + res.status);
    const err = new Error("Jina: " + msg);
    err.status = res.status;
    err.quota = isQuotaError(res.status, msg);
    throw err;
  }
  const rows = [];
  const push = (title, url, snippet) => {
    if (!url || !/^https?:\/\//i.test(url)) return;
    rows.push({ title: String(title || url).slice(0, 200), url: String(url), snippet: String(snippet || "").slice(0, 500) });
  };
  const entries = Array.isArray(j && j.data) ? j.data : [];
  for (const item of entries) push(item.title, item.url, item.content || item.description);
  if (!rows.length && typeof text === "string" && !j) {
    // The text mode returns "Title:\n...\nURL Source: ..." blocks.
    const blocks = text.split(/\n(?=Title:)/);
    for (const b of blocks) {
      const title = (/Title:\s*(.+)/.exec(b) || [])[1];
      const url = (/URL Source:\s*(\S+)/.exec(b) || [])[1];
      const body = b.replace(/^[\s\S]*?Markdown Content:/, "").trim();
      push(title, url, body);
    }
  }
  return { rows: rows.slice(0, maxResults), answer: "", provider: "jina" };
}

// Cloud Code streams `response.candidates[*].content.parts[*].text` plus groundingMetadata.
export function parseGroundingSse(text) {
  let answer = "";
  const sources = [];
  const queries = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.startsWith("data:")) continue;
    let frame = null;
    try { frame = JSON.parse(line.slice(5)); } catch (e) { continue; }
    const candidate = (((frame.response || {}).candidates) || [])[0];
    if (!candidate) continue;
    for (const part of (candidate.content || {}).parts || []) if (part.text) answer += part.text;
    const meta = candidate.groundingMetadata;
    if (meta) {
      for (const q of meta.webSearchQueries || []) queries.push(String(q));
      for (const chunk of meta.groundingChunks || []) {
        const web = chunk.web || {};
        if (web.uri) sources.push({ title: String(web.title || web.uri), url: String(web.uri) });
      }
    }
  }
  return { answer, sources, queries };
}

// Grounding only works on Gemini, so pick one from the configured Antigravity models and
// fall back to a known-good default when the catalog is unavailable.
export async function pickGeminiModel() {
  const preferred = ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"];
  try {
    const { configFile } = await import("./cc-paths.mjs");
    const cfg = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    const models = Object.keys(((cfg.providers || {}).antigravity || {}).modelsById || {});
    const gemini = models.filter((id) => /^gemini-/.test(id));
    for (const p of preferred) if (gemini.includes(p)) return p;
    if (gemini.length) return gemini[0];
  } catch (e) { }
  return preferred[0];
}

// Google grounding via Antigravity: tool-free, because Cloud Code rejects googleSearch
// together with functionDeclarations. No external key, only an Antigravity login.
export async function antigravityGrounding(query, { fetchImpl = fetch, timeoutMs = 45000, model = null } = {}) {
  const [{ anthropicToGemini }, antigravity] = await Promise.all([
    import("../proxy/antigravity.mjs"),
    import("./cc-antigravity.mjs"),
  ]);
  const creds = antigravity.loadCredentials();
  if (!creds) { const e = new Error("Antigravity: not logged in"); e.quota = true; throw e; }
  let token;
  try { token = await antigravity.ensureAccessToken(creds); }
  catch (err) { const e = new Error("Antigravity: " + err.message); e.quota = true; throw e; }

  // Only Gemini models honour googleSearch; Claude and GPT-OSS on Antigravity accept the
  // request but silently drop it, so grounding always runs on a Gemini model.
  const requested = model || process.env.CC_TERMUX_ANTIGRAVITY_GROUNDING_MODEL || "";
  const chosen = /^gemini-/.test(requested) ? requested : await pickGeminiModel();
  const prompt = "Use Google Search to answer this query, then reply with a short factual summary "
    + "and the source titles you used.\n\nQuery: " + query;
  const envelope = anthropicToGemini({ messages: [{ role: "user", content: prompt }], max_tokens: 1024 }, chosen, creds);
  const res = await fetchImpl(antigravity.GENERATE_URLS[0], {
    method: "POST",
    headers: { "content-type": "application/json", ...antigravity.antigravityContentHeaders(token) },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try { msg = (JSON.parse(text).error || {}).message || msg; } catch (e) { }
    const err = new Error("Antigravity grounding: " + msg);
    err.status = res.status;
    err.quota = isQuotaError(res.status, msg) || res.status === 404;
    throw err;
  }
  const { answer, sources, queries } = parseGroundingSse(text);
  const rows = sources.map((s) => ({ title: s.title, url: s.url, snippet: "" }));
  // Keep the answer itself as a result too, so the agent gets the grounded summary directly.
  if (answer.trim()) rows.unshift({ title: "Google Search summary: " + query, url: "https://www.google.com/search?q=" + encodeURIComponent(query), snippet: answer.trim().slice(0, 1200) });
  if (!rows.length) { const e = new Error("Antigravity grounding returned nothing"); e.quota = false; throw e; }
  return { rows, answer: answer.trim(), queries, provider: "google" };
}

export async function jinaRead(url, { key = "", fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const headers = { accept: "application/json", "x-respond-with": "markdown" };
  if (key) headers.authorization = "Bearer " + key;
  const res = await fetchImpl("https://r.jina.ai/" + url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (e) { }
  if (!res.ok || (j && j.code >= 400)) {
    const msg = (j && (j.readableMessage || j.message)) || text.slice(0, 200);
    const err = new Error("Jina reader: " + msg);
    err.status = res.status;
    err.quota = isQuotaError(res.status, msg);
    throw err;
  }
  if (j && j.data) return { text: String(j.data.content || ""), title: String(j.data.title || ""), provider: "jina" };
  return { text: String(text), title: "", provider: "jina" };
}

export const SEARCH_FNS = { google: antigravityGrounding, tavily: tavilySearch, brave: braveSearch, jina: jinaSearch };

// Runs the chain in order and reports what was tried, so the caller can say why it fell back.
export async function searchChain(query, { chain, maxResults = 8, cfg = readWebConfig(), localSearch = null, log = () => {} } = {}) {
  const order = chain || resolveChain("search", cfg);
  const attempts = [];
  for (const id of order) {
    try {
      if (id === "local") {
        if (!localSearch) { attempts.push({ provider: "local", status: "unavailable", message: "local scraper not wired" }); continue; }
        const rows = await localSearch(query, maxResults);
        if (!rows.length) { attempts.push({ provider: "local", status: "empty", message: "no results" }); continue; }
        attempts.push({ provider: "local", status: "ok", count: rows.length });
        return { rows, provider: "local", attempts };
      }
      const fn = SEARCH_FNS[id];
      if (!fn) continue;
      const key = providerKey(id, cfg);
      const out = await fn(query, { maxResults, key });
      if (!out.rows.length) { attempts.push({ provider: id, status: "empty", message: "no results" }); continue; }
      attempts.push({ provider: id, status: "ok", count: out.rows.length });
      return { rows: out.rows, provider: id, answer: out.answer, attempts };
    } catch (e) {
      attempts.push({ provider: id, status: e.quota ? "quota" : "error", message: e.message });
      log(id + " failed (" + (e.quota ? "quota" : "error") + "): " + e.message);
    }
  }
  return { rows: [], provider: null, attempts };
}
