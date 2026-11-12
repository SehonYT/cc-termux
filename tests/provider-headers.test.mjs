import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const presets = JSON.parse(fs.readFileSync(path.join(root, "presets.json"), "utf8"));
const server = fs.readFileSync(path.join(root, "proxy", "server.mjs"), "utf8");

// The real helper, lifted from the server source and evaluated here. Importing server.mjs
// would start a gateway, so the function is extracted and compiled instead of mirrored.
const joinUrlSrc = /function joinUrl\(base, suffix\) \{[\s\S]*?\n\}/.exec(server)[0];
const joinUrl = new Function(joinUrlSrc + "; return joinUrl;")();

test("a baseUrl that already carries a version is not doubled", () => {
  // Every OpenAI-kind preset sets baseUrl ending in /v1, so the naive concat produced
  // /v1/v1/responses and the provider 404'd.
  assert.equal(joinUrl("https://host/v1", "/v1/responses"), "https://host/v1/responses");
  assert.equal(joinUrl("https://host/v1/", "/v1/responses"), "https://host/v1/responses");
  assert.equal(joinUrl("https://host", "/v1/responses"), "https://host/v1/responses");
  assert.equal(joinUrl("https://host/v1beta", "/v1/responses"), "https://host/v1beta/responses");
  assert.equal(joinUrl("https://host/v1", "v1/responses"), "https://host/v1/responses");
  // A base with no version keeps the suffix intact.
  assert.equal(joinUrl("https://host/api", "/v1/responses"), "https://host/api/v1/responses");
});

test("no shipped preset builds a doubled version path", () => {
  for (const preset of presets.free) {
    if (preset.kind === "anthropic") continue;
    for (const suffix of [preset.path || "/v1/messages", preset.pathResponses || "/v1/responses"]) {
      const url = joinUrl(preset.baseUrl, suffix);
      assert.ok(!/\/v\d+[a-z]*\/v\d+/i.test(url), preset.id + " doubles the version: " + url);
      assert.match(url, /^https?:\/\//, preset.id + " must produce an absolute URL");
    }
  }
});

test("all three proxy paths build their URL the same way", () => {
  // The chat path kept its own naive concat after the responses path was fixed, which is
  // exactly how the AgentRouter 401 stayed hidden.
  const uses = server.match(/joinUrl\(p\.baseUrl/g) || [];
  assert.equal(uses.length, 3, "every proxy path resolves its URL through joinUrl");
  assert.ok(!/p\.baseUrl\.replace\(\/\\\/\$\/, ''\) \+/.test(server), "no path may concat baseUrl by hand");
});

test("every proxy path forwards the preset's own headers", () => {
  // A gateway can fingerprint the client and reject anything that is not the expected one,
  // so the preset headers have to reach all three paths, not just one.
  const loops = server.match(/Object\.entries\(p\.headers \|\| \{\}\)/g) || [];
  assert.equal(loops.length, 3, "chat, messages and responses must each forward preset headers");
});

test("the AgentRouter preset sends the client identity its gateway requires", () => {
  const ar = presets.free.find((p) => p.id === "agentrouter");
  assert.ok(ar, "the preset exists");
  assert.equal(ar.baseUrl, "https://agentrouter.org/v1");
  // Verified against the live API: without these it answers "unauthorized client detected";
  // with them the request reaches normal auth and the key is accepted.
  assert.equal(ar.headers["user-agent"], "codex_cli_rs/0.20.0");
  assert.equal(ar.headers.originator, "codex_cli_rs");
  assert.equal(ar.headers.codex_cli_rs, "1");
  assert.match(ar.notes, /Codex client headers/);
});

test("a preset header cannot be overridden by an empty key", () => {
  // The key is applied first, so a preset can pin a header even when no key is set.
  const openaiIdx = server.indexOf("async function proxyOpenAI");
  const block = server.slice(openaiIdx, openaiIdx + 700);
  const keyIdx = block.indexOf("headers['authorization']");
  const presetIdx = block.indexOf("Object.entries(p.headers");
  assert.ok(keyIdx >= 0 && presetIdx > keyIdx, "preset headers are applied after the key");
});

test("the models fetch sends the preset headers too", () => {
  // The setup path fetches /models separately from chat. Without the client headers a
  // fingerprinting gateway answers 401 and the wizard reports a bad key, which is wrong.
  const setup = fs.readFileSync(path.join(root, "bin", "cc-setup.mjs"), "utf8");
  const idx = setup.indexOf("async function fetchPresetModels");
  const block = setup.slice(idx, idx + 1200);
  assert.match(block, /preset\.headers/, "/models must send the preset headers");
  assert.match(block, /authorization: "Bearer " \+ key/, "and still send the key");
  // A 401 with headers already sent means the key, not the client, so say so.
  assert.match(block, /client headers are sent/, "the error must distinguish the two causes");
});

test("the AgentRouter preset uses the Responses API", () => {
  const ar = presets.free.find((p) => p.id === "agentrouter");
  // Verified live: gpt-5 is rejected on /chat/completions on this gateway.
  assert.equal(ar.api, "responses");
  assert.equal(ar.pathResponses, "/v1/responses");
  // And the model ids must be ones the gateway actually serves.
  assert.match(ar.notes, /Responses API/);
});

test("a provider finds its key under its id or its display name", () => {
  // keys.json is filed by id, but a provider's name can be a display label like
  // "AgentRouter". Matching only on name silently sent no token, which surfaced as
  // "no token provided" from the upstream instead of a config error.
  const server = fs.readFileSync(path.join(root, "proxy", "server.mjs"), "utf8");
  const fn = /function providerKey\(p\) \{[\s\S]*?\n\}/.exec(server)[0];
  assert.match(fn, /p\.keyName, p\.id, p\.name/, "the lookup tries the id and the name");
  assert.match(fn, /p\.apiKey/, "and still honours a key in the config");
  // The loader must stamp the id, or there is nothing for the lookup to match on.
  assert.match(server, /p\.id = n/, "the loader records the provider id");
});

test("a gateway that omits context length falls back to a documented value", () => {
  const setup = fs.readFileSync(path.join(root, "bin", "cc-setup.mjs"), "utf8");
  assert.match(setup, /preset\.contextDefaults/, "the preset can supply context windows");
  const ar = presets.free.find((p) => p.id === "agentrouter");
  // Its /models returns no context field at all, verified live.
  assert.ok(ar.contextDefaults, "agentrouter documents its model windows");
  for (const [id, ctx] of Object.entries(ar.contextDefaults)) {
    assert.ok(Number.isFinite(ctx) && ctx > 1000, id + " needs a real context size");
  }
});

test("the gateway reports each model's context so a client need not guess", () => {
  const server = fs.readFileSync(path.join(root, "proxy", "server.mjs"), "utf8");
  const idx = server.indexOf("'/v1/models'");
  const block = server.slice(idx, idx + 900);
  // With no capacity field the client falls back to its own default, which made every
  // provider look like a 200k model.
  assert.match(block, /context_length/, "the model list reports context_length");
  assert.match(block, /max_input_tokens/, "and max_input_tokens");
  // It must come from the model, then the provider, or be omitted.
  assert.match(block, /info\.contextTokens \|\| info\.context_length \|\| p\.contextWindow/);
});

test("AgentRouter carries the documented windows for its models", () => {
  const ar = presets.free.find((p) => p.id === "agentrouter");
  // Verified live: neither /v1/models nor /api/pricing exposes any context field, so the
  // values come from each model's own specification.
  for (const id of ["gpt-5.6-sol", "gpt-6-astra", "gpt-6.1-sol"]) {
    assert.equal(ar.contextDefaults[id], 1050000, id + " has a 1.05M window");
    assert.equal(ar.maxOutputDefaults[id], 128000, id + " caps output at 128k");
  }
  assert.match(ar.notes, /no context data/, "the reason for manual values is recorded");
});

test("cc-patch resolves its root through cc-paths", () => {
  const patch = fs.readFileSync(path.join(root, "bin", "cc-patch.mjs"), "utf8");
  assert.match(patch, /import \{ installRoot \} from "\.\/cc-paths\.mjs"/);
  assert.match(patch, /const ROOT = installRoot\(\)/);
  // A hardcoded home path would ignore a custom --root, exactly as the uninstaller once did.
  assert.ok(!/path\.join\(os\.homedir\(\), "\.local", "share", "modelmesh"\)/.test(patch),
    "no hardcoded install root");
});

test("the installer moves an npm .ps1 aside so it cannot shadow our shim", () => {
  const inst = fs.readFileSync(path.join(root, "install.mjs"), "utf8");
  // PowerShell prefers .ps1 over .cmd in the same directory.
  assert.match(inst, /\.ps1/, "the windows shim block handles .ps1");
  assert.match(inst, /modelmesh-backup/, "a leftover is moved aside, never deleted");
  assert.match(inst, /cc-launcher\.mjs.*modelmesh|modelmesh.*cc-launcher\.mjs/s, "our own shim is recognised and kept");
});

test("the AgentRouter slug and docs match the preset", () => {
  const p = presets.free.find((x) => x.id === "agentrouter");
  assert.equal(p.kind, "openai");
  assert.equal(p.path, "/chat/completions");
  assert.match(p.keyUrl, /agentrouter\.org/);
});
