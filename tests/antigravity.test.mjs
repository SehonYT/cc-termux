import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-antigravity-"));
const cfgDir = path.join(tmp, "config");
fs.mkdirSync(cfgDir, { recursive: true });

let server;
let port;
let lastEnvelope = null;
let generateMode = 'ok';

test.before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = () => { try { return JSON.parse(body || "{}"); } catch (e) { return {}; } };
      if (u.pathname === "/token") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 }));
      }
      if (u.pathname === "/userinfo") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ email: "user@example.com" }));
      }
      if (u.pathname === "/v1internal:loadCodeAssist") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ cloudaicompanionProject: "project-123", currentTier: { id: "free-tier" } }));
      }
      if (u.pathname === "/v1internal:onboardUser") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ done: true }));
      }
      if (u.pathname === "/generate") {
        lastEnvelope = json();
        if (generateMode === "quota") {
          res.writeHead(429, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } }));
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: " + JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "hello " }, { text: "world" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 } } }) + "\n\n");
        return res.end();
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  process.env.CC_TERMUX_CONFIG = path.join(cfgDir, "config.json");
  process.env.CC_TERMUX_ANTIGRAVITY_TOKEN_URL = "http://127.0.0.1:" + port + "/token";
  process.env.CC_TERMUX_ANTIGRAVITY_USERINFO_URL = "http://127.0.0.1:" + port + "/userinfo";
  process.env.CC_TERMUX_ANTIGRAVITY_BOOTSTRAP_URL = "http://127.0.0.1:" + port;
  process.env.CC_TERMUX_ANTIGRAVITY_GENERATE_URL = "http://127.0.0.1:" + port + "/generate";
});

test.after(() => {
  try { server.close(); } catch (e) { }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("OAuth URL, token exchange, project discovery", async () => {
  const ant = await import("../bin/cc-antigravity.mjs?t=" + Date.now());
  const url = ant.buildAuthUrl("http://localhost:1234/callback", "state123");
  assert.match(url, /client_id=/);
  assert.match(url, /redirect_uri=http%3A%2F%2Flocalhost%3A1234%2Fcallback/);
  assert.match(url, /access_type=offline/);
  const tokens = await ant.exchangeCode("code", "http://localhost:1234/callback");
  assert.equal(tokens.access_token, "access-new");
  const project = await ant.discoverProject(tokens.access_token);
  assert.equal(project.projectId, "project-123");
  assert.equal(project.tierId, "free-tier");
  const refreshed = await ant.refreshToken("refresh-old");
  assert.equal(refreshed.access_token, "access-new");
  ant.saveCredentials({ access_token: "access-new", refresh_token: "refresh-new", expires_at: Date.now() + 3600_000, project_id: "project-123", email: "user@example.com" });
  assert.equal(ant.loadCredentials().project_id, "project-123");
});

test("request translation maps text, system and tools", async () => {
  const ant = await import("../bin/cc-antigravity.mjs?t=" + Date.now());
  const adapter = await import("../proxy/antigravity.mjs?t=" + Date.now());
  const envelope = adapter.anthropicToGemini({
    system: "be brief",
    max_tokens: 1234,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "/x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    ],
    tools: [{ name: "read", description: "read a file", input_schema: { type: "object", properties: { path: { type: "string", minLength: 1, exclusiveMinimum: 0 } }, required: ["path"], additionalProperties: false } }],
  }, "claude-sonnet-4-6", { project_id: "project-123" });
  assert.equal(envelope.project, "project-123");
  assert.equal(envelope.model, "claude-sonnet-4-6");
  assert.equal(envelope.userAgent, "antigravity");
  assert.equal(envelope.request.systemInstruction.parts[0].text, "be brief");
  assert.equal(envelope.request.generationConfig.maxOutputTokens, 1234);
  assert.equal(envelope.request.tools[0].functionDeclarations[0].name, "read");
  assert.equal(envelope.request.tools[0].functionDeclarations[0].parameters.properties.path.exclusiveMinimum, undefined);
  assert.equal(envelope.request.tools[0].functionDeclarations[0].parameters.properties.path.minLength, undefined);
  assert.ok(envelope.request.contents.some((c) => c.role === "model" && c.parts.some((p) => p.functionCall)));
  assert.ok(envelope.request.contents.some((c) => c.role === "user" && c.parts.some((p) => p.functionResponse)));
});

test("gateway adapter streams Anthropic SSE and sends the expected envelope", async () => {
  const ant = await import("../bin/cc-antigravity.mjs?t=" + Date.now());
  ant.saveCredentials({ access_token: "access-new", refresh_token: "refresh-new", expires_at: Date.now() + 3600_000, project_id: "project-123" });
  const adapter = await import("../proxy/antigravity.mjs?t=" + Date.now());
  let out = "";
  const res = {
    writeHead() { }, flushHeaders() { }, write(s) { out += s; }, end() { }, destroy() { },
  };
  const errors = [];
  await adapter.proxyAntigravity(
    {},
    res,
    { name: "antigravity", model: "claude-sonnet-4-6", provider: { type: "antigravity" } },
    { max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
    { anthropicError: (_res, status, type, message) => errors.push([status, type, message]) }
  );
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.match(out, /text_delta/);
  assert.match(out, /hello /);
  assert.match(out, /world/);
  assert.match(out, /message_stop/);
  assert.equal(lastEnvelope.project, "project-123");
  assert.equal(lastEnvelope.model, "claude-sonnet-4-6");
});

test("gateway adapter returns JSON for non-streaming requests", async () => {
  const ant = await import("../bin/cc-antigravity.mjs?t=" + Date.now());
  ant.saveCredentials({ access_token: "access-new", refresh_token: "refresh-new", expires_at: Date.now() + 3600_000, project_id: "project-123" });
  const adapter = await import("../proxy/antigravity.mjs?t=" + Date.now());
  let out = ""; let head = null;
  const res = { writeHead(c, h) { head = [c, h]; }, flushHeaders() { }, write(s) { out += s; }, end(s) { if (s) out += s; }, destroy() { } };
  await adapter.proxyAntigravity({}, res, { name: "antigravity", model: "claude-sonnet-4-6", provider: { type: "antigravity" } }, { stream: false, max_tokens: 64, messages: [{ role: "user", content: "hi" }] }, { anthropicError: () => { } });
  assert.equal(head[0], 200);
  const j = JSON.parse(out);
  assert.equal(j.content[0].text, "hello world");
  assert.equal(j.usage.input_tokens, 7);
});
test("manual callback input accepts URL, raw code and code#state", async () => {
  const ant = await import("../bin/cc-antigravity.mjs?t=" + Date.now());
  const u = ant.parseCallbackInput("http://127.0.0.1:1234/callback?code=abc&state=st", "st");
  assert.deepEqual(u, { code: "abc", state: "st" });
  const raw = ant.parseCallbackInput("abc", "st");
  assert.equal(raw.code, "abc");
  const pair = ant.parseCallbackInput("abc#st", "st");
  assert.equal(pair.code, "abc");
  assert.throws(() => ant.parseCallbackInput("http://x/callback?code=a&state=wrong", "st"), /state mismatch/);
  assert.throws(() => ant.parseCallbackInput("http://x/callback?error=access_denied&error_description=no", "st"), /no/);
});
test("login completes from a pasted/authorization code with mocked Google endpoints", async () => {
  const ant = await import("../bin/cc-antigravity.mjs?t=" + Date.now());
  const old = process.env.CC_TERMUX_ANTIGRAVITY_CODE;
  process.env.CC_TERMUX_ANTIGRAVITY_CODE = "test-code";
  try {
    const creds = await ant.login({ browser: false, timeoutMs: 5000, log: () => { }, fetchImpl: fetch });
    assert.equal(creds.access_token, "access-new");
    assert.equal(creds.project_id, "project-123");
    assert.equal(creds.email, "user@example.com");
    assert.equal(ant.loadCredentials().project_id, "project-123");
  } finally {
    if (old === undefined) delete process.env.CC_TERMUX_ANTIGRAVITY_CODE; else process.env.CC_TERMUX_ANTIGRAVITY_CODE = old;
  }
});
test("quota exhaustion is reported as a fast 400, not a retryable 429", async () => {
  const ant = await import("../bin/cc-antigravity.mjs?t=" + Date.now());
  ant.saveCredentials({ access_token: "access-new", refresh_token: "refresh-new", expires_at: Date.now() + 3600_000, project_id: "project-123" });
  const adapter = await import("../proxy/antigravity.mjs?t=" + Date.now());
  generateMode = "quota";
  const errors = [];
  const res = { writeHead() { }, flushHeaders() { }, write() { }, end() { }, destroy() { } };
  try {
    await adapter.proxyAntigravity({}, res, { name: "antigravity", model: "claude-sonnet-4-6", provider: { type: "antigravity" } }, { max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, { anthropicError: (_r, status, type, message) => errors.push([status, type, message]) });
  } finally { generateMode = "ok"; }
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 400);
  assert.match(errors[0][2], /quota/i);
});