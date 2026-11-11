import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nara = await import("../bin/cc-nara.mjs");
const server = fs.readFileSync(path.join(root, "proxy", "server.mjs"), "utf8");

// The live /api/plans shape, trimmed to the fields the module reads.
const PLANS = {
  data: [
    { code: "free", name: "Free", price_daily_idr: 0, price_weekly_idr: 0, token_cap_daily: 7000000, rpm_limit: 15, is_active: true, models: ["agnes-2.5-flash", "laguna-s-2.1"] },
    { code: "freemium", name: "Freemium", price_daily_idr: 5000, price_weekly_idr: 35000, token_cap_daily: 25000000, rpm_limit: 50, is_active: true, models: ["agnes-2.5-flash", "agnes-3-flash", "laguna-s-2.1", "step-5-preview", "stepfun-3.7-flash"] },
    { code: "freemium-max", name: "FreeMium Max", price_daily_idr: 10000, price_weekly_idr: 65000, token_cap_daily: 60000000, rpm_limit: 60, is_active: true, models: ["agnes-2.5-flash", "agnes-3-flash", "laguna-s-2.1", "step-5-preview", "stepfun-3.7-flash"] },
    { code: "gpt-fams-promo", name: "GPT Fams", price_daily_idr: 20000, price_weekly_idr: 140000, token_cap_daily: 25000000, rpm_limit: 50, is_active: true, models: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] },
    { code: "retired", name: "Retired", price_daily_idr: 100, token_cap_daily: 1, rpm_limit: 1, is_active: false, models: ["gone"] },
  ],
};

test("plans parse with their limits, sorted cheapest first, inactive dropped", () => {
  const plans = nara.parsePlans(PLANS);
  assert.deepEqual(plans.map((p) => p.code), ["free", "freemium", "freemium-max", "gpt-fams-promo"]);
  assert.equal(plans[0].free, true);
  assert.equal(plans[0].rpm, 15);
  assert.equal(plans[0].tokenCapDaily, 7000000);
  assert.equal(plans[0].priceDailyIdr, 0);
  assert.deepEqual(plans[0].models, ["agnes-2.5-flash", "laguna-s-2.1"]);
  assert.ok(plans.slice(1).every((p) => !p.free), "only the zero-cost plan is free");
});

test("a zero-cost plan is free even when its code is not literally 'free'", () => {
  assert.equal(nara.isFreePlan({ code: "starter", price_daily_idr: 0, price_weekly_idr: 0 }), true);
  assert.equal(nara.isFreePlan({ code: "free", price_daily_idr: 5000, price_weekly_idr: 0 }), false, "code alone is not enough when it is priced");
  assert.equal(nara.isFreePlan({ code: "x", price_daily_idr: 0, price_weekly_idr: 100 }), false);
  assert.equal(nara.isFreePlan(null), false);
});

test("tier split separates free models from those only paid plans add", () => {
  const { free, paidOnly, all } = nara.splitByTier(nara.parsePlans(PLANS));
  assert.deepEqual(free, ["agnes-2.5-flash", "laguna-s-2.1"]);
  assert.deepEqual(paidOnly, ["agnes-3-flash", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "step-5-preview", "stepfun-3.7-flash"]);
  assert.equal(all.length, 8, "a model on both tiers is counted once");
  assert.ok(!paidOnly.some((m) => free.includes(m)), "paid-only must not repeat a free model");
});

test("filterModelsForTier keeps only the requested tier", () => {
  const plans = nara.parsePlans(PLANS);
  const models = [
    { id: "agnes-2.5-flash" }, { id: "agnes-3-flash" }, { id: "gpt-5.6-luna" }, { id: "unknown-model" },
  ];
  assert.deepEqual(nara.filterModelsForTier(models, plans, "free").map((m) => m.id), ["agnes-2.5-flash"]);
  assert.deepEqual(nara.filterModelsForTier(models, plans, "paid").map((m) => m.id), ["agnes-3-flash", "gpt-5.6-luna"]);
  assert.deepEqual(nara.filterModelsForTier(models, plans, "all").map((m) => m.id), ["agnes-2.5-flash", "agnes-3-flash", "gpt-5.6-luna"]);
});

test("fetchNaraModels scopes the key's own model list to the tier and labels each row", async () => {
  const plans = nara.parsePlans(PLANS);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ data: [{ id: "agnes-2.5-flash", name: "Agnes 2.5 Flash", context_length: 131072 }, { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", context_length: 200000 }] }),
  });
  try {
    const free = await nara.fetchNaraModels("k", { tier: "free", plans });
    assert.deepEqual(free.map((m) => m.id), ["agnes-2.5-flash"]);
    assert.equal(free[0].contextTokens, 131072);
    assert.equal(free[0].tier, "free");

    const all = await nara.fetchNaraModels("k", { tier: "all", plans });
    assert.deepEqual(all.map((m) => m.id), ["agnes-2.5-flash", "gpt-5.6-sol"]);
    assert.deepEqual(all.map((m) => m.tier), ["free", "paid"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchNaraModels surfaces the gateway's own error message", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { type: "unauthorized", message: "A valid API key is required." } }) });
  try {
    await assert.rejects(() => nara.fetchNaraModels("bad", { tier: "free" }), /HTTP 401 - A valid API key is required/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the gateway classifies NaraRouter 429s: per-minute is transient, daily quota is terminal", () => {
  const start = server.indexOf("function classifyNara429(");
  const end = server.indexOf("// Google sometimes answers");
  assert.ok(start > 0 && end > start, "classifier must stay in proxy/server.mjs");
  const fn = new Function(server.slice(start, end) + "; return classifyNara429;")();
  assert.equal(fn('{"error":{"type":"rate_limited","message":"Rate limit exceeded. Please retry later."}}').verdict, "transient");
  assert.equal(fn('{"error":{"type":"rate_limited","message":"This model tier daily token quota is reached."}}').verdict, "terminal");
  assert.equal(fn('{"error":{"type":"rate_limited","message":"Daily token quota exceeded for this model tier."}}').verdict, "terminal");
  assert.equal(fn('{"error":{"type":"unauthorized","message":"A valid API key is required."}}'), null);
  assert.equal(fn(""), null);
  assert.equal(fn(null), null);
  // The shared dispatcher must consult both providers.
  assert.match(server, /function classifyRateLimit\(text\) \{\s*return classifyGemini429\(text\) \|\| classifyNara429\(text\);/);
  assert.match(server, /const gemini = classifyRateLimit\(bodyText\);/);
});

test("usage output mirrors the Antigravity quota view", () => {
  const text = nara.formatUsage(nara.parsePlans(PLANS), { active: "free" });
  assert.match(text, /free tier - no card/);
  assert.match(text, /15 req\/min/);
  assert.match(text, /7M tok\/day/);
  assert.match(text, /2 req\/min|\* free/);
  assert.match(text, /models: 2 on the free tier, 6 added by paid plans/);
  assert.match(text, /free tier models: agnes-2\.5-flash, laguna-s-2\.1/);
  assert.match(text, /observed limits: none yet/);
});

test("token counts format like the status line", () => {
  assert.equal(nara.fmtTokens(7000000), "7M");
  assert.equal(nara.fmtTokens(25000000), "25M");
  assert.equal(nara.fmtTokens(200000000), "200M");
  assert.equal(nara.fmtTokens(1500), "2K");
  assert.equal(nara.fmtTokens(0), "0");
});

test("the nararouter preset points at the documented endpoint", () => {
  const presets = JSON.parse(fs.readFileSync(path.join(root, "presets.json"), "utf8"));
  const p = presets.free.find((x) => x.id === "nararouter");
  assert.ok(p, "nararouter preset must exist");
  assert.equal(p.baseUrl, "https://router.bynara.id/v1");
  assert.equal(p.path, "/chat/completions");
  assert.equal(p.kind, "openai");
  assert.match(p.notes, /Free tier/);
});

test("the wizard and the CLI both know about NaraRouter", () => {
  const setup = fs.readFileSync(path.join(root, "bin", "cc-setup.mjs"), "utf8");
  const cli = fs.readFileSync(path.join(root, "bin", "cc-termux"), "utf8");
  assert.match(setup, /if \(kind === "nararouter"\)/);
  assert.match(setup, /kind === "openrouter" \|\| kind === "nararouter"/, "the tier prompt must cover both routers");
  assert.match(cli, /case "nararouter":/);
  assert.match(cli, /router\\\.bynara\\\.id/, "usage must detect the provider by base URL");
});
