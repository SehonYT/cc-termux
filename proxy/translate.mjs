// Protocol translation between the Anthropic Messages API and the OpenAI-compatible APIs.
// Side-effect free apart from the streaming factories, which call the supplied `send`.


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

// Answer malformed requests with 400 instead of a 500 TypeError from inside a translator.
// Only the shape is checked; model and provider semantics stay pass-through.
function requestShapeError(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'request body must be a JSON object';
  if (body.model != null && typeof body.model !== 'string') return 'model must be a string';
  if (body.messages != null) {
    if (!Array.isArray(body.messages)) return 'messages must be an array';
    for (const m of body.messages) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) return 'each message must be an object';
      if (m.content == null || typeof m.content === 'string') continue;
      if (!Array.isArray(m.content)) return 'message content must be a string or an array of content blocks';
      for (const b of m.content) {
        if (!b || typeof b !== 'object' || Array.isArray(b)) return 'each content block must be an object';
      }
    }
  }
  if (body.system != null && typeof body.system !== 'string') {
    if (!Array.isArray(body.system)) return 'system must be a string or an array of content blocks';
    for (const b of body.system) {
      if (!b || typeof b !== 'object' || Array.isArray(b)) return 'each system block must be an object';
    }
  }
  return null;
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

function createTranslator(model, send, hooks = {}) {
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
        if (j.error) { failed = true; (hooks.log || (() => {}))('upstream stream error', JSON.stringify(j.error).slice(0, 300)); send('error', { type: 'error', error: { type: 'api_error', message: j.error.message || JSON.stringify(j.error) } }); continue; }
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

function createResponsesTranslator(model, send, hooks = {}) {
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
          (hooks.logFailure || (() => {}))('stream', null, model, null, String(msg));
          (hooks.log || (() => {}))('responses error', String(msg).slice(0, 200));
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


// ---------- inbound OpenAI chat, for CLIs that are not Claude Code
// A third-party CLI sends an OpenAI request; the gateway needs an Anthropic-shaped body so
// the existing routing and translators apply unchanged. Tools map one to one.
function fromOpenAIMessages(body) {
  const out = [];
  for (const m of body.messages || []) {
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((c) => (typeof c === 'string' ? c : c && c.text ? c.text : '')).join('')
        : '';
    if (m.role === 'system' || m.role === 'developer') continue;
    if (m.role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id || 'call_0', content: text }] });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const parts = [];
      if (text) parts.push({ type: 'text', text });
      for (const call of m.tool_calls) {
        let input = {};
        try { input = JSON.parse((call.function && call.function.arguments) || '{}'); } catch (e) { input = {}; }
        parts.push({ type: 'tool_use', id: call.id || 'call_0', name: (call.function && call.function.name) || 'tool', input });
      }
      out.push({ role: 'assistant', content: parts });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text });
  }
  return out;
}

function toAnthropicTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const t of tools) {
    const fn = t && (t.function || t);
    if (!fn || !fn.name) continue;
    out.push({ name: fn.name, description: fn.description || '', input_schema: fn.parameters || { type: 'object', properties: {} } });
  }
  return out.length ? out : undefined;
}

// An OpenAI request, as an Anthropic one.
function openAIToAnthropic(body) {
  const system = [];
  for (const m of body.messages || []) {
    if (m.role !== 'system' && m.role !== 'developer') continue;
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((c) => (c && c.text) || '').join('') : '';
    if (text) system.push({ type: 'text', text });
  }
  const out = {
    model: body.model,
    max_tokens: body.max_tokens || body.max_completion_tokens || 4096,
    messages: fromOpenAIMessages(body),
    stream: Boolean(body.stream),
  };
  if (system.length) out.system = system;
  const tools = toAnthropicTools(body.tools);
  if (tools) out.tools = tools;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop) && body.stop.length) out.stop_sequences = body.stop;
  else if (typeof body.stop === 'string') out.stop_sequences = [body.stop];
  if (body.tool_choice && body.tool_choice !== 'auto') {
    if (body.tool_choice === 'required') out.tool_choice = { type: 'any' };
    else if (body.tool_choice === 'none') out.tool_choice = { type: 'none' };
    else if (body.tool_choice.function && body.tool_choice.function.name) out.tool_choice = { type: 'tool', name: body.tool_choice.function.name };
  }
  return out;
}

// An Anthropic message, as an OpenAI completion.
function anthropicToOpenAI(message, model) {
  const content = message.content || [];
  let text = '';
  const calls = [];
  for (const part of content) {
    if (part.type === 'text') text += part.text || '';
    else if (part.type === 'tool_use') {
      calls.push({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input || {}) } });
    }
  }
  const stop = message.stop_reason === 'max_tokens' ? 'length'
    : message.stop_reason === 'tool_use' ? 'tool_calls'
    : message.stop_reason === 'stop_sequence' ? 'stop' : 'stop';
  const msg = { role: 'assistant', content: text || null };
  if (calls.length) msg.tool_calls = calls;
  return {
    id: message.id || 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || message.model || 'modelmesh',
    choices: [{ index: 0, message: msg, finish_reason: stop }],
    usage: {
      prompt_tokens: (message.usage && message.usage.input_tokens) || 0,
      completion_tokens: (message.usage && message.usage.output_tokens) || 0,
      total_tokens: ((message.usage && message.usage.input_tokens) || 0) + ((message.usage && message.usage.output_tokens) || 0),
    },
  };
}
export {
  mapStop,
  flatten,
  stripCache,
  sanitizeBody,
  requestShapeError,
  toOpenAI,
  fromOpenAI,
  createTranslator,
  responsesApi,
  openAIToAnthropic,
  anthropicToOpenAI,
  toResponses,
  fromResponses,
  createResponsesTranslator,
  estimate,
};
