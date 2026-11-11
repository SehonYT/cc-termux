import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = "cc-termux-local";
const AUTH = "Bearer " + TOKEN;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function startGateway(config) {
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gw-edge-"));
  const home = path.join(tmp, "home");
  const cache = path.join(home, ".cache", "cc-termux");
  fs.mkdirSync(cache, { recursive: true });
  const cfg = path.join(tmp, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ ...config, listen: { host: "127.0.0.1", port } }));
  const child = spawn(process.execPath, [path.join(root, "proxy", "server.mjs")], {
    // CC_TERMUX_CACHE is always explicit: on Windows the resolver would otherwise use
    // LOCALAPPDATA and the isolated home directory below would not be exercised.
    env: { ...process.env, HOME: home, USERPROFILE: home, CC_TERMUX_CONFIG: cfg, CC_TERMUX_CACHE: cache },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr = (stderr + c).slice(-20000); });
  let started = false;
  for (let i = 0; i < 300; i++) {
    try { const r = await fetch("http://127.0.0.1:" + port + "/health"); if (r.ok) { started = true; break; } } catch (e) {}
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!started) {
    child.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error("gateway did not start: " + stderr);
  }
  return { port, child, cfg, cache, tmp, stderr: () => stderr };
}

async function stopGateway(g) {
  if (g.child.exitCode === null && g.child.signalCode === null) {
    g.child.kill("SIGKILL");
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 2000);
      g.child.once("exit", () => { clearTimeout(t); resolve(); });
    });
  }
  fs.rmSync(g.tmp, { recursive: true, force: true });
}

async function withGateway(config, fn) {
  const g = await startGateway(config);
  try { return await fn(g); } finally { await stopGateway(g); }
}

async function api(port, pathname, { method = "POST", body, headers = {}, signal } = {}) {
  const h = { ...headers };
  if (method === "POST" && body !== undefined && h["content-type"] === undefined) h["content-type"] = "application/json";
  if (h.authorization === undefined) h.authorization = AUTH;
  const res = await fetch("http://127.0.0.1:" + port + pathname, { method, headers: h, body, signal });
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    text,
    json: () => JSON.parse(text),
  };
}

async function health(port) {
  const r = await fetch("http://127.0.0.1:" + port + "/health");
  assert.equal(r.status, 200);
  return r.json();
}

function assertAnthropicError(r, { status, type, message } = {}) {
  if (status !== undefined) assert.equal(r.status, status, "unexpected status: " + r.status + " " + r.text.slice(0, 200));
  assert.match(r.contentType, /application\/json/, "error response must be JSON");
  const j = r.json();
  assert.equal(j.type, "error");
  assert.equal(typeof j.error, "object");
  assert.equal(typeof j.error.type, "string");
  assert.ok(j.error.type.length > 0, "error.type must not be empty");
  assert.equal(typeof j.error.message, "string");
  if (type) assert.equal(j.error.type, type);
  if (message) assert.match(j.error.message, message);
  return j;
}

function parseSse(text) {
  const events = [];
  for (const chunk of text.split("\n\n")) {
    if (!chunk.trim()) continue;
    const ev = { event: null, data: null };
    let data = "";
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event: ")) ev.event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data += line.slice(6);
      else if (line.trim() && !line.startsWith(":")) throw new Error("unexpected SSE line: " + JSON.stringify(line));
    }
    if (!data) continue;
    ev.data = JSON.parse(data);
    events.push(ev);
  }
  return events;
}

function startFakeUpstream(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch (e) { body = null; }
      hits.push(body);
      handler(body, res, req);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, hits }));
  });
}

async function stopFakeUpstream(up) {
  if (!up) return;
  try { up.server.closeAllConnections?.(); } catch (e) {}
  try { up.server.close(); } catch (e) {}
}

function sendChatOk(res, content) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "chatcmpl-edge",
    choices: [{ message: { role: "assistant", content: content || "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  }));
}

function requestText(body) {
  try {
    const c = body.messages[0].content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const text = c.find((b) => b && b.type === "text");
      if (text) return text.text;
    }
  } catch (e) {}
  return "ok";
}

function okUpstream() {
  return startFakeUpstream((body, res) => sendChatOk(res, "ok"));
}

function openaiProvider(baseUrl, model, extra = {}) {
  return {
    type: "openai",
    baseUrl,
    path: "/v1/chat/completions",
    apiMode: "chat",
    noKey: true,
    model,
    modelsById: { [model]: { name: model } },
    retries: 1,
    ...extra,
  };
}

function messageBody(model, text, extra = {}) {
  const body = { max_tokens: 16, messages: [{ role: "user", content: text || "hi" }], ...extra };
  if (model !== undefined) body.model = model;
  return JSON.stringify(body);
}

// ---------------------------------------------------------------------------
// 1. Malformed request shapes must be client errors, never internal 500s.
// ---------------------------------------------------------------------------
test("malformed request bodies are rejected as invalid_request_error", async () => {
  const up = await okUpstream();
  try {
    await withGateway({ active: "p", routing: {}, providers: { p: openaiProvider("http://127.0.0.1:" + up.port, "m") } }, async (g) => {
      const cases = [
        ["raw null", "null"],
        ["raw array", "[]"],
        ["raw number", "7"],
        ["model number", JSON.stringify({ model: 42, max_tokens: 5, messages: [{ role: "user", content: "hi" }] })],
        ["model object", JSON.stringify({ model: { id: "m" }, max_tokens: 5, messages: [] })],
        ["messages object", JSON.stringify({ model: "m", max_tokens: 5, messages: {} })],
        ["message null entry", JSON.stringify({ model: "m", max_tokens: 5, messages: [null] })],
        ["message array entry", JSON.stringify({ model: "m", max_tokens: 5, messages: [[]] })],
        ["content number", JSON.stringify({ model: "m", max_tokens: 5, messages: [{ role: "user", content: 12 }] })],
        ["content block null", JSON.stringify({ model: "m", max_tokens: 5, messages: [{ role: "user", content: [null] }] })],
        ["system object", JSON.stringify({ model: "m", max_tokens: 5, system: { text: "x" }, messages: [] })],
        ["system null block", JSON.stringify({ model: "m", max_tokens: 5, system: [null], messages: [] })],
      ];
      for (const [name, raw] of cases) {
        const r = await api(g.port, "/v1/messages", { body: raw });
        assertAnthropicError(r, { status: 400, type: "invalid_request_error" });
        assert.equal(up.hits.length, 0, name + " must be rejected before reaching the upstream");
      }
      // A rejected request must not have changed config or killed the process.
      const cfg = JSON.parse(fs.readFileSync(g.cfg, "utf8"));
      assert.equal(cfg.active, "p");
      assert.ok(cfg.providers.p);
      assert.equal(g.child.exitCode, null);
      assert.equal((await health(g.port)).ok, true);
    });
  } finally {
    await stopFakeUpstream(up);
  }
});

// ---------------------------------------------------------------------------
// 2. Structurally odd but tolerable fields must be forwarded without crashing.
// ---------------------------------------------------------------------------
test("odd but well-formed fields are forwarded without crashing", async () => {
  const up = await okUpstream();
  try {
    await withGateway({ active: "p", routing: {}, providers: { p: openaiProvider("http://127.0.0.1:" + up.port, "m") } }, async (g) => {
      const cases = [
        ["no model", { max_tokens: 5, messages: [{ role: "user", content: "hi" }] }],
        ["empty messages", { model: "m", max_tokens: 5, messages: [] }],
        ["null content", { model: "m", max_tokens: 5, messages: [{ role: "user", content: null }] }],
        ["unknown block type", { model: "m", max_tokens: 5, messages: [{ role: "user", content: [{ type: "mystery", payload: { a: 1 } }, { type: "text", text: "hi" }] }] }],
        ["orphan tool_result", { model: "m", max_tokens: 5, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_missing", content: "result" }] }] }],
        ["invalid base64 image", { model: "m", max_tokens: 5, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "!!! not base64 !!!" } }] }] }],
        ["tools without schema", { model: "m", max_tokens: 5, messages: [{ role: "user", content: "hi" }], tools: [{ name: "shell" }, null, { name: "no_schema" }, { description: "no name" }] }],
        ["huge max_tokens", { model: "m", max_tokens: 1e12, messages: [{ role: "user", content: "hi" }] }],
        ["negative max_tokens", { model: "m", max_tokens: -5, messages: [{ role: "user", content: "hi" }] }],
        ["unicode model", { model: "\u6a21\u578b-\ud83d\ude80", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }],
        ["slashed model", { model: "vendor/model/extra", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }],
        ["colon model", { model: "model::variant", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }],
      ];
      for (const [name, body] of cases) {
        const r = await api(g.port, "/v1/messages", { body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        assert.equal(r.status, 200, name + " -> " + r.status + " " + r.text.slice(0, 300));
        const j = r.json();
        assert.equal(j.type, "message", name);
        assert.equal(j.role, "assistant", name);
        assert.ok(Array.isArray(j.content), name);
        // Every one of these models has no explicit route, so it falls back to the
        // active provider's default model.
        assert.equal(j.model, "m", name);
      }
      assert.equal(g.child.exitCode, null);
      assert.equal((await health(g.port)).ok, true);
    });
  } finally {
    await stopFakeUpstream(up);
  }
});

// ---------------------------------------------------------------------------
// 3. Routing lookups that name unknown providers must not break requests.
// ---------------------------------------------------------------------------
test("unknown provider refs fall back to the active provider", async () => {
  const up = await okUpstream();
  try {
    const cfg = {
      active: "p",
      routing: { "alias-model": "p2::m2" },
      providers: {
        p: openaiProvider("http://127.0.0.1:" + up.port, "m"),
        p2: openaiProvider("http://127.0.0.1:" + up.port, "m2"),
      },
    };
    await withGateway(cfg, async (g) => {
      const expectDefault = ["provswitch/ghost", "prov/ghost/m", "bare-model-that-matches-nothing", "a/b/c", "x::y"];
      for (const model of expectDefault) {
        const r = await api(g.port, "/v1/messages", { body: messageBody(model, "hi") });
        assert.equal(r.status, 200, model + " -> " + r.status + " " + r.text.slice(0, 200));
        assert.equal(r.json().model, "m", model + " must route to the active provider default");
      }
      const aliased = await api(g.port, "/v1/messages", { body: messageBody("alias-model", "hi") });
      assert.equal(aliased.status, 200);
      assert.equal(aliased.json().model, "m2", "a routing entry naming a live provider must still work");
      // No provider switch happened: unknown provswitch ids must not mutate config.
      const after = JSON.parse(fs.readFileSync(g.cfg, "utf8"));
      assert.equal(after.active, "p");
      assert.equal(after.override, undefined);
      assert.ok(after.providers.p && after.providers.p2);
      assert.equal((await health(g.port)).active, "p");
      assert.equal(g.child.exitCode, null);
    });
  } finally {
    await stopFakeUpstream(up);
  }
});

// ---------------------------------------------------------------------------
// 4. Override/routing entries pointing at a deleted provider.
// ---------------------------------------------------------------------------
test("override and routing entries naming a deleted provider degrade safely", async () => {
  const up = await okUpstream();
  try {
    const cfg = {
      active: "p",
      override: { provider: "ghost", model: "gm" },
      routing: { "routed-model": "ghost::gm", "plain-model": "ghost" },
      providers: { p: openaiProvider("http://127.0.0.1:" + up.port, "m") },
    };
    await withGateway(cfg, async (g) => {
      for (const model of ["routed-model", "plain-model", "claude-sonnet-4-6", "prov/ghost/gm"]) {
        const r = await api(g.port, "/v1/messages", { body: messageBody(model, "hi") });
        assert.equal(r.status, 200, model + " -> " + r.status + " " + r.text.slice(0, 200));
        assert.equal(r.json().model, "m");
      }
      const after = JSON.parse(fs.readFileSync(g.cfg, "utf8"));
      assert.equal(after.active, "p");
      assert.ok(after.providers.p);
      assert.equal(after.override.provider, "ghost", "an unchanged invalid override must be left alone");
      assert.equal(g.child.exitCode, null);
      assert.equal((await health(g.port)).ok, true);
    });
  } finally {
    await stopFakeUpstream(up);
  }
});

// ---------------------------------------------------------------------------
// 5. Provider switch while another request is in flight.
// ---------------------------------------------------------------------------
test("switching providers mid-flight keeps the gateway healthy and config valid", async () => {
  const slow = await startFakeUpstream((body, res) => {
    setTimeout(() => sendChatOk(res, "slow"), 600);
  });
  const fast = await startFakeUpstream((body, res) => sendChatOk(res, "fast"));
  try {
    const cfg = {
      active: "p",
      routing: {},
      providers: {
        p: openaiProvider("http://127.0.0.1:" + slow.port, "m"),
        p2: openaiProvider("http://127.0.0.1:" + fast.port, "m2"),
      },
    };
    await withGateway(cfg, async (g) => {
      const inFlight = api(g.port, "/v1/messages", { body: messageBody("m", "slow"), signal: AbortSignal.timeout(15000) });
      await new Promise((r) => setTimeout(r, 100));
      const switched = await api(g.port, "/v1/messages", { body: messageBody("provswitch/p2", "switch"), signal: AbortSignal.timeout(15000) });
      assert.equal(switched.status, 200);
      assert.equal(switched.json().model, "m2");
      const first = await inFlight;
      assert.equal(first.status, 200);
      assert.equal(first.json().model, "m", "an in-flight request keeps the route it started with");

      const h = await health(g.port);
      assert.equal(h.ok, true);
      assert.equal(h.active, "p2");
      assert.equal(h.override.provider, "p2");

      const after = JSON.parse(fs.readFileSync(g.cfg, "utf8"));
      assert.equal(after.active, "p2");
      assert.ok(after.providers.p && after.providers.p2, "providers must survive the switch");
      assert.equal(after.override.provider, "p2");
      assert.deepEqual(after.providers.p.modelsById, { m: { name: "m" } });
      const leftovers = fs.readdirSync(g.tmp).filter((f) => f.includes(".tmp"));
      assert.deepEqual(leftovers, [], "no temporary config file may be left behind");

      // A later request must use the new provider.
      const later = await api(g.port, "/v1/messages", { body: messageBody("m2", "after") });
      assert.equal(later.status, 200);
      assert.equal(later.json().model, "m2");

      // A burst of concurrent switches must still leave valid JSON behind.
      const burst = await Promise.all([
        api(g.port, "/v1/messages", { body: messageBody("provswitch/p", "s1") }),
        api(g.port, "/v1/messages", { body: messageBody("provswitch/p2", "s2") }),
        api(g.port, "/v1/messages", { body: messageBody("provswitch/p", "s3") }),
        api(g.port, "/v1/messages", { body: messageBody("provswitch/p2", "s4") }),
      ]);
      for (const r of burst) assert.equal(r.status, 200);
      const finalCfg = JSON.parse(fs.readFileSync(g.cfg, "utf8"));
      assert.ok(["p", "p2"].includes(finalCfg.active));
      assert.ok(finalCfg.providers.p && finalCfg.providers.p2);
      assert.equal((await health(g.port)).ok, true);
      assert.equal(g.child.exitCode, null);
    });
  } finally {
    await stopFakeUpstream(slow);
    await stopFakeUpstream(fast);
  }
});

// ---------------------------------------------------------------------------
// 6. Upstream misbehaviour: non-JSON, HTML, 401.
// ---------------------------------------------------------------------------
test("non-JSON, HTML and 401 upstream answers become well-formed Anthropic errors", async () => {
  const up = await startFakeUpstream((body, res) => {
    const mode = requestText(body);
    if (mode === "nonjson") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("this is not json"); }
    if (mode === "html200") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><body>not found</body></html>"); }
    if (mode === "html500") { res.writeHead(500, { "content-type": "text/html" }); return res.end("<html><body>bad gateway</body></html>"); }
    if (mode === "401") { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "invalid api key" } })); }
    sendChatOk(res, "ok");
  });
  try {
    await withGateway({ active: "p", routing: {}, providers: { p: openaiProvider("http://127.0.0.1:" + up.port, "m") } }, async (g) => {
      const nonJson = await api(g.port, "/v1/messages", { body: messageBody("m", "nonjson"), signal: AbortSignal.timeout(15000) });
      assert.ok(nonJson.status >= 500, "non-JSON 200 must not be relayed as success: " + nonJson.status);
      assertAnthropicError(nonJson);

      const html = await api(g.port, "/v1/messages", { body: messageBody("m", "html500"), signal: AbortSignal.timeout(15000) });
      assertAnthropicError(html, { status: 500 });

      const unauthorized = await api(g.port, "/v1/messages", { body: messageBody("m", "401"), signal: AbortSignal.timeout(15000) });
      assertAnthropicError(unauthorized, { status: 401, type: "authentication_error" });

      // An HTML error page returned with status 200 on a streaming request must not
      // produce a malformed stream either.
      const htmlStream = await api(g.port, "/v1/messages", { body: messageBody("m", "html200", { stream: true }), signal: AbortSignal.timeout(15000) });
      assert.equal(htmlStream.status, 200);
      assert.match(htmlStream.contentType, /event-stream/);
      const events = parseSse(htmlStream.text);
      assert.ok(events.some((e) => e.data.type === "message_start"));
      assert.ok(events.some((e) => e.data.type === "message_stop"));

      assert.equal(g.child.exitCode, null);
      assert.equal((await health(g.port)).ok, true);
    });
  } finally {
    await stopFakeUpstream(up);
  }
});

// ---------------------------------------------------------------------------
// 7. Degenerate but valid SSE streams.
// ---------------------------------------------------------------------------
test("degenerate SSE streams still produce valid Anthropic streams", async () => {
  const up = await startFakeUpstream((body, res) => {
    const mode = requestText(body);
    if (mode === "doneonly") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    if (mode === "malformed") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {this is not json}\n\n");
      res.write(": a comment line\n\n");
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }) + "\n\n");
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    if (mode === "empty") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end();
    }
    sendChatOk(res, "ok");
  });
  try {
    await withGateway({ active: "p", routing: {}, providers: { p: openaiProvider("http://127.0.0.1:" + up.port, "m") } }, async (g) => {
      for (const mode of ["doneonly", "malformed", "empty"]) {
        const r = await api(g.port, "/v1/messages", { body: messageBody("m", mode, { stream: true }), signal: AbortSignal.timeout(15000) });
        assert.equal(r.status, 200, mode + " -> " + r.status + " " + r.text.slice(0, 200));
        assert.match(r.contentType, /event-stream/);
        const events = parseSse(r.text);
        const types = events.map((e) => e.data.type);
        assert.ok(types.includes("message_start"), mode + " stream needs message_start: " + types);
        assert.ok(types.includes("message_stop"), mode + " stream needs message_stop: " + types);
        if (mode === "malformed") {
          const delta = events.find((e) => e.data.type === "content_block_delta" && e.data.delta && e.data.delta.text === "hi");
          assert.ok(delta, "the valid line after the malformed one must still be translated");
        }
      }
      assert.equal(g.child.exitCode, null);
      assert.equal((await health(g.port)).ok, true);
    });
  } finally {
    await stopFakeUpstream(up);
  }
});

// ---------------------------------------------------------------------------
// 8. Upstream dying mid-stream must never hang or crash the gateway.
// ---------------------------------------------------------------------------
test("an upstream that dies mid-stream yields an error, not a hang", async () => {
  const up = await startFakeUpstream((body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "partial" } }] }) + "\n\n");
    setTimeout(() => { try { res.destroy(); } catch (e) {} }, 20);
  });
  try {
    await withGateway({ active: "p", routing: {}, providers: { p: openaiProvider("http://127.0.0.1:" + up.port, "m") } }, async (g) => {
      const r = await api(g.port, "/v1/messages", { body: messageBody("m", "midstream", { stream: true }), signal: AbortSignal.timeout(15000) });
      if (r.status === 200) {
        assert.match(r.contentType, /event-stream/);
        const events = parseSse(r.text);
        assert.ok(events.some((e) => e.data.type === "message_stop" || e.data.type === "error"),
          "a truncated stream must end with message_stop or an error event");
      } else {
        assert.ok(r.status >= 500, "unexpected status " + r.status);
        assertAnthropicError(r);
      }
      assert.equal(g.child.exitCode, null);
      assert.equal((await health(g.port)).ok, true);
    });
  } finally {
    await stopFakeUpstream(up);
  }
});

// ---------------------------------------------------------------------------
// 9. An upstream that never responds must hit a timeout, not hold the request.
// ---------------------------------------------------------------------------
test("an upstream that never responds times out with a clean error", async () => {
  const up = await startFakeUpstream(() => { /* deliberately never respond */ });
  try {
    const cfg = {
      active: "p",
      routing: {},
      // timeoutMs makes the never-responding upstream deterministic in a test run.
      providers: { p: openaiProvider("http://127.0.0.1:" + up.port, "m", { timeoutMs: 300 }) },
    };
    await withGateway(cfg, async (g) => {
      const started = Date.now();
      const r = await api(g.port, "/v1/messages", { body: messageBody("m", "never"), signal: AbortSignal.timeout(8000) });
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 5000, "the gateway hung on a never-responding upstream for " + elapsed + "ms");
      assert.ok(r.status >= 500, "a timed-out upstream must not look like success: " + r.status);
      const j = assertAnthropicError(r);
      assert.match(j.error.message, /tim(e|ed|ing)?\s*-?\s*out/i, "the error should say the upstream timed out: " + j.error.message);
      assert.equal(g.child.exitCode, null);
      assert.equal((await health(g.port)).ok, true);
    });
  } finally {
    await stopFakeUpstream(up);
  }
});

// ---------------------------------------------------------------------------
// 10. HTTP surface: count_tokens, auth, HEAD, unknown path, content-type, size.
// ---------------------------------------------------------------------------
test("HTTP surface edge cases behave and do not take the gateway down", async () => {
  const up = await okUpstream();
  try {
    await withGateway({ active: "p", routing: {}, providers: { p: openaiProvider("http://127.0.0.1:" + up.port, "m") } }, async (g) => {
      const empty = await api(g.port, "/v1/messages/count_tokens", { body: "" });
      assert.equal(empty.status, 200);
      assert.equal(empty.json().input_tokens, 0);

      const badCount = await api(g.port, "/v1/messages/count_tokens", { body: "null" });
      assertAnthropicError(badCount, { status: 400, type: "invalid_request_error" });

      const big = await api(g.port, "/v1/messages/count_tokens", {
        body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(1024 * 1024) }] }),
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(big.status, 200);
      const tokens = big.json().input_tokens;
      assert.ok(Number.isFinite(tokens) && tokens > 1000 && tokens <= 1024 * 1024, "1MB message token estimate: " + tokens);

      const noAuth = await api(g.port, "/v1/models", { method: "GET", headers: { authorization: "" } });
      assertAnthropicError(noAuth, { status: 401, type: "authentication_error" });

      const models = await api(g.port, "/v1/models", { method: "GET" });
      assert.equal(models.status, 200);
      assert.ok(Array.isArray(models.json().data));

      const headHealth = await fetch("http://127.0.0.1:" + g.port + "/health", { method: "HEAD" });
      assert.equal(headHealth.status, 200);
      assert.equal(await headHealth.text(), "");

      const headModels = await fetch("http://127.0.0.1:" + g.port + "/v1/models", { method: "HEAD", headers: { authorization: AUTH } });
      assert.ok([200, 404].includes(headModels.status));

      const unknown = await api(g.port, "/v1/no-such-path", { body: "{}" });
      assertAnthropicError(unknown, { status: 404, type: "not_found_error" });

      const wrongType = await api(g.port, "/v1/messages", { body: JSON.stringify({ model: "m", messages: [] }), headers: { "content-type": "text/plain" } });
      assertAnthropicError(wrongType, { status: 415, type: "invalid_request_error" });

      const oversized = await api(g.port, "/v1/messages", {
        body: JSON.stringify({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "y".repeat(11 * 1024 * 1024) }] }),
        signal: AbortSignal.timeout(60000),
      });
      assert.equal(oversized.status, 413, "an over-10MB body must be rejected");
      assert.ok(oversized.text.length < 4096, "the rejected body must not be echoed back");

      // Cheap request still works after the limit rejection.
      const good = await api(g.port, "/v1/messages", { body: messageBody("m", "after-oversize"), signal: AbortSignal.timeout(15000) });
      assert.equal(good.status, 200);
      assert.equal(good.json().model, "m");
      assert.equal(g.child.exitCode, null);
      assert.equal((await health(g.port)).ok, true);
    });
  } finally {
    await stopFakeUpstream(up);
  }
});

// ---------------------------------------------------------------------------
// 11. Concurrency against a dead upstream.
// ---------------------------------------------------------------------------
test("20 parallel requests to a dead upstream fail cleanly and the gateway recovers", async () => {
  const up = await okUpstream();
  try {
    const cfg = {
      active: "dead",
      routing: {},
      providers: {
        dead: openaiProvider("http://127.0.0.1:9", "d", { retries: 1 }),
        good: openaiProvider("http://127.0.0.1:" + up.port, "g", { retries: 1 }),
      },
    };
    await withGateway(cfg, async (g) => {
      const started = Date.now();
      const responses = await Promise.all(Array.from({ length: 20 }, () =>
        api(g.port, "/v1/messages", { body: messageBody("dead-model", "x"), signal: AbortSignal.timeout(20000) })));
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 15000, "20 dead-upstream requests took " + elapsed + "ms");
      for (const r of responses) {
        assert.ok(r.status >= 500, "dead upstream must not look successful: " + r.status);
        assertAnthropicError(r);
      }
      assert.equal(g.child.exitCode, null);
      assert.equal((await health(g.port)).ok, true);
      // One request to a live provider still works afterwards.
      const good = await api(g.port, "/v1/messages", { body: messageBody("prov/good/g", "recover"), signal: AbortSignal.timeout(15000) });
      assert.equal(good.status, 200);
      assert.equal(good.json().model, "g");
    });
  } finally {
    await stopFakeUpstream(up);
  }
});
