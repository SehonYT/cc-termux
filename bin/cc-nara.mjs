#!/usr/bin/env node
// NaraRouter (https://router.bynara.id/v1): plan detection, tier filtering and usage.
// Limits and model tiers come from the public /api/plans endpoint, so no key is needed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NARA_BASE = "https://router.bynara.id/v1";
export const NARA_PLANS_URL = "https://router.bynara.id/api/plans";

export function naraCachePath() {
  const cache = process.env.CC_TERMUX_CACHE || path.join(os.homedir(), ".cache", "cc-termux");
  return path.join(cache, "nararouter.json");
}
export function readNaraCache() {
  try { return JSON.parse(fs.readFileSync(naraCachePath(), "utf8")); } catch (e) { return null; }
}
export function writeNaraCache(data) {
  try {
    const file = naraCachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  } catch (e) { }
  return data;
}

// The free plan is the one that costs nothing; everything else is a paid subscription.
export function isFreePlan(plan) {
  if (!plan) return false;
  const daily = Number(plan.price_daily_idr || 0);
  const weekly = Number(plan.price_weekly_idr || 0);
  // Price wins over the code: a plan named "free" that charges is not free.
  if (daily > 0 || weekly > 0) return false;
  return true;
}

export function parsePlans(payload) {
  const rows = (payload && (payload.data || payload.plans || payload)) || [];
  return (Array.isArray(rows) ? rows : [])
    .filter((p) => p && p.code && p.is_active !== false)
    .map((p) => ({
      code: String(p.code),
      name: String(p.name || p.code),
      free: isFreePlan(p),
      priceDailyIdr: Number(p.price_daily_idr || 0),
      priceWeeklyIdr: Number(p.price_weekly_idr || 0),
      tokenCapDaily: p.token_cap_daily == null ? null : Number(p.token_cap_daily),
      rpm: p.rpm_limit == null ? null : Number(p.rpm_limit),
      models: Array.isArray(p.models) ? p.models.map(String) : [],
      tagline: String(p.tagline || ""),
      description: String(p.description || ""),
    }))
    .sort((a, b) => a.priceDailyIdr - b.priceDailyIdr || a.code.localeCompare(b.code));
}

export async function fetchPlans({ fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const res = await fetchImpl(NARA_PLANS_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error("NaraRouter /api/plans HTTP " + res.status);
  return parsePlans(await res.json());
}

// Free tier = the models reachable on the zero-cost plan; paid = everything the paid plans add.
export function splitByTier(plans) {
  const free = new Set();
  const paid = new Set();
  for (const p of plans) {
    for (const m of p.models) (p.free ? free : paid).add(m);
  }
  const paidOnly = [...paid].filter((m) => !free.has(m));
  return { free: [...free].sort(), paidOnly: paidOnly.sort(), all: [...new Set([...free, ...paidOnly])].sort() };
}

export function filterModelsForTier(models, plans, tier = "free") {
  const { free, paidOnly, all } = splitByTier(plans);
  const allowed = new Set(tier === "paid" ? paidOnly : tier === "all" ? all : free);
  return models.filter((m) => allowed.has(m.id));
}

// GET /v1/models returns only the aliases the caller's plan entitles, so it is the
// authoritative answer once a key exists.
export async function fetchNaraModels(key, { fetchImpl = fetch, timeoutMs = 20000, tier = "free", plans = null } = {}) {
  const res = await fetchImpl(NARA_BASE + "/models", {
    headers: key ? { authorization: "Bearer " + key } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error.message; } catch (e) { }
    throw new Error("NaraRouter /models HTTP " + res.status + (detail ? " - " + detail : ""));
  }
  const j = await res.json();
  const rows = j.data || j.models || j;
  const models = (Array.isArray(rows) ? rows : []).map(normalizeNaraModel).filter((m) => m.id);
  const scoped = tier === "all" ? models : (plans ? filterModelsForTier(models, plans, tier) : models);
  const { free, paidOnly } = splitByTier(plans || []);
  for (const m of scoped) {
    // A model advertised on a free plan is free; one only paid plans list is paid; a model
    // that no plan mentions is still reachable (PAYG) but is not part of the free tier.
    m.tier = free.includes(m.id) ? "free" : paidOnly.includes(m.id) ? "paid" : "payg";
  }
  return scoped;
}

// The gateway reports context_window (not context_length) and prices in Rupiah per 1M
// tokens, so they are normalised to the fields the wizard and picker already understand.
export function normalizeNaraModel(m) {
  const ctx = Number(m.context_window || m.contextTokens || 0) || null;
  const inIdr = Number(m.input_idr_per_1m);
  const outIdr = Number(m.output_idr_per_1m);
  const toUsd = (v) => (Number.isFinite(v) && v > 0 ? +(v / NARA_IDR_PER_USD).toFixed(4) : null);
  return {
    id: String(m.id || m.name || ""),
    name: String(m.name || m.id || ""),
    contextTokens: ctx,
    maxOutputTokens: Number(m.max_output_tokens || 0) || null,
    inUsd: toUsd(inIdr),
    outUsd: toUsd(outIdr),
    inIdrPer1M: Number.isFinite(inIdr) ? inIdr : null,
    outIdrPer1M: Number.isFinite(outIdr) ? outIdr : null,
    vision: Boolean(m.vision),
    reasoning: Boolean(m.reasoning),
    webSearch: Boolean(m.web_search),
  };
}

// Prices arrive in Rupiah; the picker and the wizard speak USD, so convert at a fixed rate
// and keep the original figure alongside it.
export const NARA_IDR_PER_USD = 16000;

// The gateway reports limits through 429 bodies and response headers, not a usage endpoint,
// so consumption is reconstructed from what the gateway observes plus the plan's own caps.
export function quotaFromObservations(plans, observed) {
  const free = plans.find((p) => p.free) || null;
  const used = observed && observed.usedTokens ? observed.usedTokens : {};
  const groups = [];
  for (const plan of plans.filter((p) => !p.free)) {
    groups.push({
      id: plan.code,
      label: plan.name,
      plan,
      windows: {
        rpm: plan.rpm == null ? null : { limit: plan.rpm, used: used.rpm || 0, percent: Math.min(100, ((used.rpm || 0) / plan.rpm) * 100) },
        daily: plan.tokenCapDaily == null ? null : { limit: plan.tokenCapDaily, used: used.tokens || 0, percent: Math.min(100, ((used.tokens || 0) / plan.tokenCapDaily) * 100) },
      },
    });
  }
  return { free, groups };
}

export function formatUsage(plans, { active = null, observed = null } = {}) {
  const lines = [];
  const free = plans.find((p) => p.free);
  const current = active ? plans.find((p) => p.code === active || p.name.toLowerCase() === String(active).toLowerCase()) : null;
  if (current) {
    lines.push("plan: " + current.name + (current.free ? "  (free tier - no card)" : "  (paid, Rp" + current.priceDailyIdr + "/day or Rp" + current.priceWeeklyIdr + "/week)"));
  }
  lines.push("plans:");
  for (const p of plans) {
    const price = p.free ? "free" : "Rp" + p.priceDailyIdr + "/day";
    const cap = p.tokenCapDaily == null ? "fair use" : fmtTokens(p.tokenCapDaily) + " tok/day";
    const rpm = p.rpm == null ? "-" : p.rpm + " req/min";
    lines.push("  " + (p === current ? "* " : "  ") + p.code.padEnd(18) + price.padEnd(12) + rpm.padEnd(12) + cap.padEnd(18) + p.models.length + " models");
  }
  const { free: freeModels, paidOnly } = splitByTier(plans);
  lines.push("");
  lines.push("models: " + freeModels.length + " on the free tier, " + paidOnly.length + " added by paid plans");
  const seen = observed && observed.byClass;
  if (seen && Object.keys(seen).length) {
    lines.push("");
    lines.push("observed today (from gateway 429s):");
    for (const [id, row] of Object.entries(seen)) {
      lines.push("  " + id + ": " + row.kind + (row.at ? "  at " + row.at : ""));
    }
  } else {
    lines.push("");
    lines.push("observed limits: none yet (they are read from real 429 responses)");
  }
  if (free && freeModels.length) {
    lines.push("");
    lines.push("free tier models: " + freeModels.join(", "));
  }
  return lines.join("\n");
}

export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(v % 1e9 ? 1 : 0) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(v % 1e6 ? 1 : 0) + "M";
  if (v >= 1e3) return Math.round(v / 1e3) + "K";
  return String(v);
}

// 429 from this gateway is always type "rate_limited": a per-minute breach resets in a
// minute, a daily token breach only resets the next day, and the message says which.
export function classifyNara429(text) {
  const body = String(text || "");
  if (!/rate_limited|rate limit|quota/i.test(body)) return null;
  if (/daily|per day|token quota|quota is reached|quota exceeded for this model tier/i.test(body)) {
    return { verdict: "terminal", classes: ["daily"], retryAfterMs: null };
  }
  if (/per minute|rate limit|too many requests/i.test(body)) {
    return { verdict: "transient", classes: ["rpm"], retryAfterMs: null };
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] || "usage";
  if (cmd === "usage") {
    const state = readNaraCache() || {};
    fetchPlans().then((plans) => {
      writeNaraCache({ ...state, plans, plansAt: new Date().toISOString() });
      console.log(formatUsage(plans, { active: process.argv[3] || state.plan || null, observed: state.observed || null }));
    }).catch((e) => { console.error("usage: " + e.message); process.exit(1); });
  } else if (cmd === "plans") {
    fetchPlans().then((plans) => {
      if (process.argv.includes("--json")) { console.log(JSON.stringify(plans, null, 2)); return; }
      console.log(formatUsage(plans));
    }).catch((e) => { console.error("plans: " + e.message); process.exit(1); });
  } else {
    console.log("usage: cc-nara [usage|plans] [--json]");
  }
}
