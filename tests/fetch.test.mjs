import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// The fetch path refuses private addresses unless this is set; the suite serves local pages.
process.env.MODELMESH_WEB_ALLOW_PRIVATE = "1";
const mcp = await import("../bin/cc-mcp.mjs?fetch-suite");

const ARTICLE = [
  "<html><head><title>Fetched &amp; Cleaned</title>",
  '<meta property="og:description" content="A test page">',
  "</head><body>",
  "<nav><a href=\"/home\">Home</a> | <a href=\"/about\">About</a></nav>",
  "<main>",
  "<h1>Main heading</h1>",
  "<p>First paragraph with &amp;lt;literal&amp;gt; entities and &amp; amp text.</p>",
  "<h2>Usage</h2>",
  "<ul><li>one</li><li>two</li></ul>",
  "<table><tr><th>Name</th><th>Value</th></tr><tr><td>alpha</td><td>1</td></tr></table>",
  "<pre>function main() {\n  return 42;\n}</pre>",
  '<p><a href="/docs/start">Getting started</a> and <a href="#skip">anchor</a> and <a href="mailto:x@y.z">mail</a></p>',
  "</main>",
  "<footer>footer junk</footer>",
  "<aside>sidebar junk</aside>",
  "</body></html>",
].join("");

test("htmlToText keeps structure: headings, lists, tables and code", () => {
  const { title, description, text } = mcp.htmlToText(ARTICLE, "https://example.test/page");
  assert.equal(title, "Fetched & Cleaned");
  assert.equal(description, "A test page");
  assert.match(text, /^# Main heading/);
  assert.match(text, /## Usage/);
  assert.match(text, /^- one$/m);
  assert.match(text, /Name \| Value/);
  assert.match(text, /alpha \| 1/);
  assert.match(text, /```\nfunction main\(\) \{\n  return 42;\n\}/);
  assert.match(text, /Getting started \(https:\/\/example\.test\/docs\/start\)/);
  assert.doesNotMatch(text, /anchor \(/);
  assert.doesNotMatch(text, /mail \(/);
});

test("htmlToText drops navigation and footer boilerplate", () => {
  const { text } = mcp.htmlToText(ARTICLE, "https://example.test/page");
  assert.doesNotMatch(text, /Home|About|footer junk|sidebar junk/);
});

test("htmlToText decodes entities exactly once", () => {
  const { text } = mcp.htmlToText("<p>&amp;lt;tag&amp;gt; &amp;amp; &amp;copy;</p>");
  // One pass only: "&amp;lt;" becomes the literal text "&lt;", not "<".
  assert.match(text, /&lt;tag&gt; &amp; &copy;/);
});

test("htmlToText falls back to h1 and base href", () => {
  const { title, text } = mcp.htmlToText(
    '<html><body><base href="https://base.test/root/"><h1>Heading title</h1><a href="next">Next</a></body></html>');
  assert.equal(title, "Heading title");
  assert.match(text, /Next \(https:\/\/base\.test\/root\/next\)/);
});

test("htmlToText removes repeated consecutive lines", () => {
  const { text } = mcp.htmlToText("<p>same</p><p>same</p><p>same</p><p>other</p>");
  assert.equal(text.split("\n").filter((l) => l === "same").length, 1);
});

test("jsonToText pretty-prints JSON and leaves invalid JSON alone", () => {
  assert.match(mcp.jsonToText('{"a":1,"b":[2]}'), /"a": 1/);
  assert.equal(mcp.jsonToText("not json"), "not json");
});

test("challenge detection recognises JavaScript walls but not ordinary prose", () => {
  assert.equal(mcp.isChallengePage(200, "<html>In order to continue, please enable javascript</html>"), true);
  assert.equal(mcp.isChallengePage(200, "<html>Our systems have detected unusual traffic from your computer network</html>"), true);
  assert.equal(mcp.isChallengePage(200, "<p>This article explains how captcha systems work, in depth.</p>" + "x".repeat(70000)), false);
  assert.equal(mcp.isChallengePage(200, "<p>verify you are human</p>"), true);
  assert.equal(mcp.isChallengePage(403, "<html>nope</html>"), true);
});

// ---------------------------------------------------------------------------
// Live local server
// ---------------------------------------------------------------------------

const pages = {
  "/article": { type: "text/html; charset=utf-8", body: ARTICLE },
  "/json": { type: "application/json", body: JSON.stringify({ hello: "world", n: 2 }) },
  "/wall": { type: "text/html", body: "<html><body>Please click here if you are not redirected within a few seconds.</body></html>" },
  "/meta": { type: "text/html", body: '<html><head><meta http-equiv="refresh" content="0; url=/article"></head><body>redirecting</body></html>' },
};

let server;
let port;
test.before(async () => {
  server = http.createServer((req, res) => {
    const route = pages[req.url];
    if (route) { res.writeHead(200, { "content-type": route.type }); return res.end(route.body); }
    res.writeHead(404); res.end("missing");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
test.after(async () => { await new Promise((r) => server.close(r)); });

test("webFetch follows a meta refresh and extracts structured content", async () => {
  const out = await (await import("../bin/cc-mcp.mjs?fetch-suite-2")).webFetch("http://127.0.0.1:" + port + "/meta", { maxChars: 4000 });
  assert.equal(out.status, 200);
  assert.match(out.url, /\/article$/);
  assert.equal(out.title, "Fetched & Cleaned");
  assert.match(out.text, /# Main heading/);
  assert.match(out.text, /UNTRUSTED WEB CONTENT/);
});

test("webFetch pretty-prints JSON APIs", async () => {
  const out = await mcp.webFetch("http://127.0.0.1:" + port + "/json", { maxChars: 2000 });
  assert.equal(out.status, 200);
  assert.match(out.text, /"hello": "world"/);
});

test("webFetch reports a JavaScript wall instead of returning it as content", async () => {
  await assert.rejects(
    () => mcp.webFetch("http://127.0.0.1:" + port + "/wall", { maxChars: 2000 }),
    /blocked by a bot check/i,
  );
});
