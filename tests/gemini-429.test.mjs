import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The classifier lives inside the server module, which listens on import, so it is read
// from source and evaluated in isolation.
function load() {
  const src = fs.readFileSync(path.join(root, "proxy", "server.mjs"), "utf8");
  const start = src.indexOf("const GEMINI_METRIC_RE");
  const end = src.indexOf("// Compose the caller's abort signal");
  assert.ok(start > 0 && end > start, "classifier must stay in proxy/server.mjs");
  return new Function(src.slice(start, end) + "; return { classifyGemini429, retryHintMs };")();
}
const { classifyGemini429, retryHintMs } = load();

const metric = (name, limit, desc) =>
  "* Quota exceeded for metric: generativelanguage.googleapis.com/" + name + ", limit: " + limit +
  ", model: m, description: " + desc;
const DAY = metric("generate_content_free_tier_requests", 20, "Generate content requests per day limit exceeded on Free Tier.");
const MINUTE = metric("generate_content_free_tier_requests", 5, "Generate content requests per minute limit exceeded on Free Tier.");
const TOKENS = metric("generate_content_free_tier_input_token_count", 16000, "Generate content input tokens per minute limit exceeded on Free Tier.");

test("a per-day Gemini limit is terminal", () => {
  const v = classifyGemini429(DAY);
  assert.equal(v.verdict, "terminal");
  assert.deepEqual(v.classes, ["rpd"]);
});

test("a per-minute Gemini limit is transient", () => {
  assert.equal(classifyGemini429(MINUTE).verdict, "transient");
  assert.deepEqual(classifyGemini429(MINUTE).classes, ["rpm"]);
  assert.equal(classifyGemini429(TOKENS).verdict, "transient");
  assert.deepEqual(classifyGemini429(TOKENS).classes, ["tpm"]);
});

test("a body mixing per-minute and per-day metrics is terminal", () => {
  const mixed = "You exceeded your current quota.\n" + MINUTE + "\n" + TOKENS + "\n" + DAY;
  const v = classifyGemini429(mixed);
  assert.equal(v.verdict, "terminal", "a day limit anywhere wins");
  assert.ok(v.classes.includes("rpd") && v.classes.includes("rpm") && v.classes.includes("tpm"));
});

test("non-Gemini and unrecognised 429 bodies stay undecided", () => {
  assert.equal(classifyGemini429(null), null);
  assert.equal(classifyGemini429(""), null);
  assert.equal(classifyGemini429("Rate limit reached for gpt-4 in organization org-x."), null);
  assert.equal(classifyGemini429("generativelanguage.googleapis.com returned 429"), null, "no metric list, no verdict");
});

test("Google's retry hint is parsed, including hour/minute/second forms", () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 10, a + " should be about " + b);
  close(retryHintMs("Please retry in 21h15m47.838953365s."), (21 * 3600 + 15 * 60 + 47.839) * 1000);
  assert.equal(retryHintMs("Please retry in 12.5s."), 12500);
  assert.equal(retryHintMs("Please retry in 30s."), 30000);
  assert.equal(retryHintMs("Please retry in 5m30s."), 330000);
  assert.equal(retryHintMs("no hint here"), null);
  assert.equal(retryHintMs(DAY), null);
});

test("the retry loop retries a burst and fails fast on a day limit", async () => {
  let mode = "rpm";
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits++;
      const send = (status, payload) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
      const err = (message) => [{ error: { code: 429, status: "RESOURCE_EXHAUSTED", message } }];
      if (mode === "rpm" && hits <= 2) return send(429, err(MINUTE));
      if (mode === "rpd") return send(429, err(DAY));
      send(200, { id: "x", choices: [{ message: { content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-429-"));
  const home = path.join(tmp, "home");
  const cache = path.join(home, ".cache", "cc-termux");
  fs.mkdirSync(cache, { recursive: true });
  const cfg = path.join(tmp, "config.json");
  const port = 26000 + Math.floor(Math.random() * 400);
  fs.writeFileSync(cfg, JSON.stringify({
    listen: { host: "127.0.0.1", port }, active: "gemini",
    providers: { gemini: { type: "openai", baseUrl: "http://127.0.0.1:" + upstream.address().port + "/v1", path: "/chat/completions", model: "m", modelsById: { m: { name: "m" } }, retries: 5, retryBaseMs: 150, retryMaxMs: 20000, name: "gemini" } },
    routing: {},
  }));
  const child = spawn(process.execPath, [path.join(root, "proxy", "server.mjs")], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CC_TERMUX_CONFIG: cfg, CC_TERMUX_CACHE: cache },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stderr.on("data", (d) => logs.push(String(d)));
  try {
    let up = false;
    for (let i = 0; i < 300; i++) { try { if ((await fetch("http://127.0.0.1:" + port + "/health")).ok) { up = true; break; } } catch (e) { } await new Promise((r) => setTimeout(r, 50)); }
    assert.ok(up, "gateway did not start");
    const call = async () => {
      const started = Date.now();
      const res = await fetch("http://127.0.0.1:" + port + "/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cc-termux-local" },
        body: JSON.stringify({ model: "m", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
      });
      return { status: res.status, ms: Date.now() - started, text: await res.text() };
    };

    hits = 0; mode = "rpm"; logs.length = 0;
    const burst = await call();
    assert.equal(burst.status, 200, "a per-minute limit must be retried until it clears");
    assert.equal(hits, 3, "two 429s then success");
    assert.ok(burst.ms < 15000, "burst backoff must stay in the seconds range, took " + burst.ms + "ms");
    assert.match(logs.join(""), /rate limited \(per-minute\), retrying/);

    hits = 0; mode = "rpd"; logs.length = 0;
    const daily = await call();
    assert.equal(daily.status, 429, "a day limit must reach Claude Code as 429");
    assert.equal(hits, 1, "a day limit must not be retried");
    assert.ok(daily.ms < 3000, "a day limit must fail fast, took " + daily.ms + "ms");
    assert.match(logs.join(""), /quota exhausted for the day, not retrying/);

    const quota = JSON.parse(fs.readFileSync(path.join(cache, "quota.json"), "utf8")).gemini;
    assert.equal(quota.kind, "daily");
    assert.deepEqual(quota.classes, ["rpd"]);
    assert.equal(quota.limit, 20);
  } finally {
    child.kill("SIGKILL");
    upstream.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
