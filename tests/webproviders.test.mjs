import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wp = await import("../bin/cc-webproviders.mjs");
const antigravity = await import("../proxy/antigravity.mjs");

// Every test that touches web.json gets its own config dir.
function withConfig(cfg, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-web-"));
  const prev = process.env.CC_TERMUX_CONFIG;
  process.env.CC_TERMUX_CONFIG = path.join(tmp, "config.json");
  try {
    if (cfg) wp.writeWebConfig(cfg);
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CC_TERMUX_CONFIG; else process.env.CC_TERMUX_CONFIG = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const stub = (status, body) => async () => ({ ok: status < 400, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

test("the chain always ends with the built-in scraper", () => {
  withConfig({}, () => {
    const chain = wp.resolveChain("search", {});
    assert.equal(chain[chain.length - 1], "local", "the local scraper is always the last resort");
    assert.deepEqual(chain, ["tavily", "local"], "Tavily works keyless, so it leads even with no keys");
  });
  withConfig({ keys: { tavily: "t", brave: "b", jina: "j" } }, () => {
    assert.deepEqual(wp.resolveChain("search", wp.readWebConfig()), ["tavily", "brave", "jina", "local"]);
  });
});

test("the order follows the configured providers, not a hardcoded list", () => {
  withConfig({ chains: { search: ["jina", "tavily"] }, keys: { jina: "j" } }, () => {
    assert.deepEqual(wp.resolveChain("search", wp.readWebConfig()), ["jina", "tavily", "local"]);
  });
});

test("a provider that needs a key is skipped when it has none", () => {
  withConfig({ keys: { tavily: "t" } }, () => {
    const chain = wp.resolveChain("search", wp.readWebConfig());
    assert.deepEqual(chain, ["tavily", "local"], "brave and jina need keys and are skipped");
  });
});

test("keys can come from the environment instead of the file", () => {
  withConfig({}, () => {
    process.env.BRAVE_API_KEY = "from-env";
    try {
      assert.equal(wp.providerKey("brave", {}), "from-env");
      assert.ok(wp.resolveChain("search", {}).includes("brave"));
    } finally { delete process.env.BRAVE_API_KEY; }
  });
});

test("quota and auth failures are recognised so the chain moves on", () => {
  for (const [status, text] of [[429, "rate limit exceeded"], [402, "payment required"], [403, "forbidden"], [401, "invalid api key"], [200, "daily_cap_reached"], [200, "quota exceeded"]]) {
    assert.equal(wp.isQuotaError(status, text), true, status + " " + text);
  }
  assert.equal(wp.isQuotaError(200, "results for your query"), false);
});

test("Tavily search posts the query and normalises results", async () => {
  let seen = null;
  const out = await wp.tavilySearch("hello", {
    key: "tvly-x", maxResults: 3,
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, text: async () => JSON.stringify({ answer: "42", results: [{ title: "T", url: "https://a.test", content: "body" }] }) }; },
  });
  assert.equal(seen.url, "https://api.tavily.com/search");
  assert.equal(seen.opts.method, "POST");
  assert.equal(JSON.parse(seen.opts.body).max_results, 3);
  assert.equal(seen.opts.headers.authorization, "Bearer tvly-x");
  assert.equal(out.rows[0].url, "https://a.test");
  assert.equal(out.answer, "42");
});

test("Tavily falls back to keyless mode when no key is set", async () => {
  let headers = null;
  await wp.tavilySearch("hello", { key: "", fetchImpl: async (u, o) => { headers = o.headers; return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) }; } });
  assert.equal(headers["X-Tavily-Access-Mode"], "keyless");
  assert.equal(headers.authorization, undefined);
});

test("a quota response becomes a quota error the chain can act on", async () => {
  const cases = [
    ["tavily", () => wp.tavilySearch("x", { fetchImpl: stub(429, { error: { code: "daily_cap_reached", message: "limit reached" } }) })],
    ["brave", () => wp.braveSearch("x", { key: "k", fetchImpl: stub(429, { error: { code: "RATE_LIMITED" } }) })],
    ["jina", () => wp.jinaSearch("x", { fetchImpl: stub(402, { code: 402, message: "Payment required" }) })],
  ];
  for (const [name, run] of cases) {
    await assert.rejects(run, (e) => {
      assert.equal(e.quota, true, name + " must be flagged as a quota error so the chain moves on");
      assert.ok(e.message.length > 0, name + " must carry a message");
      return true;
    });
  }
});

test("Brave needs a key and sends it in the subscription header", async () => {
  await assert.rejects(() => wp.braveSearch("x", { key: "" }), /no API key/);
  let seen = null;
  const out = await wp.braveSearch("python", {
    key: "secret", maxResults: 5,
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, text: async () => JSON.stringify({ web: { results: [{ title: "T", url: "https://b.test", description: "d", extra_snippets: ["alt"] }] } }) }; },
  });
  assert.match(seen.url, /api\.search\.brave\.com\/res\/v1\/web\/search\?q=python/);
  assert.equal(seen.opts.headers["x-subscription-token"], "secret");
  assert.equal(out.rows[0].url, "https://b.test");
});

test("Jina reads both the JSON and the plain-text SERP shapes", async () => {
  const json = await wp.jinaSearch("q", {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ title: "T", url: "https://j.test", content: "c" }] }) }),
  });
  assert.equal(json.rows[0].url, "https://j.test");

  const text = await wp.jinaSearch("q", {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "Title: Termux\nURL Source: https://termux.dev/\nMarkdown Content:\nsome body text" }),
  });
  assert.equal(text.rows.length, 1);
  assert.equal(text.rows[0].url, "https://termux.dev/");
});

test("the chain falls through quota and errors to the local scraper", async () => {
  const calls = [];
  const out = await wp.searchChain("q", {
    chain: ["tavily", "brave", "jina", "local"],
    cfg: { keys: { tavily: "t", brave: "b", jina: "j" } },
    localSearch: async () => { calls.push("local"); return [{ title: "Local", url: "https://local.test", snippet: "" }]; },
    fetchImpl: async () => { throw new Error("unused"); },
  });
  assert.equal(out.provider, "local", "the local scraper answers when every remote fails");
  assert.equal(out.rows[0].url, "https://local.test");
  assert.deepEqual(out.attempts.map((a) => a.status), ["quota", "quota", "quota", "ok"]);
});

test("the chain stops at the first provider that answers", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ results: [{ title: "T", url: "https://tav.test", content: "c" }] }) });
  try {
    let localCalled = false;
    const out = await wp.searchChain("q", {
      chain: ["tavily", "local"],
      cfg: { keys: { tavily: "t" } },
      localSearch: async () => { localCalled = true; return []; },
    });
    assert.equal(out.provider, "tavily");
    assert.equal(localCalled, false, "the local scraper must not run when a remote provider answered");
    assert.deepEqual(out.attempts, [{ provider: "tavily", status: "ok", count: 1 }]);
  } finally { globalThis.fetch = realFetch; }
});

test("an empty remote result set falls through instead of winning", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) });
  try {
    const out = await wp.searchChain("q", {
      chain: ["tavily", "local"], cfg: { keys: { tavily: "t" } },
      localSearch: async () => [{ title: "L", url: "https://l.test", snippet: "" }],
    });
    assert.equal(out.provider, "local");
    assert.deepEqual(out.attempts.map((a) => a.status), ["empty", "ok"]);
  } finally { globalThis.fetch = realFetch; }
});

test("Antigravity uses Google Search grounding only when no tools are declared", () => {
  const req = (body, model = "gemini-3.8-flash") => antigravity.anthropicToGemini(body, model, { project_id: "p" }).request;
  const base = { messages: [{ role: "user", content: "hi" }], max_tokens: 100 };
  const tools = { ...base, tools: [{ name: "Bash", description: "run", input_schema: { type: "object", properties: {} } }] };

  assert.deepEqual(req(base).tools, [{ googleSearch: {} }], "a tool-free call is grounded");
  assert.equal(req(base).toolConfig, undefined, "grounding does not need a toolConfig");

  // Cloud Code answers 400 when googleSearch and functionDeclarations share one request,
  // and Claude Code always sends tools, so grounding must not be attached to them.
  const withTools = req(tools).tools;
  assert.equal(withTools.length, 1);
  assert.equal(withTools[0].googleSearch, undefined, "grounding must never be combined with function calling");
  assert.equal(withTools[0].functionDeclarations.length, 1);
  assert.deepEqual(req(tools).toolConfig, { functionCallingConfig: { mode: "VALIDATED" } });

  process.env.CC_TERMUX_ANTIGRAVITY_SEARCH = "0";
  try {
    assert.equal(req(base).tools, undefined, "search can be turned off entirely");
    assert.equal(req(base).toolConfig, undefined);
    assert.equal(req(tools).tools[0].functionDeclarations.length, 1, "tool calling still works with search off");
  } finally { delete process.env.CC_TERMUX_ANTIGRAVITY_SEARCH; }
});

test("an Antigravity request never sends both built-in and declared tools", () => {
  const body = {
    messages: [{ role: "user", content: "hi" }], max_tokens: 100,
    tools: [
      { name: "Bash", description: "run", input_schema: { type: "object", properties: {} } },
      { name: "Read", description: "read", input_schema: { type: "object", properties: {} } },
    ],
  };
  const r = antigravity.anthropicToGemini(body, "gemini-3.8-flash", { project_id: "p" }).request;
  const entry = r.tools[0];
  assert.ok(entry.functionDeclarations, "the declared tools are sent");
  assert.equal(entry.googleSearch, undefined, "googleSearch alongside them is a 400");
  assert.ok(!/include_server_side_tool_invocations/i.test(JSON.stringify(r)), "the flag Google names is not needed");
});

test("Google grounding joins the chain only when Antigravity is the active provider", () => {
  const cfg = {};
  assert.ok(!wp.resolveChain("search", cfg).includes("google"), "hidden for other providers");
  const ag = wp.resolveChain("search", cfg, { antigravity: true });
  assert.equal(ag[0], "google", "Google leads an Antigravity session");
  assert.deepEqual(ag, ["google", "tavily", "local"]);
  assert.equal(wp.PROVIDER_INFO.google.antigravityOnly, true);
  assert.equal(wp.PROVIDER_INFO.google.needsKey, false, "Google grounding needs no API key");
});

test("a custom chain keeps Google out unless Antigravity asked for it", () => {
  const cfg = { chains: { search: ["google", "jina"] }, keys: { jina: "j" } };
  assert.deepEqual(wp.resolveChain("search", cfg), ["jina", "local"]);
  assert.deepEqual(wp.resolveChain("search", cfg, { antigravity: true }), ["google", "jina", "local"]);
});

test("grounding parses the SSE frames Cloud Code returns", async () => {
  // Shape captured from a live response: text and metadata live under response.candidates.
  const frames = [
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "Mount Fuji is 3,776 m. " }] } }] } },
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "It is Japan's tallest." }] }, groundingMetadata: { webSearchQueries: ["tallest mountain japan"], groundingChunks: [{ web: { title: "britannica.com", uri: "https://vertexaisearch.cloud.google.com/x" } }] } }] } },
  ];
  const sse = frames.map((f) => "data: " + JSON.stringify(f)).join("\n") + "\n";
  const parsed = wp.parseGroundingSse(sse);
  assert.match(parsed.answer, /Mount Fuji is 3,776 m\./);
  assert.match(parsed.answer, /Japan's tallest/);
  assert.deepEqual(parsed.queries, ["tallest mountain japan"]);
  assert.equal(parsed.sources.length, 1);
  assert.equal(parsed.sources[0].title, "britannica.com");
});

test("grounding SSE parsing survives junk frames", () => {
  const sse = ["not a data line", "data: {oops", "data: " + JSON.stringify({ noCandidates: true }), "data: " + JSON.stringify({ response: { candidates: [] } })].join("\n");
  const parsed = wp.parseGroundingSse(sse);
  assert.equal(parsed.answer, "");
  assert.deepEqual(parsed.sources, []);
  assert.deepEqual(parsed.queries, []);
});

test("grounding reports a clean quota error so the chain can move on", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Resource has been exhausted" } }) });
  try {
    await assert.rejects(() => wp.antigravityGrounding("test", { model: "gemini-3.8-flash-high" }), (e) => {
      assert.equal(e.quota, true);
      return true;
    });
  } finally { globalThis.fetch = realFetch; }
});


test("the MCP can read the live config where the chain is decided", () => {
  // antigravityActive() reads the config file, and a missing fs import once made it throw,
  // silently dropping Google from the chain so every search fell back to the scrapers.
  const mcp = fs.readFileSync(path.join(root, "bin", "cc-mcp.mjs"), "utf8");
  assert.match(mcp, /^import fs from "node:fs";$/m, "cc-mcp must import node:fs for the chain check");
  assert.match(mcp, /import \{ configFile \} from "\.\/cc-paths\.mjs";/);
  assert.match(mcp, /resolveChain\("search", cfg, \{ antigravity: antigravityActive\(\) \}\)/);
  // A failure must be reported, never silently swallowed into a degraded chain.
  assert.match(mcp, /could not read config to pick the chain/);
  assert.ok(!/function antigravityActive\(\) \{\s*try \{[^}]*catch \(e\) \{ return false; \}/.test(mcp), "the catch must not be silent");
});

test("only Gemini models can ground, so the request is retargeted", () => {
  const wp = fs.readFileSync(path.join(root, "bin", "cc-webproviders.mjs"), "utf8");
  assert.match(wp, /export async function pickGeminiModel\(\)/);
  // Non-Gemini Antigravity models accept googleSearch but drop it silently.
  assert.match(wp, /const chosen = .*test\(requested\) \? requested : await pickGeminiModel\(\);/);
  assert.match(wp, /"gemini-3\.8-flash-high", "gemini-3\.8-flash-medium", "gemini-3\.8-flash-low"/);
});

test("the local scraper runs only when the chain reaches it", () => {
  const mcp = fs.readFileSync(path.join(root, "bin", "cc-mcp.mjs"), "utf8");
  // A speculative local scrape used to overwrite a successful remote answer.
  assert.match(mcp, /localSearch: async \(qq\) => \{ localOutcome = \(await localScrapers\(qq, maxResults\)\)\.outcome; return localOutcome\.results; \}/);
  assert.ok(!/const localOutcome = \(await localScrapers\(q, maxResults\)\)\.outcome;/.test(mcp), "the scrapers must not run speculatively");
  assert.match(mcp, /results: ran\.rows,/);
});

test("the installer asks once, then offers one list and one key prompt", () => {
  const inst = fs.readFileSync(path.join(root, "install.mjs"), "utf8");
  // One gate question before anything else.
  assert.match(inst, /Add a web search API\? \(y\/N\)/);
  // Then a single numbered list, not one prompt per provider.
  assert.match(inst, /Which one\?/);
  assert.match(inst, /Choose 1-3 or q/);
  assert.match(inst, /Paste your/);
  assert.ok(!/for \(const \[id, label, url, hint\] of \[/.test(inst), "the three-prompt loop is gone");
  // Declining is a complete answer, and the choice is remembered.
  assert.match(inst, /cfg\.asked = true/);
  assert.match(inst, /built-in scraper handles search/);
});

test("the installer and setup both offer the web providers", () => {
  const installer = fs.readFileSync(path.join(root, "install.mjs"), "utf8");
  const setup = fs.readFileSync(path.join(root, "bin", "cc-setup.mjs"), "utf8");
  for (const src of [installer, setup]) {
    assert.match(src, /Tavily/);
    assert.match(src, /Brave/);
    assert.match(src, /Jina/);
  }
  // The installer lists the URLs inline; setup reads them from the shared provider table.
  for (const url of ["app.tavily.com", "api-dashboard.search.brave.com", "jina.ai"]) {
    assert.ok(installer.includes(url), "installer must show the key URL for " + url);
    assert.ok(wp.PROVIDER_INFO[url.includes("tavily") ? "tavily" : url.includes("brave") ? "brave" : "jina"].keyUrl.includes(url),
      "the provider table must carry the key URL for " + url);
  }
  assert.match(setup, /info\.keyUrl/, "setup must print the key URL from the provider table");
  assert.match(installer, /async function askWebProviders\(\)/);
  assert.match(installer, /await askWebProviders\(\);/);
  assert.match(setup, /async function webProvidersFlow\(\)/);
  assert.match(setup, /if \(a === "w"\) \{ await webProvidersFlow\(\); continue; \}/, "the wizard must expose the web list");
});

test("the CLI exposes web status, key, clear and test", () => {
  const cli = fs.readFileSync(path.join(root, "bin", "cc-termux"), "utf8");
  assert.match(cli, /case "web": \{/);
  assert.match(cli, /cc-termux web key <tavily\|brave\|jina> <key>/);
  assert.match(cli, /if \(sub === "clear"\)/);
  assert.match(cli, /if \(sub === "test"\)/);
});
