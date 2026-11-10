#!/usr/bin/env node
// Local API gateway for Claude Code.
//
// Claude Code speaks the Anthropic Messages API. This process accepts that protocol and
// forwards each request using one of three adapters, selected per provider:
//   - Anthropic Messages passthrough (Anthropic-compatible endpoints)
//   - OpenAI chat completions (translated)
//   - OpenAI Responses API (translated)
//
// It also handles provider routing, retries, request sanitising and the /model provider switch.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { proxyAntigravity } from "./antigravity.mjs";
import { refreshStatusLine } from "../bin/cc-statusline.mjs";

const CONFIG_PATH = process.env.CC_TERMUX_CONFIG || path.join(os.homedir(), '.config', 'cc-termux', 'config.json');
const LOG = (...a) => {
  if (process.env.CC_TERMUX_QUIET) return;
  const line = new Date().toISOString() + " " + a.join(" ");
  console.error(line);
  if (process.env.CC_TERMUX_MANAGED === '1') return; // stderr is already redirected to gateway.log by the launcher
  try {
    const gwLog = path.join(os.homedir(), ".cache", "cc-termux", "gateway.log");
    fs.mkdirSync(path.dirname(gwLog), { recursive: true, mode: 0o700 });
    fs.appendFileSync(gwLog, line + "\n");
    fs.chmodSync(gwLog, 0o600);
    if (fs.statSync(gwLog).size > 5 * 1024 * 1024) {
      const tail = fs.readFileSync(gwLog, "utf8").trim().split("\n").slice(-500).join("\n");
      fs.writeFileSync(gwLog, tail + "\n");
    }
  } catch (e) { }
};

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
let CONFIG = loadConfig();
for (const [n, p] of Object.entries(CONFIG.providers || {})) p.name = p.name || n;
const CONFIG_DIR = path.dirname(CONFIG_PATH);
const CACHE_DIR = path.join(os.homedir(), '.cache', 'cc-termux');
const KEYS_PATH = path.join(CONFIG_DIR, 'keys.json');
const GATEWAY_TOKEN = process.env.CC_TERMUX_GATEWAY_TOKEN || (CONFIG.gatewayToken || 'cc-termux-local');
const QUOTA_PATH = path.join(CACHE_DIR, 'quota.json');
const ERRORS_PATH = path.join(CACHE_DIR, 'errors.log');
function redact(text) {
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{6,}|tok_[A-Za-z0-9]{6,}|AQ\.[A-Za-z0-9_-]{8,})/g, '***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1***')
    .replace(/("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1***');
}
function logFailure(kind, provider, model, status, message) {
  const rec = {
    at: new Date().toISOString(), kind,
    provider: provider || null, model: model || null,
    status: status == null ? null : status,
    message: redact(String(message || '')).replace(/\s+/g, ' ').slice(0, 400),
  };
  try { fs.mkdirSync(path.dirname(ERRORS_PATH), { recursive: true, mode: 0o700 }); fs.appendFileSync(ERRORS_PATH, JSON.stringify(rec) + '\n'); fs.chmodSync(ERRORS_PATH, 0o600); } catch (e) { }
  LOG('failure', kind, provider || '-', model || '-', status == null ? '' : status, rec.message.slice(0, 180));
}
function recordQuota(providerName, model, status, text) {
  try {
    let q = {}; try { q = JSON.parse(fs.readFileSync(QUOTA_PATH, 'utf8')); } catch (e) { q = {}; }
    const limitMatch = String(text).match(/limit:\s*(\d+)/i);
    const quotaId = (String(text).match(/quotaId["\s:]+([A-Za-z0-9_.-]+)/) || [])[1] || null;
    const metric = (String(text).match(/metric:\s*([A-Za-z0-9_.-]+)/) || [])[1] || null;
    q[providerName || 'unknown'] = {
      at: new Date().toISOString(), status, model: model || null,
      limit: limitMatch ? Number(limitMatch[1]) : null,
      quotaId, metric,
      message: String(text).replace(/\s+/g, ' ').slice(0, 300),
    };
    fs.mkdirSync(path.dirname(QUOTA_PATH), { recursive: true });
    fs.writeFileSync(QUOTA_PATH, JSON.stringify(q, null, 2) + '\n');
  } catch (e) { }
}
function loadKeys() { try { return JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')); } catch { return {}; } }
function saveConfig() {
  const tmp = CONFIG_PATH + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(CONFIG, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (e) { }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

// Retries transient upstream failures (429 quota/rate limit, 5xx, network) with
// exponential backoff + jitter, honoring Retry-After. Per-provider overrides:
//   "retries": 5, "retryBaseMs": 800
async function fetchWithRetry(url, opts, provider, label) {
  opts = { ...opts, signal: opts.signal || AbortSignal.timeout(900000) };
  const attempts = Math.max(1, Number(provider.retries || 5));
  const baseMs = Math.max(100, Number(provider.retryBaseMs || 800));
  const maxMs = Math.max(baseMs, Number(provider.retryMaxMs || 20000));
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, opts);
      if (!RETRYABLE.has(res.status) || i === attempts - 1) return res;
      if (res.status === 429) {
        try { recordQuota(provider.name, label, res.status, await res.clone().text()); } catch (e) { }
        // Google free-tier daily quota: retrying cannot help, fail fast with the real message.
        let bodyText = '';
        try { bodyText = await res.clone().text(); } catch (e) { }
        if (/free_tier|quota exceeded|billing|rate-limits/i.test(bodyText)) {
          LOG('quota exhausted, not retrying', label);
          return res;
        }
      }
      const ra = parseFloat(res.headers.get('retry-after') || '0');
      const wait = ra > 0 ? Math.min(ra * 1000, maxMs) : Math.min(maxMs, baseMs * 2 ** i) * (0.7 + Math.random() * 0.6);
      LOG('retry', label, res.status, 'attempt', i + 1 + '/' + attempts, 'in', Math.round(wait) + 'ms');
      try { await res.body?.cancel(); } catch (e) { }
      await sleep(wait);
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) throw e;
      const wait = Math.min(maxMs, baseMs * 2 ** i) * (0.7 + Math.random() * 0.6);
      LOG('retry', label, (e.name || e.code || 'error'), 'attempt', i + 1 + '/' + attempts, 'in', Math.round(wait) + 'ms');
      if (lastErr && lastErr.name === 'AbortError') throw lastErr;
      await sleep(wait);
    }
  }
  throw lastErr;
}
function providerKey(p) {
  const KEYS = loadKeys();
  const byName = p.name && KEYS[p.name];
  if (byName) return byName;
  let k = p.apiKey || '';
  if (k.startsWith('env:')) k = process.env[k.slice(4)] || '';
  if (!k && p.apiKeyEnv) k = process.env[p.apiKeyEnv] || '';
  return k;
}

function catalogIds() {
  try {
    const f = path.join(os.homedir(), '.cache', 'cc-termux', 'catalog.json');
    const cat = JSON.parse(fs.readFileSync(f, 'utf8'));
    return new Set((cat.models || []).map(m => m.id));
  } catch { return new Set(); }
}

function resolveProviderRef(ref, fallbackModel) {
  const s = String(ref);
  const i = s.indexOf('::');
  const name = i >= 0 ? s.slice(0, i) : s.slice(0, s.indexOf(':'));
  const m = i >= 0 ? s.slice(i + 2) : s.slice(s.indexOf(':') + 1);
  const p = CONFIG.providers[name];
  return p ? { name, provider: p, model: m || fallbackModel } : null;
}

function validOverride() {
  const o = CONFIG.override;
  if (!o || !o.provider) return null;
  const p = CONFIG.providers[o.provider];
  if (!p) return null;
  const model = o.model || p.model || null;
  if (model && p.modelsById && Object.keys(p.modelsById).length && !p.modelsById[model] && model !== p.model) {
    LOG('override model not in provider catalog, falling back to', p.model);
    return { provider: o.provider, model: p.model || null };
  }
  return { provider: o.provider, model };
}

function pickRoute(model) {
  // 0) an explicit prov/<provider>/<model> id always routes to that provider
  const prov = /^prov\/([^/]+)\/(.+)$/.exec(String(model));
  if (prov && CONFIG.providers[prov[1]]) {
    return { name: prov[1], provider: CONFIG.providers[prov[1]], model: prov[2] };
  }
  // 1) an explicit override (set by /provider or a provswitch row) wins for any model
  //    that does not belong to the override provider itself.
  const ov = validOverride();
  if (ov && ov.provider) {
    const p = CONFIG.providers[ov.provider];
    if (p) {
      const mm = /^prov\/([^/]+)\//.exec(String(model));
      if (!mm || mm[1] !== ov.provider) {
        return { name: ov.provider, provider: p, model: ov.model || p.model || model };
      }
    }
  }
  // 2) a model id from the /model picker list routes to its own provider
  const routing = CONFIG.routing || {};
  if (routing[model]) {
    const hit = resolveProviderRef(routing[model], model);
    if (hit) return hit;
  }
  const name = CONFIG.active;
  const p = CONFIG.providers[name];
  if (!p) throw new Error('no active provider in config');
  // 3) a raw provider model id for the active provider passes through untouched
  if (p.modelsById && p.modelsById[model]) return { name, provider: p, model };
  if (catalogIds().has(model)) return { name, provider: p, model };
  const mapped = (p.models && p.models[model]) || p.model || p.defaultModel || model;
  return { name, provider: p, model: mapped };
}
const mapStop = (fr, hasTools) =>
  fr === 'length' ? 'max_tokens' : fr === 'tool_calls' ? 'tool_use' : fr === 'content_filter' ? 'end_turn' : hasTools ? 'tool_use' : 'end_turn';

function flatten(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content.map(b => b.type === 'text' ? b.text : b.type === 'image' ? '[image omitted]' : JSON.stringify(b)).join('\n');
}

const KEEP = new Set(['model','messages','system','tools','tool_choice','max_tokens','temperature','top_p','top_k','stop_sequences','stream','metadata']);
function stripCache(o) {
  if (Array.isArray(o)) return o.map(stripCache);
  if (o && typeof o === 'object') {
    const r = {};
    for (const [k, v] of Object.entries(o)) { if (k === 'cache_control') continue; r[k] = stripCache(v); }
    return r;
  }
  return o;
}
// Third-party gateways reject Anthropic-only fields (thinking, betas, cache_control, context_management).
function sanitizeBody(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) { if (KEEP.has(k)) out[k] = stripCache(v); }
  return out;
}

function toOpenAI(body, upstreamModel) {
  const messages = [];
  const sys = typeof body.system === 'string' ? body.system
    : Array.isArray(body.system) ? body.system.map(b => b.text || '').join('\n') : '';
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of body.messages || []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []);
    if (m.role === 'assistant') {
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
      const calls = blocks.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (text || calls.length) {
        const msg = { role: 'assistant', content: text || null };
        if (calls.length) msg.tool_calls = calls;
        messages.push(msg);
      }
    } else {
      const parts = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: flatten(b.content) });
        } else if (b.type === 'text') {
          parts.push({ type: 'text', text: b.text });
        } else if (b.type === 'image' && b.source) {
          const url = b.source.type === 'base64'
            ? `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` : b.source.url;
          if (url) parts.push({ type: 'image_url', image_url: { url } });
        }
      }
      if (parts.length) {
        messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
      }
    }
  }
  const req = { model: upstreamModel, messages, stream: !!body.stream };
  if (body.max_tokens != null) req.max_tokens = body.max_tokens;
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) req.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    req.tools = body.tools.filter(t => t && t.name && t.input_schema).map(t => ({ type: 'function', function: {
      name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
  }
  const tc = body.tool_choice;
  if (tc) {
    if (tc.type === 'auto') req.tool_choice = 'auto';
    else if (tc.type === 'any') req.tool_choice = 'required';
    else if (tc.type === 'none') req.tool_choice = 'none';
    else if (tc.type === 'tool') req.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  if (body.stream) req.stream_options = { include_usage: true };
  // OpenAI reasoning models reject function tools unless reasoning_effort is 'none'
  // (tokens.bd error: "Function tools with reasoning_effort are not supported ...").
  if (req.tools && req.tools.length && String(upstreamModel).startsWith('openai/')) req.reasoning_effort = 'none';
  return req;
}

function fromOpenAI(resp, model) {
  if (resp && resp.error) throw new Error('upstream error: ' + (resp.error.message || JSON.stringify(resp.error)));
  const choice = (resp.choices && resp.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  for (const t of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(t.function.arguments || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: t.id, name: t.function.name, input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: resp.id || 'msg_' + Date.now(), type: 'message', role: 'assistant', model,
    content,
    stop_reason: mapStop(choice.finish_reason, (msg.tool_calls || []).length > 0),
    stop_sequence: null,
    usage: { input_tokens: (resp.usage && resp.usage.prompt_tokens) || 0, output_tokens: (resp.usage && resp.usage.completion_tokens) || 0 },
  };
}

function createTranslator(model, send) {
  let started = false, idx = -1, cur = null, curKind = null;
  const tools = new Map();
  let stopReason = 'end_turn';
  let failed = false;
  const usage = { input: 0, output: 0 };
  let buf = '';
  const startMsg = () => {
    if (started) return;
    started = true;
    send('message_start', { type: 'message_start', message: {
      id: 'msg_' + Date.now(), type: 'message', role: 'assistant', model, content: [], stop_reason: null,
      stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 0 } } });
  };
  const closeBlock = () => {
    if (cur != null) { send('content_block_stop', { type: 'content_block_stop', index: cur }); cur = null; curKind = null; }
  };
  return {
    onData(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.error) { failed = true; LOG('upstream stream error', JSON.stringify(j.error).slice(0, 300)); send('error', { type: 'error', error: { type: 'api_error', message: j.error.message || JSON.stringify(j.error) } }); continue; }
        if (j.usage) {
          if (j.usage.prompt_tokens) usage.input = j.usage.prompt_tokens;
          if (j.usage.completion_tokens) usage.output = j.usage.completion_tokens;
        }
        startMsg();
        const ch = (j.choices && j.choices[0]) || null;
        if (!ch) continue;
        const d = ch.delta || {};
        if (typeof d.content === 'string' && d.content) {
          if (cur == null || curKind !== 'text') {
            closeBlock(); idx++; cur = idx; curKind = 'text';
            send('content_block_start', { type: 'content_block_start', index: cur, content_block: { type: 'text', text: '' } });
          }
          send('content_block_delta', { type: 'content_block_delta', index: cur, delta: { type: 'text_delta', text: d.content } });
        }
        for (const tc of d.tool_calls || []) {
          const k = tc.index ?? 0;
          let st = tools.get(k);
          if (!st) {
            closeBlock(); idx++; cur = idx; curKind = 'tool';
            st = { idx: cur }; tools.set(k, st);
            send('content_block_start', { type: 'content_block_start', index: cur, content_block: {
              type: 'tool_use', id: tc.id || ('toolu_' + Date.now() + '_' + k), name: (tc.function && tc.function.name) || 'tool', input: {} } });
          }
          if (tc.function && tc.function.arguments) {
            send('content_block_delta', { type: 'content_block_delta', index: st.idx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
          }
        }
        if (ch.finish_reason) stopReason = mapStop(ch.finish_reason, tools.size > 0);
      }
    },
    onEnd() {
      if (failed) return;
      startMsg();
      closeBlock();
      send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: usage.input, output_tokens: usage.output } });
      send('message_stop', { type: 'message_stop' });
    },
  };
}

function sseSend(res) {
  return (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}

function abortOnClose(req, res) {
  const ac = new AbortController();
  const onClose = () => { if (!res.writableEnded) { try { ac.abort(); } catch (e) { } } };
  res.once('close', onClose);
  if (req) req.once('aborted', onClose);
  return { signal: ac.signal, cleanup: () => { try { res.removeListener('close', onClose); if (req) req.removeListener('aborted', onClose); } catch (e) { } } };
}

function anthropicError(res, status, type, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

async function proxyAnthropic(res, route, body, req) {
  const p = route.provider;
  const url = p.baseUrl.replace(/\/$/, '') + (p.path || '/v1/messages');
  const key = providerKey(p);
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', accept: 'application/json' };
  if (key) { headers['authorization'] = 'Bearer ' + key; headers['x-api-key'] = key; }
  if (req && req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
  if (req && req.headers['anthropic-version']) headers['anthropic-version'] = req.headers['anthropic-version'];
  const abort = abortOnClose(req, res);
  let upstream;
  try { upstream = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify({ ...sanitizeBody(body), model: route.model }), signal: abort.signal }, p, 'anthropic ' + route.model); }
  catch (e) { abort.cleanup(); throw e; }
  if (body.stream && upstream.ok) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders();
    const reader = upstream.body.getReader();
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
    } catch (e) {
      logFailure('stream', route.name, route.model, null, e.message);
      try { res.write('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"upstream stream failed"}}\n\n'); } catch (e2) { }
    } finally {
      try { res.end(); } catch (e3) { try { res.destroy(); } catch (e4) { } }
    }
    return;
  }
  const text = await upstream.text();
  if (!upstream.ok) logFailure('upstream', route.name, route.model, upstream.status, text);
  if (upstream.status === 429 || upstream.status === 503) recordQuota(route.name, route.model, upstream.status, text);
  abort.cleanup();
  res.writeHead(upstream.status, { 'content-type': 'application/json' });
  res.end(text);
}

async function proxyOpenAI(res, route, body) {
  const p = route.provider;
  const url = p.baseUrl.replace(/\/$/, '') + (p.path || '/chat/completions');
  const key = providerKey(p);
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (key) headers['authorization'] = 'Bearer ' + key;
  const payload = toOpenAI(body, route.model);
  const started = Date.now();
  const abort = abortOnClose(null, res);
  let upstream = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: abort.signal }, p, 'openai ' + route.model);
  let upstreamErrorText = null;
  if (!upstream.ok) {
    let t = await upstream.text();
    upstreamErrorText = t;
    if (upstream.status === 400 && /max_tokens|max_completion_tokens|stream_options|reasoning_effort/i.test(t)) {
      const fixed = { ...payload };
      if (fixed.max_tokens != null) { fixed.max_completion_tokens = fixed.max_tokens; delete fixed.max_tokens; }
      delete fixed.stream_options;
      delete fixed.reasoning_effort;
      const retry = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(fixed), signal: abort.signal }, p, 'openai retry ' + route.model);
      if (retry.ok) upstream = retry;
      else t = await retry.text();
    }
  }
  if (!upstream.ok) {
    const t = upstreamErrorText || '';
    logFailure('upstream', route.name, route.model, upstream.status, t);
    if (upstream.status === 429 || upstream.status === 503) recordQuota(route.name, route.model, upstream.status, t);
    LOG('upstream error', upstream.status, t.slice(0, 400));
    // Pass the real status through: a 403 (key cap / permission) must not look like a
    // retryable 5xx, otherwise Claude Code retries it ten times.
    const type = upstream.status === 401 ? 'authentication_error' : upstream.status === 403 ? 'permission_error' : upstream.status === 429 ? 'rate_limit_error' : 'api_error';
    return anthropicError(res, upstream.status, type, 'upstream ' + upstream.status + ': ' + t.slice(0, 600));
  }
  if (!body.stream) {
    const j = await upstream.json();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fromOpenAI(j, route.model)));
    LOG('non-stream ok', route.name, route.model, Date.now() - started + 'ms');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = sseSend(res);
  const tr = createTranslator(route.model, send);
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tr.onData(dec.decode(value, { stream: true }));
    }
    tr.onEnd();
  } catch (e) {
    logFailure('stream', route.name, route.model, null, e.message);
    send('error', { type: 'error', error: { type: 'api_error', message: String(e.message) } });
  }
  res.end();
  LOG('stream done', route.name, route.model, Date.now() - started + 'ms');
}

// ---------- OpenAI Responses API (/v1/responses) ----------
function responsesApi(p, model) {
  if (p.api) return p.api;
  if (p.apiByModel && p.apiByModel[model]) return p.apiByModel[model];
  if (p.apiMode === 'auto' && /^openai\//.test(model)) return 'responses';
  return 'chat';
}

function toResponses(body, upstreamModel) {
  const input = [];
  const sys = typeof body.system === 'string' ? body.system
    : Array.isArray(body.system) ? body.system.map(b => b.text || '').join('\n') : '';
  for (const m of body.messages || []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []);
    if (m.role === 'assistant') {
      for (const b of blocks) {
        if (b.type === 'text' && b.text) input.push({ role: 'assistant', content: [{ type: 'output_text', text: b.text }] });
        else if (b.type === 'tool_use') input.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
    } else {
      for (const b of blocks) {
        if (b.type === 'tool_result') input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: flatten(b.content) });
      }
      const parts = blocks.filter(b => b.type === 'text').map(b => ({ type: 'input_text', text: b.text }));
      if (parts.length) input.push({ role: 'user', content: parts });
    }
  }
  const req = { model: upstreamModel, input, stream: !!body.stream };
  if (sys) req.instructions = sys;
  if (body.max_tokens != null) req.max_output_tokens = body.max_tokens;
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (Array.isArray(body.tools) && body.tools.length) {
    req.tools = body.tools.filter(t => t && t.name && t.input_schema).map(t => ({
      type: 'function', name: t.name, description: t.description || '', parameters: t.input_schema }));
  }
  const tc = body.tool_choice;
  if (tc) {
    if (tc.type === 'auto') req.tool_choice = 'auto';
    else if (tc.type === 'any') req.tool_choice = 'required';
    else if (tc.type === 'none') req.tool_choice = 'none';
    else if (tc.type === 'tool') req.tool_choice = { type: 'function', name: tc.name };
  }
  return req;
}

function fromResponses(resp, model) {
  if (resp && resp.error) throw new Error('upstream error: ' + (resp.error.message || JSON.stringify(resp.error)));
  const content = [];
  for (const item of resp.output || []) {
    if (item.type === 'message') {
      for (const c of item.content || []) if (c.type === 'output_text' && c.text) content.push({ type: 'text', text: c.text });
    } else if (item.type === 'function_call') {
      let input = {}; try { input = JSON.parse(item.arguments || '{}'); } catch { input = {}; }
      content.push({ type: 'tool_use', id: item.call_id || item.id, name: item.name, input });
    }
  }
  if (!content.length && resp.output_text) content.push({ type: 'text', text: resp.output_text });
  if (!content.length) content.push({ type: 'text', text: '' });
  return { id: resp.id || 'msg_' + Date.now(), type: 'message', role: 'assistant', model, content,
    stop_reason: content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: (resp.usage && resp.usage.input_tokens) || 0, output_tokens: (resp.usage && resp.usage.output_tokens) || 0 } };
}

function createResponsesTranslator(model, send) {
  let started = false, idx = -1, cur = null, curKind = null, failed = false, done = false;
  let stopReason = 'end_turn';
  const usage = { input: 0, output: 0 };
  const toolBlocks = new Map();
  let buf = '';
  const startMsg = () => {
    if (started) return;
    started = true;
    send('message_start', { type: 'message_start', message: { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  };
  const closeBlock = () => { if (cur != null) { send('content_block_stop', { type: 'content_block_stop', index: cur }); cur = null; curKind = null; } };
  const openText = () => {
    if (cur != null && curKind === 'text') return;
    closeBlock(); idx++; cur = idx; curKind = 'text';
    send('content_block_start', { type: 'content_block_start', index: cur, content_block: { type: 'text', text: '' } });
  };
  const finish = () => {
    if (done) return; done = true;
    startMsg(); closeBlock();
    send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output } });
    send('message_stop', { type: 'message_stop' });
  };
  return {
    onData(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        const t = j.type || '';
        if (t === 'error' || t === 'response.failed') {
          failed = true;
          const msg = (j.error && (j.error.message || j.error.code)) || (j.response && j.response.error && j.response.error.message) || 'upstream error';
          logFailure('stream', null, model, null, String(msg));
          LOG('responses error', String(msg).slice(0, 200));
          send('error', { type: 'error', error: { type: 'api_error', message: String(msg) } });
          continue;
        }
        if (t === 'response.output_text.delta') {
          startMsg(); openText();
          send('content_block_delta', { type: 'content_block_delta', index: cur, delta: { type: 'text_delta', text: j.delta || '' } });
          continue;
        }
        if (t === 'response.output_item.added' && j.item && j.item.type === 'function_call') {
          startMsg(); closeBlock(); idx++; cur = idx; curKind = 'tool';
          toolBlocks.set(j.item.id || j.item.call_id, cur);
          send('content_block_start', { type: 'content_block_start', index: cur, content_block: {
            type: 'tool_use', id: j.item.call_id || j.item.id, name: j.item.name, input: {} } });
          continue;
        }
        if (t === 'response.function_call_arguments.delta') {
          const blockIdx = toolBlocks.get(j.item_id);
          if (blockIdx != null && j.delta) send('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: j.delta } });
          continue;
        }
        if (t === 'response.completed' || t === 'response.done') {
          const r = j.response || {};
          if (r.usage) { usage.input = r.usage.input_tokens || usage.input; usage.output = r.usage.output_tokens || usage.output; }
          if ((r.output || []).some(o => o.type === 'function_call')) stopReason = 'tool_use';
          finish();
          continue;
        }
      }
    },
    onEnd() { if (!failed) finish(); },
  };
}

async function proxyResponses(res, route, body) {
  const p = route.provider;
  const url = p.baseUrl.replace(/\/$/, '') + (p.pathResponses || '/v1/responses');
  const key = providerKey(p);
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (key) headers['authorization'] = 'Bearer ' + key;
  LOG('API responses', route.name, route.model);
  const abort = abortOnClose(null, res);
  const upstream = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(toResponses(body, route.model)), signal: abort.signal }, p, 'responses ' + route.model);
  if (!upstream.ok) {
    const t = await upstream.text();
    logFailure('upstream', route.name, route.model, upstream.status, t);
    if (upstream.status === 429 || upstream.status === 503) recordQuota(route.name, route.model, upstream.status, t);
    LOG('responses upstream error', upstream.status, t.slice(0, 300));
    // endpoint unsupported -> fall back to chat/completions
    if (upstream.status === 404 || /unsupported|not supported|unknown endpoint|not found/i.test(t)) {
      LOG('falling back to chat/completions');
      return proxyOpenAI(res, route, body);
    }
    const type = upstream.status === 401 ? 'authentication_error' : upstream.status === 403 ? 'permission_error' : upstream.status === 429 ? 'rate_limit_error' : 'api_error';
    return anthropicError(res, upstream.status, type, 'upstream ' + upstream.status + ': ' + t.slice(0, 600));
  }
  if (!body.stream) {
    const j = await upstream.json();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(fromResponses(j, route.model)));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const tr = createResponsesTranslator(route.model, sseSend(res));
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; tr.onData(dec.decode(value, { stream: true })); }
    tr.onEnd();
  } catch (e) {
    logFailure('stream', route.name, route.model, null, e.message);
    LOG('responses stream error', e.message);
    try { res.write('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"upstream stream failed"}}\n\n'); res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n'); } catch (e2) { }
  } finally {
    try { res.end(); } catch (e3) { try { res.destroy(); } catch (e4) { } }
  }
}
function estimate(value) {
  if (value == null) return 0;
  if (typeof value === "string") return Math.ceil(value.length / 4);
  if (Array.isArray(value)) return value.reduce((n, v) => n + estimate(v), 0);
  if (typeof value === "object") {
    if (value.type === "image" || value.type === "image_url" || (value.source && value.source.type === "base64")) return 85;
    return Object.entries(value).reduce((n, [k, v]) => (k === "data" && typeof v === "string" ? n + 85 : n + estimate(v)), 0);
  }
  return 1;
}

const server = http.createServer(async (req, res) => {
  try {
    try { CONFIG = loadConfig(); for (const [n, p] of Object.entries(CONFIG.providers || {})) p.name = p.name || n; } catch {}
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname !== '/health') {
      const auth = String(req.headers.authorization || '');
      const keyHdr = String(req.headers['x-api-key'] || '');
      if (auth !== 'Bearer ' + GATEWAY_TOKEN && keyHdr !== GATEWAY_TOKEN) {
        return anthropicError(res, 401, 'authentication_error', 'missing or invalid gateway token');
      }
    }
    if (req.method === 'POST') {
      const ct = String(req.headers['content-type'] || '');
      if (!ct.includes('application/json')) {
        res.writeHead(415, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'content-type must be application/json' } }));
      }
    }
    if (req.method === 'GET') LOG('GET', u.pathname);
    if (u.pathname === '/v1/models' && req.method === 'GET') {
      LOG('GET /v1/models discovery');
      const models = [];
      for (const [name, p] of Object.entries(CONFIG.providers || {})) {
        if (p.hidden) continue;
        for (const [id, info] of Object.entries(p.modelsById || {})) {
          models.push({ type: 'model', id: 'prov/' + name + '/' + id, display_name: (info.name || id) + ' (' + name + ')', created_at: new Date().toISOString() });
        }
      }
      const body = { data: models, has_more: false, first_id: models[0] && models[0].id, last_id: models.length ? models[models.length - 1].id : null };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(body));
    }
    if (u.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      const act = CONFIG.providers[CONFIG.active] || {};
      return res.end(JSON.stringify({ ok: true, active: CONFIG.active, model: act.model || null, override: CONFIG.override || null, providers: Object.keys(CONFIG.providers) }));
    }
    if (req.method !== 'POST') { res.writeHead(404); return res.end('{}'); }
    const chunks = [];
    let total = 0;
    for await (const c of req) {
      total += c.length;
      if (total > 10 * 1024 * 1024) { res.writeHead(413); return res.end('{}'); }
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try { body = JSON.parse(raw || '{}'); }
    catch (e) { return anthropicError(res, 400, 'invalid_request_error', 'invalid JSON body'); }
    if (u.pathname === '/v1/messages/count_tokens') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: estimate(body.messages) + estimate(body.system) + estimate(body.tools) }));
    }
    if (u.pathname === '/v1/messages') {
      const hasProviders = Object.keys(CONFIG.providers || {}).some((n) => !CONFIG.providers[n].hidden);
      if (!CONFIG.active || !hasProviders) return anthropicError(res, 400, 'invalid_request_error', 'no provider configured on this machine - run: cc-termux setup');
      let model = body.model || '';
      if (model.startsWith('provswitch/')) {
        const name = model.slice('provswitch/'.length);
        const target = CONFIG.providers[name];
        if (target) {
          CONFIG.active = name;
          CONFIG.override = { provider: name, model: target.model || null };
          try { saveConfig(); } catch (e) { LOG('saveConfig failed', e.message); }
          LOG('provider switch via /model ->', name);
          refreshStatusLine().catch(() => { });
          model = target.model || model;
          body.model = model;
        }
      }
      let route;
      try { route = pickRoute(model); } catch (e) { return anthropicError(res, 400, 'invalid_request_error', e.message); }
      LOG('REQ', route.name, '->', route.model, 'stream=' + !!body.stream, 'tools=' + (body.tools || []).length);
      // Keep the status line in sync with the model Claude Code selected, for every provider
      // (Antigravity refreshes itself after the request to also pick up quota).
      if (route.provider.type !== 'antigravity') refreshStatusLine().catch(() => { });
      if (route.provider.type === 'antigravity') return await proxyAntigravity(req, res, route, body, { anthropicError });
      if (route.provider.type === 'anthropic') return await proxyAnthropic(res, route, body, req);
      if (responsesApi(route.provider, route.model) === 'responses') return await proxyResponses(res, route, body);
      return await proxyOpenAI(res, route, body);
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'unknown path ' + u.pathname } }));
  } catch (e) {
    logFailure('gateway', null, null, null, e.stack || e.message);
    LOG('fatal', e.stack || e.message);
    try { anthropicError(res, 500, 'api_error', String(e.message)); } catch {}
  }
});

const port = (CONFIG.listen && CONFIG.listen.port) || 8788;
if (process.env.CC_TERMUX_MANAGED === '1') {
  const SESS = path.join(os.homedir(), '.cache', 'cc-termux', 'sessions');
  let idle = 0;
  setInterval(() => {
    let alive = 0;
    try {
      for (const f of fs.readdirSync(SESS)) {
        if (!f.endsWith('.session')) continue;
        try { process.kill(Number(fs.readFileSync(path.join(SESS, f), 'utf8').trim()), 0); alive++; }
        catch (e) { try { fs.unlinkSync(path.join(SESS, f)); } catch (e2) { } }
      }
    } catch (e) { }
    idle = alive === 0 ? idle + 1 : 0;
    if (idle >= 2) { LOG('no sessions left, shutting down'); process.exit(0); }
  }, 5000).unref();
}

let listenHost = (CONFIG.listen && CONFIG.listen.host) || '127.0.0.1';
if (!/^(127\.0\.0\.1|::1|localhost)$/.test(listenHost) && process.env.CC_TERMUX_ALLOW_REMOTE !== '1') {
  LOG('refusing non-loopback listen host ' + listenHost + ' (set CC_TERMUX_ALLOW_REMOTE=1 to override)');
  listenHost = '127.0.0.1';
}
server.on('error', (e) => { LOG('gateway server error', e.code || e.message); process.exit(1); });
server.listen(port, listenHost, () => {
  LOG('gateway listening on', port, 'active=' + CONFIG.active, 'config=' + CONFIG_PATH);
});