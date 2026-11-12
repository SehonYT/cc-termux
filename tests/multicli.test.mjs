import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server = fs.readFileSync(path.join(root, "proxy", "server.mjs"), "utf8");
const translate = await import("../proxy/translate.mjs");

test("an OpenAI request becomes an Anthropic body", () => {
  // Another CLI sends OpenAI; the router only understands Anthropic. This is the seam.
  const body = translate.openAIToAnthropic({
    model: "prov/x/m",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{\"a\":1}" } }] },
      { role: "tool", tool_call_id: "c1", content: "result" },
    ],
    tools: [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } }],
    max_tokens: 100,
    temperature: 0.2,
    stop: ["END"],
    stream: true,
  });
  assert.equal(body.model, "prov/x/m");
  assert.equal(body.max_tokens, 100);
  assert.equal(body.stream, true);
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.stop_sequences, ["END"]);
  assert.equal(body.system[0].text, "be brief", "the system turn is hoisted out");
  assert.equal(body.messages.length, 3, "system is not left in the messages");
  assert.equal(body.tools[0].name, "t");
  assert.deepEqual(body.tools[0].input_schema, { type: "object" });
  // The assistant tool call and its result become the Anthropic pair.
  const assistant = body.messages[1];
  assert.equal(assistant.content[0].type, "tool_use");
  assert.deepEqual(assistant.content[0].input, { a: 1 });
  assert.equal(body.messages[2].content[0].type, "tool_result");
  assert.equal(body.messages[2].content[0].tool_use_id, "c1");
});

test("an Anthropic reply becomes an OpenAI completion", () => {
  const out = translate.anthropicToOpenAI({
    id: "msg_1",
    content: [{ type: "text", text: "hello" }, { type: "tool_use", id: "t1", name: "t", input: { a: 1 } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 5, output_tokens: 2 },
  }, "m");
  assert.equal(out.object, "chat.completion");
  assert.equal(out.choices[0].message.content, "hello");
  assert.equal(out.choices[0].finish_reason, "tool_calls");
  assert.equal(out.choices[0].message.tool_calls[0].function.name, "t");
  assert.equal(out.choices[0].message.tool_calls[0].function.arguments, "{\"a\":1}");
  assert.equal(out.usage.prompt_tokens, 5);
  assert.equal(out.usage.total_tokens, 7);
  // A plain stop maps to stop, and a token cap maps to length.
  assert.equal(translate.anthropicToOpenAI({ content: [], stop_reason: "end_turn" }, "m").choices[0].finish_reason, "stop");
  assert.equal(translate.anthropicToOpenAI({ content: [], stop_reason: "max_tokens" }, "m").choices[0].finish_reason, "length");
});

test("the gateway serves both API shapes and the MCP endpoint", () => {
  assert.match(server, /u\.pathname === '\/v1\/chat\/completions'/, "the OpenAI path is routed");
  assert.match(server, /u\.pathname === '\/v1\/messages'/, "the Anthropic path is routed");
  assert.match(server, /u\.pathname === '\/mcp'/, "MCP over HTTP is routed");
  // Every path must reach the same router, or a provider would work on one and not the other.
  for (const fn of ["proxyOpenAIInbound", "proxyOpenAI", "proxyResponses"]) {
    assert.match(server, new RegExp("function " + fn), fn + " exists");
  }
});

test("the short provider/model form routes to its provider", () => {
  // modelmesh start advertises provider/model, so the router has to accept it or the
  // documented form silently falls through to the active provider.
  const pick = /function pickRoute\(model\) \{[\s\S]*?\n\}/.exec(server)[0];
  assert.match(pick, /const short = \/\^\(\[\^\/\]\+\)\\\/\(.\+\)\$\//, "it parses provider/model");
  assert.ok(pick.indexOf("short") < pick.indexOf("CONFIG.active"), "and checks it before the active provider");
  assert.match(pick, /endsWith\("\/" \+ wants\)/, "a model id containing slashes still resolves");
});

test("an Antigravity provider is served on the OpenAI surface too", () => {
  // Its stream logic used to be locked inside its own HTTP handler, so this endpoint could
  // only answer 501. It now takes an event sink, and the OpenAI path passes one.
  const ag = fs.readFileSync(path.join(root, "proxy", "antigravity.mjs"), "utf8");
  assert.match(ag, /export async function proxyAntigravity\(req, res, route, body, \{ anthropicError, sink = null \}/, "the handler accepts a sink");
  assert.match(ag, /if \(sink\) \{ sink\(event, data\); return; \}/, "the sink receives the events");
  // With a sink there is no response to write to, so failures must throw.
  assert.match(ag, /const fail = \(status, type, message\) =>/, "there is a failure shim");
  assert.match(ag, /if \(sink\) \{ const e = new Error\(message\); e\.status = status/, "which throws when there is no response");
  assert.ok(!/anthropicError\(res, 401/.test(ag), "no failure path writes to a null response");
  assert.match(server, /proxyAntigravity\(null, null, route, \{ \.\.\.anthropicBody, stream: true \}, \{ sink: onEvent \}\)/, "the OpenAI path uses it");
  assert.ok(!/not_implemented_error/.test(server), "the 501 fallback is gone");
});

test("start prints a block another tool can use", async () => {
  const mod = await import("../bin/cc-start.mjs");
  const text = mod.startInstructions({ port: 9999, token: "tok_demo" });
  assert.match(text, /http:\/\/127\.0\.0\.1:9999/, "the base URL");
  assert.match(text, /\/v1\/chat\/completions|OpenAI API/, "the OpenAI surface");
  assert.match(text, /Anthropic API/, "the Anthropic surface");
  assert.match(text, /tok_demo/, "the token");
  assert.match(text, /OPENAI_BASE_URL/, "the env vars");
  assert.match(text, /MCP/, "where the MCP server is");
  assert.match(text, /skills/, "where the skills are");
  // The paths it prints must be real ones.
  const assets = mod.assetPaths();
  assert.ok(fs.existsSync(assets.mcp), "the MCP server exists at the printed path");
  assert.ok(fs.existsSync(assets.skills), "the skills directory exists");
});

test("the token is generated once and kept", () => {
  const src = fs.readFileSync(path.join(root, "bin", "cc-start.mjs"), "utf8");
  assert.match(src, /cfg\.gatewayToken/, "an existing token is reused");
  assert.match(src, /randomBytes/, "a missing one is generated");
  assert.match(src, /0o600/, "and the config stays private");
});

test("installation tells the user about the other tools", () => {
  const inst = fs.readFileSync(path.join(root, "install.mjs"), "utf8");
  assert.match(inst, /modelmesh start --print/, "the installer points at start");
  const setup = fs.readFileSync(path.join(root, "bin", "cc-setup.mjs"), "utf8");
  assert.match(setup, /modelmesh start --print/, "and so does the setup summary");
});
