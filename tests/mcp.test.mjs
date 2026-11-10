import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const mcp = await import("../bin/cc-mcp.mjs");

test("htmlToText extracts the title and strips markup", () => {
  const { title, text } = mcp.htmlToText("<html><head><title> Hi  <b>there</b> </title><style>p{}</style></head><body><p>Hello &amp; welcome</p><script>bad()</script></body></html>");
  assert.equal(title, "Hi there");
  assert.match(text, /Hello & welcome/);
  assert.doesNotMatch(text, /bad\(\)|p\{\}/);
});

test("bing redirect urls are decoded to the real target", () => {
  const encoded = Buffer.from("https://termux.dev/en/", "utf8").toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  assert.equal(mcp.unwrapBingUrl("https://www.bing.com/ck/a?u=a1" + encoded + "&ntb=1"), "https://termux.dev/en/");
  assert.equal(mcp.unwrapBingUrl("https://example.com/x"), "https://example.com/x");
});

test("bing result markup is parsed into title, url and snippet", () => {
  const html = '<ol><li class="b_algo"><h2><a href="https://termux.dev/en/">Termux | site</a></h2><p>Packages available.</p></li>' +
    '<li class="b_algo"><h2><a href="https://github.com/termux">GitHub</a></h2></li></ol>';
  const rows = mcp.parseBing(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, "https://termux.dev/en/");
  assert.equal(rows[0].title, "Termux | site");
  assert.match(rows[0].snippet, /Packages available/);
  assert.equal(rows[1].url, "https://github.com/termux");
});

test("mcp protocol exposes the two web tools and reports errors as tool results", async () => {
  const list = await mcp.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["web_search", "web_fetch"]);
  const init = await mcp.handleRequest({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
  assert.equal(init.result.serverInfo.name, "cc-termux");
  const bad = await mcp.handleRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "web_fetch", arguments: { url: "ftp://nope" } } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /http/i);
  assert.equal(mcp.handleRequest({ jsonrpc: "2.0", id: 4, method: "nope" }).error.code, -32601);
});

test("web_fetch returns readable text from a local page", async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><head><title>Local</title></head><body><h1>Heading</h1><p>Body text here.</p></body></html>");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const out = await mcp.webFetch("http://127.0.0.1:" + port + "/", { maxChars: 500 });
    assert.equal(out.status, 200);
    assert.equal(out.title, "Local");
    assert.match(out.text, /Heading/);
    assert.match(out.text, /Body text here/);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
