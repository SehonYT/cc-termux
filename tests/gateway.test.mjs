import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function startGateway(tmp, port, config) {
  const home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, ".cache", "cc-termux"), { recursive: true });
  const cfg = path.join(tmp, "config.json");
  fs.writeFileSync(cfg, JSON.stringify(config));
  const child = spawn(process.execPath, [path.join(root, "proxy", "server.mjs")], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CC_TERMUX_CONFIG: cfg },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, home };
}

async function waitHealth(port) {
  for (let i = 0; i < 300; i++) {
    try { const r = await fetch("http://127.0.0.1:" + port + "/health"); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("gateway reports a clear error when no provider is configured", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gw-"));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const { child } = startGateway(tmp, port, { listen: { host: "127.0.0.1", port }, active: "", providers: {}, routing: {} });
  try {
    assert.ok(await waitHealth(port), "gateway did not start");
    const res = await fetch("http://127.0.0.1:" + port + "/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cc-termux-local" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /no provider configured/);
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("gateway logs upstream failures to errors.log", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gw-"));
  const port = 19000 + Math.floor(Math.random() * 1000);
  const { child, home } = startGateway(tmp, port, {
    listen: { host: "127.0.0.1", port }, active: "dead",
    providers: { dead: { type: "openai", baseUrl: "http://127.0.0.1:9", path: "/chat/completions", model: "m", modelsById: {} } },
    routing: {},
  });
  try {
    assert.ok(await waitHealth(port), "gateway did not start");
    const res = await fetch("http://127.0.0.1:" + port + "/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cc-termux-local" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.ok(res.status >= 500);
    const log = path.join(home, ".cache", "cc-termux", "errors.log");
    assert.ok(fs.existsSync(log), "errors.log was not written");
    const entry = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").pop());
    assert.equal(entry.kind, "gateway");
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("gateway rejects requests without the local token", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gw-"));
  const port = 20000 + Math.floor(Math.random() * 1000);
  const { child } = startGateway(tmp, port, { listen: { host: "127.0.0.1", port }, active: "", providers: {}, routing: {} });
  try {
    assert.ok(await waitHealth(port), "gateway did not start");
    const res = await fetch("http://127.0.0.1:" + port + "/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 5, messages: [] }),
    });
    assert.equal(res.status, 401);
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("count_tokens ignores base64 image payloads", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gw-"));
  const port = 21000 + Math.floor(Math.random() * 1000);
  const { child } = startGateway(tmp, port, { listen: { host: "127.0.0.1", port }, active: "", providers: {}, routing: {} });
  try {
    assert.ok(await waitHealth(port), "gateway did not start");
    const image = "A".repeat(400000);
    const res = await fetch("http://127.0.0.1:" + port + "/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer cc-termux-local" },
      body: JSON.stringify({ model: "x", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: image } }, { type: "text", text: "hi" }] }] }),
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(j.input_tokens < 1000, "image payload must not be counted as text: " + j.input_tokens);
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("gateway translates upstream OpenAI tool calls into Anthropic tool_use blocks", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "m" }] })); }
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "{\"command\":\"echo hi\"}" } }] }, finish_reason: "tool_calls" }] }) + "\n\n");
      res.write("data: [DONE]\n\n"); res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gw-tool-"));
  const port = 22000 + Math.floor(Math.random() * 1000);
  const { child } = startGateway(tmp, port, {
    listen: { host: "127.0.0.1", port }, active: "p",
    providers: { p: { type: "openai", baseUrl: "http://127.0.0.1:" + upPort + "/v1", path: "/chat/completions", model: "m", modelsById: { m: { name: "m" } }, retries: 1 } },
    routing: {},
  });
  try {
    assert.ok(await waitHealth(port), "gateway did not start");
    const res = await fetch("http://127.0.0.1:" + port + "/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cc-termux-local" },
      body: JSON.stringify({ model: "m", max_tokens: 50, stream: true, messages: [{ role: "user", content: "run" }], tools: [{ name: "bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }] }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"type":"tool_use"/);
    assert.match(text, /"name":"bash"/);
    assert.match(text, /message_stop/);
  } finally {
    child.kill("SIGKILL"); upstream.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("discovery lists configured provider models and invalid JSON is rejected", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gw-disc-"));
  const port = 23000 + Math.floor(Math.random() * 1000);
  const { child } = startGateway(tmp, port, {
    listen: { host: "127.0.0.1", port }, active: "p",
    providers: { p: { type: "openai", baseUrl: "http://127.0.0.1:9", path: "/chat/completions", model: "m", modelsById: { m: { name: "Model M" }, n: { name: "Model N" } } } },
    routing: {},
  });
  try {
    assert.ok(await waitHealth(port), "gateway did not start");
    const res = await fetch("http://127.0.0.1:" + port + "/v1/models", { headers: { authorization: "Bearer cc-termux-local" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const ids = body.data.map((m) => m.id).sort();
    assert.deepEqual(ids, ["prov/p/m", "prov/p/n"]);
    const bad = await fetch("http://127.0.0.1:" + port + "/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cc-termux-local" }, body: "{bad",
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /invalid JSON/);
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});