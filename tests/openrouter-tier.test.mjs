import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const setup = fs.readFileSync(path.join(root, "bin", "cc-setup.mjs"), "utf8");

// openRouterTier and fetchOpenRouterModels live inside the wizard module, so they are
// evaluated in isolation with the smallest stub set that satisfies them.
function load() {
  const start = setup.indexOf("function openRouterTier(");
  const end = setup.indexOf("// The /v1beta/models endpoint");
  assert.ok(start > 0 && end > start, "OpenRouter helpers must stay in bin/cc-setup.mjs");
  const stub = "const dim = () => {}; const CACHE_DIR = '/tmp'; const fetchT = (u, o) => fetch(u, o);";
  return new Function("fs", stub + "\n" + setup.slice(start, end) + "; return { openRouterTier, fetchOpenRouterModels };")(
    { mkdirSync() {}, writeFileSync() {} },
  );
}
const { openRouterTier, fetchOpenRouterModels } = load();

const model = (id, prompt, completion, params) => ({
  id, name: id, context_length: 128000,
  pricing: { prompt: String(prompt), completion: String(completion) },
  supported_parameters: params || ["tools"],
});

test("a zero-priced model is free even without the :free suffix", () => {
  assert.equal(openRouterTier(model("openrouter/free", 0, 0)), "free");
  assert.equal(openRouterTier(model("vendor/m:free", 0, 0)), "free");
  assert.equal(openRouterTier(model("google/lyria-3-pro-preview", 0, 0)), "free");
});

test("a priced model is paid regardless of its name", () => {
  assert.equal(openRouterTier(model("vendor/m", 0.0000005, 0.0000015)), "paid");
  assert.equal(openRouterTier(model("vendor/m:free", 0.0000005, 0)), "paid", ":free in the id does not override a real price");
  assert.equal(openRouterTier(model("vendor/m", "0", 0.4)), "paid", "one non-zero side is enough");
});

test("missing or malformed pricing does not crash the classifier", () => {
  assert.equal(openRouterTier({ id: "x" }), "paid");
  assert.equal(openRouterTier({ id: "x", pricing: {} }), "paid");
  assert.equal(openRouterTier({ id: "x", pricing: { prompt: null, completion: null } }), "paid");
});

test("fetchOpenRouterModels splits the catalog by tier", async () => {
  const catalog = {
    data: [
      model("vendor/paid-a", 0.0000005, 0.0000015),
      model("vendor/free-a:free", 0, 0),
      model("vendor/free-b:free", 0, 0, ["tools"]),
      model("vendor/free-notools:free", 0, 0, []),
    ],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => catalog });
  try {
    const free = await fetchOpenRouterModels("k", { tier: "free" });
    assert.deepEqual(free.map((m) => m.id), ["vendor/free-a:free", "vendor/free-b:free"],
      "free tier keeps zero-cost models and drops the ones that cannot call tools");
    assert.ok(free.every((m) => m.tier === "free"));

    const paid = await fetchOpenRouterModels("k", { tier: "paid" });
    assert.deepEqual(paid.map((m) => m.id), ["vendor/paid-a"]);

    const all = await fetchOpenRouterModels("k", { tier: "all" });
    assert.equal(all.length, 3, "all keeps both tiers but still drops tool-less free models");
    assert.deepEqual([...new Set(all.map((m) => m.tier))].sort(), ["free", "paid"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an OpenRouter refresh keeps the tier the provider was created with", () => {
  assert.match(setup, /if \(p\.tier && \/openrouter\\\.ai\/\.test\(p\.baseUrl \|\| ""\)\) return await fetchOpenRouterModels\(key, \{ tier: p\.tier \}\)/);
  assert.match(setup, /if \(opts\.tier\) p\.tier = opts\.tier;/, "the tier must be stored on the provider");
  assert.match(setup, /if \(m\.tier\) modelsById\[m\.id\]\.tier = m\.tier;/, "each model must carry its tier");
});

test("the wizard asks for a tier and honours CC_SETUP_TIER", () => {
  assert.match(setup, /async function askTier\(\)/);
  assert.match(setup, /free only/);
  assert.match(setup, /paid only/);
  assert.match(setup, /everything/);
  assert.match(setup, /const tier = kind === "openrouter" \? await askTier\(\) : undefined;/);
  assert.match(setup, /process\.env\.CC_SETUP_TIER/);
  assert.match(setup, /return a === "2" \|\| a === "paid" \? "paid" : a === "3" \|\| a === "all" \? "all" : "free";/);
});

test("free models that cannot call tools are reported, not silently kept", () => {
  assert.match(setup, /skipped " \+ skipped \+ " free model\(s\) that cannot call tools/);
  const filter = /const usable = arr\.filter\(m => m\.tier !== "free" \|\| m\.tools\);/;
  assert.match(setup, filter, "a free model without tool support is useless for Claude Code");
});
