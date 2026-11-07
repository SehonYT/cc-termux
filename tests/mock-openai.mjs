#!/usr/bin/env node
import http from 'node:http';
const log = (...a) => console.error(new Date().toISOString(), ...a);
const TOOL = { id: 'call_test_1', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo hi-from-tool', description: 'test echo' }) } };

function chunk(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const msgs = body.messages || [];
    const toolMsgs = msgs.filter(m => m.role === 'tool');
    log('REQ', req.url, 'model=' + body.model, 'tools=' + (body.tools || []).length, 'stream=' + !!body.stream, 'messages=' + msgs.length, 'toolResults=' + toolMsgs.length);
    if (toolMsgs.length) {
      const got = toolMsgs[toolMsgs.length - 1].content;
      log('TOOL RESULT SEEN:', String(got).slice(0, 200));
      const text = 'FINAL ' + String(got).trim();
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(chunk({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }));
        res.write(chunk({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }));
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }));
      }
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: TOOL.id, type: 'function', function: { name: TOOL.function.name, arguments: TOOL.function.arguments } }] }, finish_reason: null }] }));
      res.write(chunk({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [TOOL] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    }
  });
});
server.listen(8899, '127.0.0.1', () => log('mock openai upstream on 8899'));