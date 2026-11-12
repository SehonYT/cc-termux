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
let overloadLeft = 0;

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
        if (generateMode === "tool") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("data: " + JSON.stringify({ response: { candidates: [{ content: { parts: [{ functionCall: { id: "call_1", name: "bash", args: { command: "echo hi" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } } }) + "\n\n");
          return res.end();
        }
        if (generateMode === "quota") {
          res.writeHead(429, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } }));
        }
        // "The model is overloaded" is a transient 503, not a broken install.
        if (generateMode === "overload" && overloadLeft > 0) {
          overloadLeft--;
          res.writeHead(503, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } }));
        }
        if (generateMode === "drop") {
          // Drop the socket the way a flaky mobile connection does.
          return res.socket.destroy();
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
  process.env.MODELMESH_CONFIG = path.join(cfgDir, "config.json");
  process.env.MODELMESH_ANTIGRAVITY_TOKEN_URL = "http://127.0.0.1:" + port + "/token";
  process.env.MODELMESH_ANTIGRAVITY_USERINFO_URL = "http://127.0.0.1:" + port + "/userinfo";
  process.env.MODELMESH_ANTIGRAVITY_BOOTSTRAP_URL = "http://127.0.0.1:" + port;
  process.env.MODELMESH_ANTIGRAVITY_GENERATE_URL = "http://127.0.0.1:" + port + "/generate";
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

// The output ceiling and the thinking budget both used to override what the caller asked for.
test("the requested max_tokens is never exceeded, and an absent one uses the model ceiling", async () => {
  const adapter = await import("../proxy/antigravity.mjs?t=" + Date.now());
  const creds = { project_id: "p" };
  const cfg = (body, model) => adapter.anthropicToGemini(body, model, creds).request.generationConfig;
  const msg = [{ role: "user", content: "hi" }];
  // A small limit must be honoured even when high effort asks for a huge thinking budget:
  // this used to come out as 32769 and silently ignore the caller.
  assert.equal(cfg({ max_tokens: 100, output_config: { effort: "high" }, messages: msg }, "gemini-3.8-flash-high").maxOutputTokens, 100);
  assert.equal(cfg({ max_tokens: 100, thinking: { budget_tokens: 32768 }, messages: msg }, "gemini-3.8-flash-high").maxOutputTokens, 100);
  assert.equal(cfg({ max_tokens: 2000, output_config: { effort: "medium" }, messages: msg }, "gemini-3.8-flash-high").maxOutputTokens, 2000);
  // An absent limit means the model's own ceiling, not the old 8192.
  assert.equal(cfg({ messages: msg }, "claude-sonnet-4-6").maxOutputTokens, 64000);
  assert.equal(cfg({ messages: msg }, "gemini-3.8-flash-high").maxOutputTokens, 65536);
  assert.equal(cfg({ messages: msg }, "gpt-oss-120b-medium").maxOutputTokens, 32768);
  // Claude is capped at 64000 by the catalog; a larger ask is clamped to that, not to 16384.
  assert.equal(cfg({ max_tokens: 200000, messages: msg }, "claude-sonnet-4-6").maxOutputTokens, 64000);
  // Thinking still works when there is room for it, and fits inside a tight answer.
  assert.equal(cfg({ max_tokens: 64000, output_config: { effort: "high" }, messages: msg }, "gemini-3.8-flash-high").thinkingConfig.thinkingBudget, 32768);
  assert.equal(cfg({ max_tokens: 100, output_config: { effort: "high" }, messages: msg }, "gemini-3.8-flash-high").thinkingConfig.thinkingBudget, 99);
  // Claude-branded models reject a thinkingConfig, so they must never carry one.
  assert.equal(cfg({ max_tokens: 64000, output_config: { effort: "high" }, messages: msg }, "claude-sonnet-4-6").thinkingConfig, undefined);
});

test("request translation maps text, system and tools", async () => {
  const ant = await import("../bin/cc-antigravity.mjs?t=" + Date.now());
  const adapter = await import("../proxy/antigravity.mjs?t=" + Date.now());
  const envelope = adapter.anthropicToGemini({
    system: "x-anthropic-billing-header: cc_version=2.1.319; cc_entrypoint=sdk-cli;\nbe brief",
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
  // Antigravity's own system prompt stays upstream; the client system prompt is
  // relocated into the first user turn (oversized systemInstruction -> false 429).
  assert.match(envelope.request.systemInstruction.parts[0].text, /^You are Antigravity/);
  const firstUser = envelope.request.contents[0];
  assert.equal(firstUser.role, "user");
  assert.match(firstUser.parts[0].text, /be brief/);
  assert.doesNotMatch(firstUser.parts[0].text, /billing-header/);
  assert.equal(envelope.request.generationConfig.maxOutputTokens, 1234);
  assert.equal(envelope.request.tools[0].functionDeclarations[0].name, "read");
  assert.equal(envelope.request.tools[0].functionDeclarations[0].parameters.properties.path.exclusiveMinimum, undefined);
  assert.equal(envelope.request.tools[0].functionDeclarations[0].parameters.properties.path.minLength, undefined);
  const modelCall = envelope.request.contents.find((c) => c.role === "model" && c.parts.some((p) => p.functionCall));
  assert.ok(modelCall);
  const call = modelCall.parts.find((p) => p.functionCall);
  assert.equal(call.functionCall.id, "toolu_1");
  assert.equal(call.thoughtSignature, "skip_thought_signature_validator");
  const resultContent = envelope.request.contents.find((c) => c.role === "user" && c.parts.some((p) => p.functionResponse));
  assert.equal(resultContent.parts.find((p) => p.functionResponse).functionResponse.id, "toolu_1");
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
  const old = process.env.MODELMESH_ANTIGRAVITY_CODE;
  process.env.MODELMESH_ANTIGRAVITY_CODE = "test-code";
  try {
    const creds = await ant.login({ browser: false, timeoutMs: 5000, log: () => { }, fetchImpl: fetch });
    assert.equal(creds.access_token, "access-new");
    assert.equal(creds.project_id, "project-123");
    assert.equal(creds.email, "user@example.com");
    assert.equal(ant.loadCredentials().project_id, "project-123");
  } finally {
    if (old === undefined) delete process.env.MODELMESH_ANTIGRAVITY_CODE; else process.env.MODELMESH_ANTIGRAVITY_CODE = old;
  }
});
test("rate limiting is retried then reported as 429", async () => {
  const ant = await import("../bin/cc-antigravity.mjs?t=" + Date.now());
  ant.saveCredentials({ access_token: "access-new", refresh_token: "refresh-new", expires_at: Date.now() + 3600_000, project_id: "project-123" });
  const adapter = await import("../proxy/antigravity.mjs?t=" + Date.now());
  generateMode = "quota";
  process.env.MODELMESH_ANTIGRAVITY_429_RETRIES = "0";
  const errors = [];
  const res = { writeHead() { }, flushHeaders() { }, write() { }, end() { }, destroy() { } };
  try {
    await adapter.proxyAntigravity({}, res, { name: "antigravity", model: "claude-sonnet-4-6", provider: { type: "antigravity" } }, { max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, { anthropicError: (_r, status, type, message) => errors.push([status, type, message]) });
  } finally { generateMode = "ok"; delete process.env.MODELMESH_ANTIGRAVITY_429_RETRIES; }
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 429);
  assert.match(errors[0][2], /rate-limited|quota/i);
});
test("live model and quota payload parsing", async () => {
  const ant = await import("../bin/cc-antigravity.mjs?t=" + Date.now());
  const models = ant.parseAvailableModels({ models: {
    "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", maxTokens: 1048576, maxOutputTokens: 65536, recommended: true },
    "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", maxTokens: 250000, maxOutputTokens: 64000 },
    "gemini-2.5-pro": { displayName: "Legacy Gemini" },
    "gemini-3.1-flash-image": { displayName: "Image" },
    "gemini-4-argon-disabled": { displayName: "Argon (disabled)" },
    "tab_flash_lite_preview": { displayName: "Tab" },
    "internal_x": { displayName: "Internal", isInternal: true },
  } });
  assert.deepEqual(models.map((m) => m.id), ["gemini-3.8-flash-high", "claude-sonnet-4-6"]);
  const usage = ant.parseQuotaSummary({ groups: [
    { displayName: "Gemini Models", buckets: [
      { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.5, resetTime: "2026-11-08T06:00:00Z" },
      { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 1, resetTime: "2026-11-15T00:00:00Z" },
    ] },
    { displayName: "Claude & GPT", buckets: [
      { bucketId: "3p-5h", window: "5h", remainingFraction: 0.9 },
      { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.68 },
    ] },
  ] });
  assert.equal(usage.groups.length, 2);
  assert.equal(usage.groups[0].id, "gemini");
  assert.equal(Math.round(usage.groups[0].windows.session.percent), 50);
  assert.equal(usage.groups[1].id, "claude");
  assert.equal(Math.round(usage.groups[1].windows.weekly.percent), 68);
});
test("official Antigravity catalog keeps only CLI-visible models and hides disabled Argon", async () => {
  const ant = await import("../bin/cc-antigravity.mjs?t=" + Date.now());
  const models = ant.parseAvailableModels({ models: {
    "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)" },
    "gpt-oss-120b-medium": { displayName: "GPT-OSS" },
    "gemini-3.1-flash-lite": { displayName: "Old" },
    "gemini-4-argon-disabled": { displayName: "Argon disabled" },
    "gemini-4-argon-high": { displayName: "Argon" },
  } });
  assert.deepEqual(models.map((m) => m.id).sort(), ["gemini-3.8-flash-high", "gemini-4-argon-high", "gpt-oss-120b-medium"].sort());
});
test("agentModelSorts drives the official list (paid Argon appears automatically)", async () => {
  const ant = await import("../bin/cc-antigravity.mjs?t=" + Date.now());
  const models = ant.parseAvailableModels({
    models: {
      "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)" },
      "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6" },
      "gpt-oss-120b-medium": { displayName: "GPT-OSS" },
      "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)" },
      "gemini-2.5-pro": { displayName: "Legacy" },
    },
    agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.8-flash-high", "claude-sonnet-4-6", "gpt-oss-120b-medium", "gemini-4-argon-high"] }] }],
  });
  assert.deepEqual(models.map((m) => m.id), ["gemini-3.8-flash-high", "claude-sonnet-4-6", "gpt-oss-120b-medium", "gemini-4-argon-high"]);
});
test("system prompt blocks are joined with newlines, billing header and competing-agent identity are stripped", async () => {
  const adapter = await import("../proxy/antigravity.mjs?t=" + Date.now());
  const envelope = adapter.anthropicToGemini({
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.319;" },
      { type: "text", text: "You are a Claude agent, built on Anthropic\x27s Claude Agent SDK." },
      { type: "text", text: "Follow the user request." },
    ],
    max_tokens: 32,
    messages: [{ role: "user", content: "hi" }],
  }, "gemini-3.8-flash-high", { project_id: "p" });
  assert.match(envelope.request.systemInstruction.parts[0].text, /^You are Antigravity/);
  const text = envelope.request.contents[0].parts[0].text;
  assert.doesNotMatch(text, /You are a Claude agent/);
  assert.match(text, /Follow the user request/);
  assert.doesNotMatch(text, /billing-header/);
  assert.doesNotMatch(text, /You are Gemini|built by Google/);
});
test("gateway adapter surfaces tool calls as anthropic tool_use blocks", async () => {
  const ant = await import("../bin/cc-antigravity.mjs?t=" + Date.now());
  ant.saveCredentials({ access_token: "access-new", refresh_token: "refresh-new", expires_at: Date.now() + 3600_000, project_id: "project-123" });
  const adapter = await import("../proxy/antigravity.mjs?t=" + Date.now());
  generateMode = "tool";
  let out = "";
  const errors = [];
  const res = { writeHead() { }, flushHeaders() { }, write(s) { out += s; }, end() { }, destroy() { } };
  try {
    await adapter.proxyAntigravity({}, res, { name: "antigravity", model: "gemini-3.8-flash-high", provider: { type: "antigravity" } }, { max_tokens: 50, messages: [{ role: "user", content: "run" }], tools: [{ name: "bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }] }, { anthropicError: (_r, status, type, message) => errors.push([status, type, message]) });
  } finally { generateMode = "ok"; }
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.match(out, /"type":"tool_use"/);
  assert.match(out, /input_json_delta/);
  assert.match(out, /message_stop/);
});
test("tool schemas prune required entries whose properties were stripped", async () => {
  const adapter = await import("../proxy/antigravity.mjs?t=" + Date.now());
  const envelope = adapter.anthropicToGemini({
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "t", input_schema: { type: "object", properties: { a: { type: "string" }, gone: { $ref: "x" } }, required: ["a", "gone"], additionalProperties: false } }],
  }, "m", { project_id: "p" });
  const params = envelope.request.tools[0].functionDeclarations[0].parameters;
  assert.deepEqual(params.required, ["a"]);
  assert.equal(params.properties.gone, undefined);
});
test("competing-agent identity is scrubbed so Antigravity does not answer a false 429", async () => {
  const { scrubIdentity, anthropicToGemini } = await import("../proxy/antigravity.mjs?t=" + Date.now());
  const raw = "x-anthropic-billing-header: cc_version=2.1.322.997; cc_entrypoint=sdk-cli;\n" +
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.\n\n" +
    "You are an agent working with the user toward their goals.";
  const out = scrubIdentity(raw);
  assert.ok(!/claude agent/i.test(out), "identity sentence must be removed");
  assert.ok(!/claude agent sdk/i.test(out), "SDK identity must be removed");
  assert.match(out, /working with the user toward their goals/);
  const env = anthropicToGemini({ system: raw, max_tokens: 32, messages: [{ role: "user", content: "hi" }] }, "gemini-3.8-flash-high", { project_id: "p" });
  const sys = env.request.systemInstruction.parts.map((p) => p.text).join("\n");
  assert.ok(!/claude agent/i.test(sys) && !/x-anthropic-billing-header/i.test(sys), "upstream system prompt must be clean");
});

test("a refusal is only cached when every host fails", () => {
  // The secondary host answers 429 for requests the daily host serves fine. Caching on
  // that made the next identical request fail locally without trying upstream, which
  // looked exactly like exhausted quota and survived a re-login.
  const src = fs.readFileSync(path.join(root, "proxy", "antigravity.mjs"), "utf8");
  assert.match(src, /let hostsTried = 0/, "it counts the hosts that answered 429");
  assert.match(src, /hostsTried \+= 1/, "incrementing only when a host is exhausted");
  // Widened to any exhausted retryable status so an overloaded host also shares a back-off,
  // but the invariant is unchanged: every host must have failed before anything is cached.
  assert.match(src, /const everyHostFailed = retryable\(upstream\.status\) && hostsTried === GENERATE_URLS\.length/, "a refusal needs every host to have failed");
  assert.match(src, /if \(everyHostFailed\) \{/, "and the cache is only written then");
  assert.match(src, /not cached: only /, "anything else is logged as not cached");
});

test("a 429 names the model that is out, or says none is", () => {
  // The message used to say quota may still be available, which is useless when the
  // account has 19 buckets and only some are low.
  const src = fs.readFileSync(path.join(root, "proxy", "antigravity.mjs"), "utf8");
  assert.match(src, /describeExhausted/, "it consults the per-model buckets");
  assert.match(src, /no model is out of quota, so this is a temporary limit/, "and says so when nothing is out");
  assert.match(src, /exhausted: /, "naming the models when something is");
});

// A flaky connection used to fail the whole request with the bare message "fetch failed", so
// every network blip on a phone looked like a broken install.
test("a dropped connection still reports why instead of a bare 'fetch failed'", async () => {
  const ant = await import("../bin/cc-antigravity.mjs?t=" + Date.now());
  ant.saveCredentials({ access_token: "access-new", refresh_token: "refresh-new", expires_at: Date.now() + 3600_000, project_id: "project-123" });
  const adapter = await import("../proxy/antigravity.mjs?t=" + Date.now());
  generateMode = "drop";
  process.env.MODELMESH_ANTIGRAVITY_NET_DELAYS = "20,40";
  const errors = [];
  try {
    await adapter.proxyAntigravity({}, { writeHead() { }, flushHeaders() { }, write() { }, end() { }, destroy() { } },
      { name: "antigravity", model: "gemini-3.8-flash-high", provider: { type: "antigravity" } },
      { max_tokens: 20, messages: [{ role: "user", content: "hi" }] },
      { anthropicError: (_r, status, type, message) => errors.push([status, type, message]) });
  } finally { generateMode = "ok"; delete process.env.MODELMESH_ANTIGRAVITY_NET_DELAYS; }
  assert.equal(errors.length, 1, "a dropped socket still has to be reported");
  assert.equal(errors[0][0], 502);
  // The message must name the cause, not just repeat "fetch failed".
  assert.match(errors[0][2], /\(/, "the cause code is included: " + errors[0][2]);
});

test("a transient 503 overload is retried, a permanent one still surfaces", async () => {
  const ant = await import("../bin/cc-antigravity.mjs?t=" + Date.now());
  ant.saveCredentials({ access_token: "access-new", refresh_token: "refresh-new", expires_at: Date.now() + 3600_000, project_id: "project-123" });
  const adapter = await import("../proxy/antigravity.mjs?t=" + Date.now());
  const run = async () => {
    const errors = [];
    let out = "";
    await adapter.proxyAntigravity({}, { writeHead() { }, flushHeaders() { }, write(s) { out += s; }, end() { }, destroy() { } },
      { name: "antigravity", model: "gemini-3.8-flash-high", provider: { type: "antigravity" } },
      { max_tokens: 20, messages: [{ role: "user", content: "hi" }] },
      { anthropicError: (_r, status, type, message) => errors.push([status, type, message]) }).catch((e) => errors.push([e.status || 0, e.type || "", e.message]));
    return { errors, out };
  };
  generateMode = "overload";
  overloadLeft = 2;
  const savedDelays = process.env.MODELMESH_ANTIGRAVITY_429_DELAYS;
  const savedRetries = process.env.MODELMESH_ANTIGRAVITY_429_RETRIES;
  process.env.MODELMESH_ANTIGRAVITY_429_DELAYS = "10";
  process.env.MODELMESH_ANTIGRAVITY_429_RETRIES = "2";
  try {
    const transient = await run();
    assert.equal(transient.errors.length, 0, JSON.stringify(transient.errors));
    assert.match(transient.out, /hello/, "the retried request must deliver the answer");
    // A real outage is not hidden: it is reported once the retries are spent.
    overloadLeft = 99;
    const permanent = await run();
    assert.ok(permanent.errors.length > 0, "a permanent 503 must not hang or pass silently");
    assert.match(String(permanent.errors[0][2]), /overloaded|503/i);
  } finally {
    generateMode = "ok"; overloadLeft = 0;
    if (savedDelays === undefined) delete process.env.MODELMESH_ANTIGRAVITY_429_DELAYS; else process.env.MODELMESH_ANTIGRAVITY_429_DELAYS = savedDelays;
    if (savedRetries === undefined) delete process.env.MODELMESH_ANTIGRAVITY_429_RETRIES; else process.env.MODELMESH_ANTIGRAVITY_429_RETRIES = savedRetries;
  }
});

test("per-model quota is kept, not flattened into families", () => {
  const src = fs.readFileSync(path.join(root, "bin", "cc-antigravity.mjs"), "utf8");
  assert.match(src, /const models = \[\]/, "the buckets are retained");
  assert.match(src, /models\.push\(\{ model: id/, "with their model ids");
  assert.match(src, /return \{ groups: \[\.\.\.byFamily\.values\(\)\], models \}/, "and returned alongside the families");
  assert.match(src, /export function describeExhausted/, "there is a reader for them");
  // doctor must report it, since that is where a user looks.
  const cli = fs.readFileSync(path.join(root, "bin", "modelmesh"), "utf8");
  assert.match(cli, /antigravity quota low/, "doctor warns about a low model");
  assert.match(cli, /antigravity quota healthy across/, "and confirms a healthy account");
});

test("the test runner does not pass a flag older Node rejects", () => {
  // --test-timeout landed in Node 20 and Node 18 is still supported, so passing it
  // unconditionally made every file fail to start with bad option.
  const runner = fs.readFileSync(path.join(root, "tests", "run-tests.mjs"), "utf8");
  assert.match(runner, /supportsTestTimeout/, "it probes for the flag");
  assert.match(runner, /bad option/, "by looking for the rejection");
  assert.match(runner, /nodeArgs/, "and builds the argument list from the answer");
  assert.match(runner, /\[\.\.\.nodeArgs, path\.join\(dir, f\)\]/, "passing only what this Node accepts");
});
