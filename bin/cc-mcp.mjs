#!/usr/bin/env node
// Minimal stdio MCP server that gives Claude Code working web access on platforms where
// the built-in tools cannot work (for example Termux, where the musl build of Claude Code
// cannot read /etc/resolv.conf and every DNS lookup fails with EAI_AGAIN).
//
// Tools:
//   web_search  - DuckDuckGo (HTML endpoint) search, returns titles, URLs and snippets
//   web_fetch   - downloads any http(s) URL and returns readable text
//
// Registered automatically in ~/.claude.json under mcpServers["cc-termux"].

import readline from "node:readline";
import { fileURLToPath } from "node:url";

const VERSION = "1.0.0";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function htmlToText(html) {
  const title = (() => {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html));
    return m ? decodeEntities(String(m[1]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim() : "";
  })();
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  return { title, text: decodeEntities(text) };
}

async function fetchText(url, { timeoutMs = 20000, maxBytes = 3_000_000 } = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", "accept-language": "en" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const type = String(res.headers.get("content-type") || "");
  const buf = Buffer.from(await res.arrayBuffer());
  const body = buf.subarray(0, maxBytes).toString("utf8");
  return { status: res.status, url: res.url || url, type, body, bytes: buf.length };
}

export function parseDuckDuckGo(html) {
  const out = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [...String(html).matchAll(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => htmlToText(m[1]).text.replace(/\s+/g, " ").trim());
  let m, i = 0;
  while ((m = linkRe.exec(html))) {
    let href = decodeEntities(m[1]);
    const target = /[?&]uddg=([^&]+)/.exec(href);
    if (target) href = decodeURIComponent(target[1]);
    if (href.startsWith("//")) href = "https:" + href;
    out.push({ title: htmlToText(m[2]).text.replace(/\s+/g, " ").trim(), url: href, snippet: snippets[i] || "" });
    i++;
  }
  if (!out.length) {
    const lite = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = lite.exec(html))) out.push({ title: htmlToText(m[2]).text.trim(), url: decodeEntities(m[1]), snippet: "" });
  }
  return out.filter((r) => /^https?:\/\//.test(r.url) && !/duckduckgo\.com/.test(r.url));
}

// Bing wraps results in https://www.bing.com/ck/a?...&u=a1<base64url>; decode to the target.
export function unwrapBingUrl(href) {
  const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(href);
  if (m) {
    try {
      const decoded = Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch (e) { }
  }
  return href;
}

export function parseBing(html) {
  const out = [];
  const blocks = String(html).split(/<li class="b_algo"/i).slice(1);
  for (const block of blocks) {
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const href = unwrapBingUrl(decodeEntities(a[1]));
    if (!/^https?:\/\//i.test(href)) continue;
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    out.push({
      title: htmlToText(a[2]).text.replace(/\s+/g, " ").trim(),
      url: href,
      snippet: snippet ? htmlToText(snippet[1]).text.replace(/\s+/g, " ").trim().slice(0, 300) : "",
    });
  }
  return out;
}

async function bingSearch(query) {
  const res = await fetch("https://www.bing.com/search?q=" + encodeURIComponent(query) + "&setlang=en&cc=US", {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("bing status " + res.status);
  return parseBing(await res.text());
}

export async function webSearch(query, { maxResults = 8 } = {}) {
  const limit = Math.max(1, Math.min(20, maxResults));
  // Bing's HTML results are the reliable source here; DuckDuckGo answers with an
  // anti-bot page from many networks, so it is only a fallback.
  try {
    const bing = await bingSearch(query);
    if (bing.length) return bing.slice(0, limit);
  } catch (e) { }
  return (await duckDuckGoSearch(query)).slice(0, limit);
}

export async function duckDuckGoSearch(query) {
  const body = new URLSearchParams({ q: query, kl: "wt-wt" });
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "user-agent": UA,
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      // Without a same-origin referer DuckDuckGo answers 202 with an anti-bot page.
      referer: "https://html.duckduckgo.com/",
      origin: "https://html.duckduckgo.com",
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const html = await res.text();
  let results = parseDuckDuckGo(html);
  if (!results.length) {
    const lite = await fetch("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query), {
      headers: { "user-agent": UA, accept: "text/html" },
      signal: AbortSignal.timeout(20000),
    }).then((r) => r.text()).catch(() => "");
    results = parseDuckDuckGo(lite);
  }
  return results;
}

export async function webFetch(url, { maxChars = 15000 } = {}) {
  if (!/^https?:\/\//i.test(String(url))) throw new Error("url must start with http:// or https://");
  const r = await fetchText(url);
  const isHtml = /html|xml/i.test(r.type) || /<html/i.test(r.body.slice(0, 500));
  const { title, text } = isHtml ? htmlToText(r.body) : { title: "", text: r.body };
  const cap = Math.max(1000, Math.min(60000, Number(maxChars) || 15000));
  const clipped = text.length > cap ? text.slice(0, cap) + "\n\n[truncated at " + cap + " characters of " + text.length + "]" : text;
  return { status: r.status, url: r.url, title, text: clipped, bytes: r.bytes };
}

const TOOLS = [
  {
    name: "web_search",
    description: "Search the web with DuckDuckGo. Use this instead of WebSearch when WebSearch returns no results. Returns titles, URLs and snippets.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query" }, max_results: { type: "number", description: "How many results (default 8)" } }, required: ["query"] },
  },
  {
    name: "web_fetch",
    description: "Download any http(s) URL and return its readable text (HTML is converted to text). Use this instead of WebFetch when WebFetch fails with a domain or DNS error.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "Absolute http(s) URL" }, max_chars: { type: "number", description: "Maximum characters to return (default 15000)" } }, required: ["url"] },
  },
];

export async function callTool(name, args = {}) {
  if (name === "web_search") {
    const results = await webSearch(String(args.query || ""), { maxResults: Number(args.max_results) || 8 });
    if (!results.length) return { text: "No results found for: " + args.query, isError: false };
    return { text: results.map((r, i) => i + 1 + ". " + r.title + "\n   " + r.url + (r.snippet ? "\n   " + r.snippet : "")).join("\n\n"), isError: false };
  }
  if (name === "web_fetch") {
    const r = await webFetch(String(args.url || ""), { maxChars: Number(args.max_chars) || 15000 });
    const head = (r.title ? "Title: " + r.title + "\n" : "") + "URL: " + r.url + " (HTTP " + r.status + ")\n\n";
    return { text: head + r.text, isError: false };
  }
  throw new Error("unknown tool: " + name);
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

export function handleRequest(msg) {
  const id = msg.id;
  const method = msg.method;
  if (method === "initialize") {
    return { jsonrpc: "2.0", id, result: { protocolVersion: msg.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "cc-termux", version: VERSION } } };
  }
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    return callTool(name, args).then(
      (r) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: r.text }], isError: !!r.isError } }),
      (e) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Error: " + (e && e.message || e) }], isError: true } }),
    );
  }
  if (id === undefined) return null; // notification
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } };
}

export function start() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch (e) { return; }
    Promise.resolve(handleRequest(msg)).then((res) => { if (res) send(res); }).catch((e) => {
      if (msg && msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e && e.message || e) } });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) start();
