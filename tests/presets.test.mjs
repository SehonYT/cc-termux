import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const presets = JSON.parse(fs.readFileSync(path.join(repo, "presets.json"), "utf8")).free;
const byId = Object.fromEntries(presets.map((p) => [p.id, p]));

const EXPECTED = {
  "agentrouter": "https://agentrouter.org/v1",
  "deepseek": "https://api.deepseek.com/v1",
  "xai": "https://api.x.ai/v1",
  "fireworks": "https://api.fireworks.ai/inference/v1",
  "novita": "https://api.novita.ai/v3/openai",
  "nebius": "https://api.studio.nebius.ai/v1",
  "chutes": "https://llm.chutes.ai/v1",
  "scaleway": "https://api.scaleway.ai/v1",
  "ovh": "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
  "zai": "https://api.z.ai/api/paas/v4",
  "moonshot": "https://api.moonshot.ai/v1",
  "qwen": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "minimax": "https://api.minimax.io/v1",
  "siliconflow": "https://api.siliconflow.cn/v1",
  "deepinfra": "https://api.deepinfra.com/v1/openai",
  "upstage": "https://api.upstage.ai/v1",
  "perplexity": "https://api.perplexity.ai",
  "cohere": "https://api.cohere.ai/compatibility/v1",
  "requesty": "https://router.requesty.ai/v1",
  "featherless": "https://api.featherless.ai/v1"
};

test("preset list has at least 20 providers and unique ids", () => {
  assert.ok(presets.length >= 20, "expected at least 20 presets, got " + presets.length);
  const ids = presets.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate preset ids");
});

test("AgentRouter is present with the right endpoint", () => {
  const a = byId.agentrouter;
  assert.ok(a, "agentrouter preset missing");
  assert.equal(a.baseUrl, "https://agentrouter.org/v1");
  assert.equal(a.path, "/chat/completions");
  assert.equal(a.kind, "openai");
});

test("every provider has a valid, properly configured endpoint", () => {
  for (const p of presets) {
    assert.match(p.id, /^[a-z0-9][a-z0-9-]*$/, "bad id " + p.id);
    assert.ok(p.name, "missing name for " + p.id);
    assert.ok(["openai", "gemini", "antigravity"].includes(p.kind), "bad kind for " + p.id);
    assert.match(p.baseUrl, /^https?:\/\//, "bad baseUrl for " + p.id);
    if (p.noKey) { assert.match(p.baseUrl, /^http:\/\/127\.0\.0\.1|^http:\/\/localhost/, p.id + " local preset must use loopback"); }
    else assert.match(p.baseUrl, /^https:\/\//, p.id + " remote preset must use https");
    if (!p.noKey && p.auth !== "antigravity" && ["openai", "gemini"].includes(p.kind)) assert.ok(p.keyUrl, "missing keyUrl for " + p.id);
    if (p.kind === "antigravity") assert.match(p.path, /v1internal:streamGenerateContent/);
    else if (p.kind !== "gemini") assert.match(p.path || "/chat/completions", /^\/.*completions$/, "bad path for " + p.id);
    if (p.modelsPath === null) assert.ok(Array.isArray(p.models) && p.models.length, p.id + " needs static models");
  }
});

test("the 20 new providers keep their documented base URLs", () => {
  for (const [id, url] of Object.entries(EXPECTED)) {
    assert.ok(byId[id], "missing preset " + id);
    assert.equal(byId[id].baseUrl, url, id + " base URL changed");
  }
});

test("static model lists contain usable ids", () => {
  for (const p of presets) {
    for (const m of p.models || []) {
      const id = typeof m === "string" ? m : m.id;
      assert.ok(id && typeof id === "string", "bad static model in " + p.id);
    }
  }
  assert.ok(byId.perplexity.models.includes("sonar-pro"));
});
test("popular providers come first and tokens.bd is last", () => {
  const ids = presets.map((p) => p.id);
  assert.equal(ids[0], "openrouter");
  assert.equal(ids[1], "gemini");
  assert.equal(ids[ids.length - 1], "tokens", "tokens.bd must be the last preset");
  for (const popular of ["openrouter", "gemini", "groq", "deepseek", "xai", "mistral", "cerebras", "nvidia"]) {
    assert.ok(ids.indexOf(popular) < 20, popular + " should be among the first 20 presets");
  }
  assert.ok(ids.indexOf("tokens") > ids.indexOf("agentrouter"));
});
test("presets whose discovery endpoint is not JSON use a known path or static models", () => {
  assert.equal(byId.tokens.modelsPath, "/v1/models", "tokens.bd /models is HTML, /v1/models is JSON");
  assert.equal(byId["github-models"].modelsPath, null);
  assert.ok(Array.isArray(byId["github-models"].models) && byId["github-models"].models.length > 0);
  assert.ok(byId.perplexity.models.includes("sonar"));
});