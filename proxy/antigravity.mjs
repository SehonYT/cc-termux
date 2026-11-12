// Google Antigravity (Cloud Code API) adapter for the local gateway.
// Translates Anthropic Messages <-> Gemini generateContent and streams SSE.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { cacheDir } from "../bin/cc-paths.mjs";
import path from "node:path";
import { ensureAccessToken, loadCredentials, GENERATE_URLS, antigravityContentHeaders } from "../bin/cc-antigravity.mjs";
import { refreshStatusLine } from "../bin/cc-statusline.mjs";

const MODEL_ALIASES = {
  "gemini-3.7-flash": "gemini-3.7-flash-tiered",
  "gemini-3.7-flash-high": "gemini-3.7-flash-tiered",
  "gemini-3.7-flash-medium": "gemini-3.7-flash-tiered",
  "gemini-3.7-flash-low": "gemini-3.7-flash-tiered",
  "gemini-3.8-flash": "gemini-3.8-flash-high",
  "gemini-3.8-flash-tiered": "gemini-3.8-flash-high",
  "gemini-4-argon": "gemini-4-argon-medium",
  "gpt-oss-120b": "gpt-oss-120b-medium",
  "gemini-3.1-pro-high": "gemini-pro-agent",
  "gemini-claude-sonnet-4-5": "claude-sonnet-4-6",
  "gemini-claude-sonnet-4-5-thinking": "claude-sonnet-4-6",
  "gemini-claude-opus-4-5-thinking": "claude-opus-4-6-thinking",
};
const upstreamModel = (m) => MODEL_ALIASES[m] || m;

const MAX_OUTPUT = 65536;
// Antigravity sends this lightweight system prompt itself; an oversized systemInstruction
// is rejected with a misleading 429, so the client prompt moves to the first user turn.
const DEFAULT_SYSTEM =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.\n" +
  "You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.\n" +
  "**Absolute paths only**\n" +
  "**Proactiveness**";
// Output ceilings Antigravity publishes per model family.
function outputCap(model) {
  const id = String(model || "");
  if (/^claude|claude-/.test(id)) return 16384;
  if (/gpt-oss/.test(id)) return 32768;
  return MAX_OUTPUT;
}
// reasoning effort -> thinking budget (Antigravity's own mapping).
function thinkingBudgetFor(body) {
  const t = body.thinking || {};
  const explicit = Number(t.budget_tokens);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, MAX_OUTPUT);
  const effort = String((body.output_config && body.output_config.effort) || body.effort || t.type || "").toLowerCase();
  if (effort === "none" || t.type === "disabled") return 0;
  if (effort === "low" || effort === "minimal") return 1024;
  if (effort === "high" || effort === "auto" || effort === "max" || effort === "xhigh" || effort === "adaptive" || t.type === "adaptive") return 32768;
  if (effort === "medium" || t.type === "enabled") return 8192;
  return 0;
}
const SIGNATURE_CACHE = new Map();
function rememberSignature(id, sig) {
  if (!id || typeof sig !== "string" || !sig) return;
  SIGNATURE_CACHE.set(id, sig);
  if (SIGNATURE_CACHE.size > 2000) SIGNATURE_CACHE.delete(SIGNATURE_CACHE.keys().next().value);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Claude Code retries a 429 up to 11 times, so remember a refusal briefly and answer
// locally instead of resending an identical body.
const REFUSALS = new Map();
const REFUSAL_BASE_MS = 2 * 60 * 1000;
const REFUSAL_MAX_MS = 30 * 60 * 1000;
function refusalKey(envelope) {
  const r = envelope.request || {};
  return crypto.createHash("sha256").update(JSON.stringify([
    envelope.project || "", envelope.model || "", r.systemInstruction || null,
    r.contents || null, r.tools || null, r.toolConfig || null, r.generationConfig || null,
  ])).digest("hex");
}
function activeRefusal(key) {
  const until = REFUSALS.get(key);
  if (!until) return 0;
  if (until <= Date.now()) { REFUSALS.delete(key); return 0; }
  return until;
}
function rememberRefusal(key, hintMs) {
  const prev = REFUSALS.get(key);
  const strikes = prev ? 2 : 1;
  const ms = hintMs > 0 ? Math.min(hintMs, REFUSAL_MAX_MS) : Math.min(REFUSAL_BASE_MS * strikes, REFUSAL_MAX_MS);
  REFUSALS.set(key, Date.now() + ms);
  if (REFUSALS.size > 500) REFUSALS.delete(REFUSALS.keys().next().value);
  return ms;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");
}

const SCHEMA_DENY = new Set([
  "$schema", "$defs", "definitions", "$ref", "$comment", "$id", "$anchor", "additionalProperties",
  "propertyNames", "patternProperties", "title", "const", "default", "examples", "exclusiveMinimum",
  "exclusiveMaximum", "minimum", "maximum", "multipleOf", "minLength", "maxLength", "pattern", "format",
  "uniqueItems", "minItems", "maxItems", "minProperties", "maxProperties", "readOnly", "writeOnly",
  "deprecated", "if", "then", "else", "not", "oneOf", "anyOf", "allOf", "dependencies", "dependentRequired",
  "dependentSchemas", "contains", "unevaluatedProperties", "unevaluatedItems", "$dynamicRef", "$recursiveRef",
]);
function cleanSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (SCHEMA_DENY.has(k) || k.startsWith("x-")) continue;
    if (k === "properties" && v && typeof v === "object") {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) {
        const cleaned = cleanSchema(pv);
        if (cleaned && typeof cleaned === "object" && Object.keys(cleaned).length) out.properties[pk] = cleaned;
      }
    } else if (k === "items") out.items = cleanSchema(v);
    else if (k === "type") {
      if (Array.isArray(v)) { out.type = String(v[0] || "string").toLowerCase(); if (v.includes("null")) out.nullable = true; }
      else out.type = String(v).toLowerCase();
    } else out[k] = cleanSchema(v);
  }
  // Gemini rejects required entries that point at properties removed above.
  if (out.properties && typeof out.properties === "object") {
    const keys = new Set(Object.keys(out.properties));
    if (Array.isArray(schema.required)) {
      out.required = schema.required.filter((key) => typeof key === "string" && keys.has(key));
      if (!out.required.length) delete out.required;
    }
    if (!keys.size) delete out.properties;
  } else if (Array.isArray(out.required)) {
    delete out.required;
  }
  return out;
}

function imagePart(block) {
  const s = block.source || {};
  if (s.type === "base64" && s.data) return { inlineData: { mimeType: s.media_type || "image/png", data: s.data } };
  if (s.type === "url" && s.url && /^https:\/\//i.test(s.url)) return { fileData: { fileUri: s.url, mimeType: "image/*" } };
  return null;
}

// A competing-agent identity sentence makes the server-side filter answer a bare
// RESOURCE_EXHAUSTED; the same request without it returns 200.
const COMPETING_AGENT_PATTERNS = [
  /\byou are a claude agent\b[^\n]*/gi,
  /\bbuilt on anthropic's claude agent sdk\b[^\n]*/gi,
  /\byou are claude code\b[^\n]*/gi,
  /\byou are an ai assistant created by anthropic\b[^\n]*/gi,
];
export function scrubIdentity(text) {
  if (!text) return text;
  let out = text;
  for (const re of COMPETING_AGENT_PATTERNS) out = out.replace(re, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
// Cloud Code refuses googleSearch together with functionDeclarations, and the flag it asks
// for does not exist in this API. Grounding is therefore limited to a tool-free call.
export function antigravitySearchEnabled() {
  const flag = process.env.MODELMESH_ANTIGRAVITY_SEARCH;
  if (flag != null) return flag !== "0" && flag !== "false";
  return true;
}

export function anthropicToGemini(body, model, creds) {
  const contents = [];
  const toolNameById = new Map();
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  const rawSystem = body.system ? textOf(body.system) : "";
  // Cloud Code rejects the x-anthropic-billing-header line with a misleading 429, so drop
  // it before the prompt goes upstream.
  const sys = scrubIdentity(rawSystem.split(/\r?\n/).filter((line) => !/^\s*x-anthropic-billing-header\s*:/i.test(line)).join("\n").trim());
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts = [];
    if (typeof m.content === "string") {
      if (m.content) parts.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && b.text) parts.push({ text: b.text });
        else if (b.type === "image") { const p = imagePart(b); if (p) parts.push(p); }
        else if (b.type === "tool_use") {
          toolNameById.set(b.id, b.name);
          const part = { functionCall: { name: b.name, args: b.input || {}, ...(b.id ? { id: b.id } : {}) } };
          // Cloud Code rejects signature-less native tool history; this is the bypass
          // sentinel the official Antigravity path uses.
          part.thoughtSignature = SIGNATURE_CACHE.get(b.id) || "skip_thought_signature_validator";
          parts.push(part);
        } else if (b.type === "tool_result") {
          let result = "";
          if (typeof b.content === "string") result = b.content;
          else if (Array.isArray(b.content)) result = b.content.filter((x) => x && x.type === "text").map((x) => x.text || "").join("\n");
          if (!toolNameById.has(b.tool_use_id)) {
            // Orphan result (truncated history): Gemini/Vertex rejects a
            // functionResponse that has no matching functionCall.
            parts.push({ text: "[tool result" + (b.tool_use_id ? " " + b.tool_use_id : "") + "] " + result });
          } else {
            const name = toolNameById.get(b.tool_use_id);
            parts.push({ functionResponse: { name, response: { result }, ...(b.tool_use_id ? { id: b.tool_use_id } : {}) } });
          }
        }
      }
    }
    push(role, parts);
  }
  while (contents.length && contents[contents.length - 1].role === "model") contents.pop();
  if (!contents.length) contents.push({ role: "user", parts: [{ text: "continue" }] });
  const declarations = Array.isArray(body.tools) && body.tools.length
    ? body.tools.filter((t) => t && t.name).map((t) => ({
        name: t.name,
        description: t.description || "",
        parameters: cleanSchema(t.input_schema || { type: "object", properties: {} }),
      }))
    : [];
  // Cloud Code 400s when googleSearch and functionDeclarations share a request, so
  // grounding is only used for a tool-free call.
  const useGrounding = antigravitySearchEnabled() && !declarations.length;
  const tools = useGrounding ? [{ googleSearch: {} }]
    : declarations.length ? [{ functionDeclarations: declarations }]
    : undefined;
  // Keep only Antigravity's own system prompt upstream and move the client prompt into the
  // first user turn: an oversized systemInstruction is answered with a misleading 429.
  if (sys && contents.length) {
    const first = contents[0];
    first.parts = [{ text: sys }, ...first.parts];
  } else if (sys) {
    contents.push({ role: "user", parts: [{ text: sys }] });
  }
  const cap = outputCap(model);
  const thinkingBudget = thinkingBudgetFor(body);
  const isClaudeModel = /^claude-/.test(String(model || ""));
  let maxOutputTokens = Math.min(Number(body.max_tokens) || 8192, cap);
  if (!isClaudeModel && thinkingBudget > 0 && maxOutputTokens <= thinkingBudget) {
    maxOutputTokens = Math.min(cap, thinkingBudget + 1);
  }
  const generationConfig = {
    maxOutputTokens,
    topK: 40,
    topP: body.top_p != null ? body.top_p : 1.0,
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    // Claude-branded models go through Vertex and reject a thinkingConfig.
    ...(!isClaudeModel && thinkingBudget > 0
      ? { thinkingConfig: { includeThoughts: true, thinkingBudget } }
      : {}),
  };
  const request = {
    contents,
    systemInstruction: { role: "system", parts: [{ text: DEFAULT_SYSTEM }] },
    ...(tools ? { tools } : {}),
    ...(declarations.length ? { toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } } : {}),
    generationConfig,
  };
  const project = (creds && creds.project_id) || "";
  const sessionId = "-" + (crypto.randomBytes(8).readBigUInt64BE() % 9000000000000000000n).toString();
  request.sessionId = sessionId;
  return {
    project,
    model,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: "agent/" + crypto.randomUUID() + "/" + Date.now() + "/" + crypto.randomUUID() + "/2",
    request,
  };
}

function stopReason(fr) {
  const s = String(fr || "").toUpperCase();
  if (s === "MAX_TOKENS") return "max_tokens";
  if (s === "SAFETY" || s === "RECITATION" || s === "BLOCKLIST" || s === "PROHIBITED_CONTENT") return "refusal";
  return "end_turn";
}

function partsFrom(payload) {
  const r = payload.response || payload;
  const cand = r.candidates && r.candidates[0];
  return { payload: r, cand, parts: (cand && cand.content && cand.content.parts) || [] };
}

// Drive an Antigravity request and emit Anthropic events to `sink`. When no sink is given
// the events are written to `res` as SSE, which is what the HTTP handler wants. The OpenAI
// endpoint passes a sink instead, so both surfaces run one implementation.
export async function proxyAntigravity(req, res, route, body, { anthropicError, sink = null } = {}) {
  // With a sink there is no response object; report by throwing so the caller can shape it.
  const fail = (status, type, message) => {
    if (sink) { const e = new Error(message); e.status = status; e.type = type; throw e; }
    return anthropicError(res, status, type, message);
  };
  const creds = loadCredentials();
  if (!creds || !creds.access_token) {
    return fail(401, "authentication_error", "Antigravity is not logged in on this device - run: modelmesh antigravity login");
  }
  let token = creds.access_token;
  try { token = await ensureAccessToken(creds); } catch (e) { return fail(401, "authentication_error", e.message); }
  const envelope = anthropicToGemini(body, upstreamModel(route.model), creds);
  if (process.env.MODELMESH_ANTIGRAVITY_DEBUG === "1") {
    try {
      const dir = cacheDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "antigravity-request.json"), JSON.stringify(envelope, null, 2) + "\n");
      fs.writeFileSync(path.join(dir, "antigravity-body.json"), JSON.stringify(body, null, 2) + "\n");
    } catch (e) { }
  }
  const fp = refusalKey(envelope);
  const blockedUntil = activeRefusal(fp);
  if (blockedUntil) {
    const wait = Math.max(1, Math.round((blockedUntil - Date.now()) / 1000));
    try { res.setHeader("retry-after", String(wait)); } catch (e) { }
    return fail(429, "rate_limit_error",
      "Antigravity refused this exact request moments ago; modelmesh is not resending it (retry in " + wait + "s, or use /model)");
  }
  const sendUpstream = async (accessToken, url) => fetch(url, {
    method: "POST",
    headers: antigravityContentHeaders(accessToken, { accept: "text/event-stream" }),
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  let upstream;
  try { upstream = await sendUpstream(token, GENERATE_URLS[0]); }
  catch (e) { return fail(502, "api_error", "Antigravity request failed: " + e.message); }
  if ((upstream.status === 401 || upstream.status === 403) && creds.refresh_token) {
    try {
      token = await ensureAccessToken(loadCredentials(), { force: true });
      upstream = await sendUpstream(token, GENERATE_URLS[0]);
    } catch (e) { }
  }
  // A 429 can mean real quota or a content-triggered refusal: retry with backoff, fall back
  // to the secondary host, then remember the refusal so retries do not hammer upstream.
  const max429 = Number(process.env.MODELMESH_ANTIGRAVITY_429_RETRIES || 2);
  let last429Text = "";
  let lastDelay = 0;
  // How many distinct hosts returned 429. A refusal is only real when this reaches the end.
  let hostsTried = 0;
  for (const url of GENERATE_URLS) {
    for (let attempt = 0; upstream.status === 429 && attempt < max429; attempt++) {
      last429Text = await upstream.text();
      let delay = [2000, 5000][Math.min(attempt, 1)];
      try {
        const ra = upstream.headers && upstream.headers.get("retry-after");
        if (ra && /^\d+$/.test(ra.trim())) delay = Math.min(15000, Math.max(500, Number(ra) * 1000));
      } catch (e) { }
      try {
        const j = JSON.parse(last429Text);
        const d = (j.error && j.error.details || []).find((x) => x["@type"] && /RetryInfo/.test(x["@type"]));
        if (d && typeof d.retryDelay === "string") { const sec = parseFloat(d.retryDelay); if (sec > 0) delay = Math.min(15000, sec * 1000); }
      } catch (e) { }
      lastDelay = delay;
      console.error(new Date().toISOString(), "antigravity rate-limited; retry", attempt + 1, "in", delay + "ms");
      await new Promise((r) => setTimeout(r, delay));
      try { upstream = await sendUpstream(token, url); } catch (e) { break; }
    }
    if (upstream.status !== 429) break;
    hostsTried += 1;
    try { last429Text = await upstream.text(); } catch (e) { }
    if (GENERATE_URLS.indexOf(url) === 0 && GENERATE_URLS.length > 1) {
      console.error(new Date().toISOString(), "antigravity still 429; trying secondary host");
      try { upstream = await sendUpstream(token, GENERATE_URLS[1]); } catch (e) { break; }
    }
  }
  // Cache a refusal only when the request genuinely could not be served. The secondary host
  // answers 429 for requests the daily host handles fine, and caching on that made the next
  // identical request fail locally without ever trying upstream - which looked exactly like
  // exhausted quota and survived a re-login, because the block lived here.
  const everyHost429 = upstream.status === 429 && hostsTried === GENERATE_URLS.length;
  if (everyHost429) {
    const blockMs = rememberRefusal(fp, lastDelay);
    console.error(new Date().toISOString(), "antigravity refusal cached for", blockMs, "ms (every host answered 429)");
  } else if (upstream.status === 429) {
    console.error(new Date().toISOString(), "antigravity 429 not cached: only " + hostsTried + " of " + GENERATE_URLS.length + " hosts were tried");
  }
  if (!upstream.ok) {
    const text = upstream.status === 429 && last429Text ? last429Text : await upstream.text();
    console.error(new Date().toISOString(), "antigravity upstream", upstream.status, text.slice(0, 500));
    let msg = text.slice(0, 600);
    try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error.status)) || msg; } catch (e) { }
    const type = upstream.status === 401 ? "authentication_error" : upstream.status === 429 ? "rate_limit_error" : "api_error";
    try { if (upstream.status === 429) res.setHeader("retry-after", "10"); } catch (e) { }
    let suffix = "";
    if (upstream.status === 429) {
      // Name what is actually out, so a genuine per-model limit is not confused with a
      // misbehaving host. Nothing exhausted means the limit is transient.
      let detail = "";
      try {
        const { fetchQuotaBuckets, describeExhausted } = await import("../bin/cc-antigravity.mjs");
        const q = await fetchQuotaBuckets({ timeoutMs: 8000 });
        const low = describeExhausted(q.models, 0.01);
        detail = low ? " exhausted: " + low : " (no model is out of quota, so this is a temporary limit)";
      } catch (e) { }
      suffix = " (Antigravity rate-limited" + detail + " - retry shortly or switch model with /model)";
    }
    return fail(upstream.status, type, "Antigravity upstream " + upstream.status + ": " + msg + suffix);
  }
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let started = false, blockIndex = -1, blockKind = null, textOpen = false, stop = "end_turn";
  let usage = { input: 0, output: 0 }, sawContent = false;
  const wantStream = body.stream !== false;
  const collected = { text: "", tools: [] };
  const sse = (event, data) => {
    if (sink) { sink(event, data); return; }
    if (wantStream) res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
  };
  const start = () => {
    if (started) return;
    started = true;
    if (sink) return;
    if (!wantStream) return;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders();
    sse("message_start", { type: "message_start", message: { id: "msg_" + Date.now(), type: "message", role: "assistant", model: route.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  };
  const closeBlock = () => {
    if (blockKind && blockIndex >= 0) sse("content_block_stop", { type: "content_block_stop", index: blockIndex });
    blockKind = null; textOpen = false;
  };
  const handle = (payload) => {
    const { payload: r, cand, parts } = partsFrom(payload);
    if (r && r.error) {
      start();
      const msg = (r.error && (r.error.message || r.error.status)) || JSON.stringify(r.error);
      sse("error", { type: "error", error: { type: "api_error", message: String(msg) } });
      stop = "end_turn";
      return;
    }
    if (r.usageMetadata) {
      usage.input = r.usageMetadata.promptTokenCount || usage.input;
      usage.output = r.usageMetadata.candidatesTokenCount || usage.output;
    }
    if (typeof payload.markdown === "string" && payload.markdown) {
      start();
      if (!textOpen) { closeBlock(); blockIndex++; blockKind = "text"; textOpen = true; sse("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } }); }
      sse("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: payload.markdown } });
      sawContent = true;
    }
    for (const part of parts) {
      if (part.thought) continue;
      if (typeof part.text === "string" && part.text) {
        const m = /^[\s\S]*?\[Tool call:\s*([^\]\n]+)\]\s*\nArguments:\s*([\s\S]+?)\s*$/.exec(part.text);
        if (m) {
          let args = {};
          try { args = JSON.parse(m[2]); } catch (e) { }
          start(); closeBlock();
          blockIndex++; blockKind = "tool";
          const id = "toolu_" + Date.now() + "_" + blockIndex;
          sse("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id, name: m[1].trim(), input: {} } });
          sse("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } });
          collected.tools.push({ id, name: m[1].trim(), input: args });
          sse("content_block_stop", { type: "content_block_stop", index: blockIndex });
          blockKind = null; stop = "tool_use"; sawContent = true;
          continue;
        }
        start();
        if (!textOpen) { closeBlock(); blockIndex++; blockKind = "text"; textOpen = true; sse("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } }); }
        sse("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: part.text } });
        collected.text += part.text;
        sawContent = true;
      }
      if (part.functionCall && part.functionCall.name) {
        start();
        closeBlock();
        blockIndex++; blockKind = "tool";
        const id = part.functionCall.id || "toolu_" + Date.now() + "_" + blockIndex;
        rememberSignature(id, part.thoughtSignature);
        sse("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id, name: part.functionCall.name, input: {} } });
        sse("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(part.functionCall.args || {}) } });
        collected.tools.push({ id, name: part.functionCall.name, input: part.functionCall.args || {} });
        sse("content_block_stop", { type: "content_block_stop", index: blockIndex });
        blockKind = null; stop = "tool_use"; sawContent = true;
      }
    }
    if (cand && cand.finishReason && stop !== "tool_use") stop = stopReason(cand.finishReason);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let j; try { j = JSON.parse(data); } catch (e) { continue; }
        handle(j);
      }
    }
    start();
    closeBlock();
    if (!sawContent && wantStream) {
      sse("error", { type: "error", error: { type: "api_error", message: "Antigravity returned an empty response" } });
      sse("message_stop", { type: "message_stop" });
      return;
    }
    if (!sawContent) {
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      sse("content_block_stop", { type: "content_block_stop", index: 0 });
    }
    if (!wantStream) {
      const content = [];
      if (collected.text) content.push({ type: "text", text: collected.text });
      for (const t of collected.tools) content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
      if (!content.length) content.push({ type: "text", text: "" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_" + Date.now(), type: "message", role: "assistant", model: route.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: usage.output } }));
      return;
    }
    sse("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: usage.input, output_tokens: usage.output } });
    sse("message_stop", { type: "message_stop" });
  } catch (e) {
    try {
      start();
      sse("error", { type: "error", error: { type: "api_error", message: "Antigravity stream failed: " + e.message } });
      sse("message_stop", { type: "message_stop" });
    } catch (e2) { }
  } finally {
    try { res.end(); } catch (e) { try { res.destroy(); } catch (e2) { } }
    refreshStatusLine({ modelId: route.model, provider: route.name }).catch(() => { });
  }
}
