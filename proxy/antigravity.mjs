// Google Antigravity (Cloud Code API) adapter for the local gateway.
// Translates Anthropic Messages <-> Gemini generateContent and streams SSE.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureAccessToken, loadCredentials, GENERATE_URL, antigravityHeaders } from "../bin/cc-antigravity.mjs";

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
const SIGNATURE_CACHE = new Map();
function rememberSignature(id, sig) {
  if (!id || typeof sig !== "string" || !sig) return;
  SIGNATURE_CACHE.set(id, sig);
  if (SIGNATURE_CACHE.size > 2000) SIGNATURE_CACHE.delete(SIGNATURE_CACHE.keys().next().value);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
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
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = cleanSchema(pv);
    } else if (k === "items") out.items = cleanSchema(v);
    else if (k === "type") {
      if (Array.isArray(v)) { out.type = String(v[0] || "string").toLowerCase(); if (v.includes("null")) out.nullable = true; }
      else out.type = String(v).toLowerCase();
    } else out[k] = cleanSchema(v);
  }
  return out;
}

function imagePart(block) {
  const s = block.source || {};
  if (s.type === "base64" && s.data) return { inlineData: { mimeType: s.media_type || "image/png", data: s.data } };
  if (s.type === "url" && s.url && /^https:\/\//i.test(s.url)) return { fileData: { fileUri: s.url, mimeType: "image/*" } };
  return null;
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
  const sys = body.system ? textOf(body.system) : "";
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
          const part = { functionCall: { name: b.name, args: b.input || {} } };
          if (SIGNATURE_CACHE.has(b.id)) part.thoughtSignature = SIGNATURE_CACHE.get(b.id);
          parts.push(part);
        } else if (b.type === "tool_result") {
          const name = toolNameById.get(b.tool_use_id) || "tool";
          let result = "";
          if (typeof b.content === "string") result = b.content;
          else if (Array.isArray(b.content)) result = b.content.filter((x) => x && x.type === "text").map((x) => x.text || "").join("\n");
          parts.push({ functionResponse: { name, response: { result } } });
        }
      }
    }
    push(role, parts);
  }
  while (contents.length && contents[contents.length - 1].role === "model") contents.pop();
  if (!contents.length) contents.push({ role: "user", parts: [{ text: "continue" }] });
  const tools = Array.isArray(body.tools) && body.tools.length
    ? [{ functionDeclarations: body.tools.filter((t) => t && t.name).map((t) => ({
        name: t.name,
        description: t.description || "",
        parameters: cleanSchema(t.input_schema || { type: "object", properties: {} }),
      })) }]
    : undefined;
  const request = {
    contents,
    ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
    ...(tools ? { tools, toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } } : {}),
    generationConfig: {
      maxOutputTokens: Math.min(Number(body.max_tokens) || 8192, MAX_OUTPUT),
      ...(body.temperature != null ? { temperature: body.temperature } : {}),
      ...(body.top_p != null ? { topP: body.top_p } : {}),
    },
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

export async function proxyAntigravity(req, res, route, body, { anthropicError }) {
  const creds = loadCredentials();
  if (!creds || !creds.access_token) {
    return anthropicError(res, 401, "authentication_error", "Antigravity is not logged in on this device - run: cc-termux antigravity login");
  }
  let token = creds.access_token;
  try { token = await ensureAccessToken(creds); } catch (e) { return anthropicError(res, 401, "authentication_error", e.message); }
  const envelope = anthropicToGemini(body, upstreamModel(route.model), creds);
  if (process.env.CC_TERMUX_ANTIGRAVITY_DEBUG === "1") {
    try {
      const dir = path.join(os.homedir(), ".cache", "cc-termux");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "antigravity-request.json"), JSON.stringify(envelope, null, 2) + "\n");
    } catch (e) { }
  }
  const sendUpstream = async (accessToken) => fetch(GENERATE_URL, {
    method: "POST",
    headers: antigravityHeaders(accessToken, { accept: "text/event-stream" }),
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  let upstream;
  try { upstream = await sendUpstream(token); }
  catch (e) { return anthropicError(res, 502, "api_error", "Antigravity request failed: " + e.message); }
  if ((upstream.status === 401 || upstream.status === 403) && creds.refresh_token) {
    try {
      token = await ensureAccessToken(loadCredentials(), { force: true });
      upstream = await sendUpstream(token);
    } catch (e) { }
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    console.error(new Date().toISOString(), "antigravity upstream", upstream.status, text.slice(0, 500));
    let msg = text.slice(0, 600);
    try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error.status)) || msg; } catch (e) { }
    const quota = upstream.status === 429 && /RESOURCE_EXHAUSTED|quota|exhausted|rate.?limit/i.test(text);
    const status = quota ? 400 : upstream.status;
    const type = upstream.status === 401 ? "authentication_error" : quota ? "invalid_request_error" : upstream.status === 429 ? "rate_limit_error" : "api_error";
    const suffix = quota ? " (Antigravity quota for this model is exhausted/reset; choose another model with /model)" : "";
    return anthropicError(res, status, type, "Antigravity upstream " + upstream.status + ": " + msg + suffix);
  }
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let started = false, blockIndex = -1, blockKind = null, textOpen = false, stop = "end_turn";
  let usage = { input: 0, output: 0 }, sawContent = false;
  const wantStream = body.stream !== false;
  const collected = { text: "", tools: [] };
  const sse = (event, data) => { if (wantStream) res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"); };
  const start = () => {
    if (started) return;
    started = true;
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
    if (cand && cand.finishReason) stop = stopReason(cand.finishReason);
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
  }
}
