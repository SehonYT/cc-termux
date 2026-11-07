#!/usr/bin/env node
import http from 'node:http';
const log = (...a) => console.error(new Date().toISOString(), ...a);
const ev = (res, t, d) => res.write('event: ' + t + '\ndata: ' + JSON.stringify(d) + '\n\n');
http.createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c);
  req.on('end', () => {
    let b = {}; try { b = JSON.parse(raw || '{}'); } catch {}
    const keys = Object.keys(b);
    const hasCache = raw.includes('cache_control');
    const hasThinking = 'thinking' in b || 'context_management' in b;
    log('REQ', req.url, 'model=' + b.model, 'stream=' + !!b.stream, 'keys=' + keys.join(','), 'cache_control=' + hasCache, 'extra=' + hasThinking, 'auth=' + (req.headers['authorization'] || req.headers['x-api-key'] || 'none'));
    const model = b.model || 'x';
    if (b.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      ev(res, 'message_start', { type: 'message_start', message: { id: 'msg_a', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 1 } } });
      ev(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ANTH-PROXY-OK' } });
      ev(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      ev(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
      ev(res, 'message_stop', { type: 'message_stop' });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_a', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ANTH-PROXY-OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 7, output_tokens: 3 } }));
    }
  });
}).listen(8898, '127.0.0.1', () => log('mock anthropic upstream on 8898'));