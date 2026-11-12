import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

import {
  parseBing,
  parseBrave,
  parseDuckDuckGo,
  parseDuckDuckGoLite,
  parseGoogle,
  parseStartpage,
  unwrapBingUrl,
  unwrapDuckDuckGoUrl,
  unwrapGoogleUrl,
  unwrapStartpageUrl,
  canonicalKey,
  queryTokens,
  coverage,
  isRelevant,
  isWall,
  mergeRanked,
  searchWeb,
  formatSearchReport,
  decodeEntities,
  plainText,
} from "../bin/cc-search.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "search");
const fixture = (name) => fs.readFileSync(path.join(fixtures, name), "utf8");

// Builds a fetchPage/decodeBody pair shaped like cc-mcp.mjs, without touching the network.
function fakeFetch(routes) {
  const calls = [];
  const fetchPage = async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const [match, res] of routes) {
      const hit = typeof match === "string" ? url.includes(match) : match.test(url);
      if (!hit) continue;
      const body = typeof res === "function" ? res({ url, opts }) : res;
      return {
        status: body.status == null ? 200 : body.status,
        headers: { "content-type": body.type || "text/html; charset=utf-8" },
        url,
        body: Buffer.from(body.body == null ? "" : body.body),
      };
    }
    return { status: 404, headers: {}, url, body: Buffer.from("not found") };
  };
  const decodeBody = (buf) => buf.toString("utf8");
  return { fetchPage, decodeBody, calls };
}

// ---------------------------------------------------------------------------
// Parsers against saved pages
// ---------------------------------------------------------------------------

test("parseDuckDuckGo extracts every result and rewrites redirect links", () => {
  const rows = parseDuckDuckGo(fixture("duckduckgo.html"));
  assert.equal(rows.length, 10);
  for (const row of rows) {
    assert.match(row.url, /^https:\/\//);
    assert.doesNotMatch(row.url, /duckduckgo\.com/);
    assert.ok(row.title.length > 5, "title for " + row.url);
    assert.equal(row.engine, "duckduckgo");
    assert.ok(row.key.includes("/"));
  }
  assert.match(rows[0].url, /realpython\.com/);
  assert.ok(rows[0].snippet.length > 20);
});

test("parseDuckDuckGoLite handles single-quoted class attributes", () => {
  const rows = parseDuckDuckGoLite(fixture("duckduckgo-lite.html"));
  assert.equal(rows.length, 10);
  for (const row of rows) {
    assert.match(row.url, /^https:\/\//);
    assert.doesNotMatch(row.url, /duckduckgo\.com/);
    assert.ok(row.title.length > 5);
    assert.ok(row.snippet.length > 0, "snippet for " + row.title);
  }
});

test("parseBing extracts b_algo cards and decodes /ck/a redirects", () => {
  const rows = parseBing(fixture("bing.html"));
  assert.equal(rows.length, 10);
  for (const row of rows) {
    assert.match(row.url, /^https?:\/\//);
    assert.doesNotMatch(row.url, /bing\.com\/ck/);
    assert.ok(row.title.length > 0);
    assert.equal(row.engine, "bing");
  }
  const redirect = Buffer.from("https://example.com/page", "utf8").toString("base64")
    .replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  assert.equal(unwrapBingUrl("https://www.bing.com/ck/a?u=a1" + redirect + "&ntb=1"), "https://example.com/page");
  assert.equal(unwrapBingUrl("https://www.bing.com/ck/a?u=garbage"), "");
});

test("parseGoogle reads result cards, ignores non-result links and unwraps /url?q=", () => {
  const rows = parseGoogle(fixture("google.html"));
  assert.equal(rows.length, 4, "the 'Related searches' card has no external URL");
  for (const row of rows) {
    assert.match(row.url, /^https:\/\//);
    assert.doesNotMatch(row.url, /google\.com\/url/);
    assert.ok(row.snippet.length > 10, "snippet for " + row.url);
    assert.equal(row.engine, "google");
  }
  assert.match(rows[0].url, /docs\.python\.org/);
});

test("parseGoogle has a fallback for pages without div.g containers", () => {
  const html = '<a href="/url?q=https://a.test/x&amp;sa=U"><h3>First result</h3></a>' +
    '<a href="/url?q=https://b.test/y&amp;sa=U"><h3>Second result</h3></a>';
  const rows = parseGoogle(html);
  assert.deepEqual(rows.map((r) => r.url), ["https://a.test/x", "https://b.test/y"]);
});

test("parseBrave reads SvelteKit result cards without splitting on nested classes", () => {
  const rows = parseBrave(fixture("brave.html"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, "https://realpython.com/async-io-python/");
  assert.match(rows[0].title, /asyncio/);
  assert.match(rows[0].snippet, /concurrent/);
  assert.equal(rows[0].engine, "brave");
});

test("parseStartpage reads result-title links with descriptions", () => {
  const rows = parseStartpage(fixture("startpage.html"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, "https://realpython.com/async-io-python/");
  assert.match(rows[0].title, /asyncio/);
  assert.match(rows[0].snippet, /concurrent/);
});

test("parsers discard non-http and internal links", () => {
  assert.deepEqual(parseDuckDuckGo('<a class="result__a" href="javascript:void(0)">x</a>'), []);
  assert.deepEqual(parseBrave('<div class="snippet svelte-x"><div class="result-content"><a href="/relative">x</a></div></div>'), []);
  assert.deepEqual(parseGoogle('<div class="g"><a href="/search?q=x"><h3>y</h3></a></div>'), []);
  assert.deepEqual(parseBing(""), []);
});

// ---------------------------------------------------------------------------
// URL normalisation
// ---------------------------------------------------------------------------

test("engine redirect formats are decoded", () => {
  assert.equal(unwrapGoogleUrl("/url?q=https://example.com/a%3Fb%3D1&sa=U&ved=1"), "https://example.com/a?b=1");
  assert.equal(unwrapGoogleUrl("https://www.google.com/url?q=https://example.com/b&sa=U"), "https://example.com/b");
  assert.equal(unwrapGoogleUrl("https://google.com/not-a-redirect"), "");
  assert.equal(unwrapDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fc&rut=1"), "https://example.com/c");
  assert.equal(unwrapDuckDuckGoUrl("https://duckduckgo.com/y.js?ad=1"), "");
  assert.equal(unwrapStartpageUrl("https://www.startpage.com/sp/search?query=x"), "");
  assert.equal(unwrapStartpageUrl("https://example.com/d"), "https://example.com/d");
});

test("canonicalKey removes tracking noise but keeps the real page identity", () => {
  assert.equal(canonicalKey("https://www.Example.com/a/b/?utm_source=x&utm_medium=y&id=7#frag"), "example.com/a/b?id=7");
  assert.equal(canonicalKey("https://example.com"), "example.com/");
  assert.equal(canonicalKey("https://example.com/a/"), "example.com/a");
  assert.equal(canonicalKey("mailto:x@y.z"), "");
  assert.equal(canonicalKey("not a url"), "");
  assert.equal(canonicalKey("https://example.com/a?gclid=1&fbclid=2"), "example.com/a");
});

test("decodeEntities and plainText behave", () => {
  assert.equal(decodeEntities("a &amp; b &#39;c&#39; &hellip;"), "a & b 'c' …");
  assert.equal(plainText("<b>Hello</b> &amp; <i>bye</i>"), "Hello & bye");
});

// ---------------------------------------------------------------------------
// Relevance and quarantine
// ---------------------------------------------------------------------------

test("queryTokens drops stopwords and duplicates", () => {
  assert.deepEqual(queryTokens("How to install the best Python asyncio tutorial"), ["install", "python", "asyncio", "tutorial"]);
  assert.deepEqual(queryTokens(""), []);
});

test("isRelevant keeps results that cover the query and drops single-token matches", () => {
  const tokens = queryTokens("python asyncio tutorial");
  assert.equal(isRelevant(tokens, { title: "Python asyncio tutorial", url: "https://x.test", snippet: "" }), true);
  assert.equal(isRelevant(tokens, { title: "Python tutorial", url: "https://x.test", snippet: "" }), true);
  assert.equal(isRelevant(tokens, { title: "Welcome to Python.org", url: "https://python.org", snippet: "" }), false);
  assert.equal(isRelevant(tokens, { title: "Mallorca boat trips", url: "https://boats.test", snippet: "" }), false);
  assert.equal(coverage(tokens, { title: "asyncio", url: "https://a.test", snippet: "python" }), 2 / 3);
  // Two-token queries: one matching token is enough.
  assert.equal(isRelevant(queryTokens("claude hooks"), { title: "Claude hooks", url: "https://a.test", snippet: "" }), true);
});

test("isWall recognises JavaScript walls, rate limits and normal pages", () => {
  assert.equal(isWall("google", 200, fixture("google-js-wall.html")), true);
  assert.equal(isWall("brave", 429, fixture("brave-wall.html")), true);
  assert.equal(isWall("google", 200, fixture("google.html")), false);
  assert.equal(isWall("bing", 200, "<html><title>python - Search</title><ol></ol></html>"), false);
});

// ---------------------------------------------------------------------------
// Merge and rank
// ---------------------------------------------------------------------------

test("mergeRanked dedupes by canonical URL and boosts cross-engine agreement", () => {
  const rows = (engine) => [
    { title: "Shared page", url: "https://shared.test/x?utm_source=" + engine, snippet: "s", key: "shared.test/x", engine },
    { title: "Only " + engine, url: "https://" + engine + ".test/", snippet: "s", key: engine + ".test/", engine },
  ];
  const merged = mergeRanked([
    { engine: "duckduckgo", results: rows("duckduckgo") },
    { engine: "brave", results: rows("brave") },
    { engine: "bing", results: rows("bing") },
  ], { maxResults: 10, tokens: [] });
  const shared = merged.find((r) => r.key === "shared.test/x");
  assert.ok(shared, "shared URL must survive");
  assert.deepEqual(shared.engines.sort(), ["bing", "brave", "duckduckgo"]);
  assert.equal(merged[0].key, "shared.test/x", "cross-engine agreement ranks first");
  assert.equal(merged.length, 4);
});

test("mergeRanked respects maxResults and skips unparseable URLs", () => {
  const merged = mergeRanked([{ engine: "google", results: [
    { title: "a", url: "https://a.test", snippet: "", key: "a.test/" },
    { title: "b", url: "javascript:void(0)", snippet: "" },
    { title: "c", url: "https://c.test", snippet: "", key: "c.test/" },
  ] }], { maxResults: 1, tokens: [] });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, "https://a.test");
});

// ---------------------------------------------------------------------------
// Orchestration against a fake network
// ---------------------------------------------------------------------------

const DDG = fixture("duckduckgo.html");
const BING = fixture("bing.html");
const STARTPAGE = fixture("startpage.html");
const GOOGLE = fixture("google.html");

function blocked(status = 429) { return { status, body: "<html><title>Too many requests</title></html>" }; }

test("searchWeb merges what works, reports what does not and quarantines a poisoned engine", async () => {
  const fake = fakeFetch([
    ["html.duckduckgo.com", { body: DDG }],
    ["google.com/search", blocked(429)],
    ["search.brave.com", blocked(429)],
    ["bing.com/search", { body: BING }],
    [/^https:\/\/www\.startpage\.com\/$/, { body: "<html><title>Startpage</title></html>" }],
  ]);
  const out = await searchWeb("python asyncio tutorial", { maxResults: 5, ...fake });
  assert.ok(out.results.length >= 4, "duckduckgo results must come through");
  assert.ok(out.results.every((r) => r.engines.includes("duckduckgo")));
  const byEngine = Object.fromEntries(out.report.map((r) => [r.engine, r]));
  assert.equal(byEngine.duckduckgo.status, "ok");
  assert.equal(byEngine.google.status, "blocked");
  assert.equal(byEngine.brave.status, "blocked");
  assert.equal(byEngine.bing.status, "irrelevant", "the Bing fixture answers a different query");
  assert.equal(byEngine.bing.count, 0);
  assert.match(out.summary, /bing: irrelevant/);
  assert.match(out.summary, /google: blocked/);
});

test("searchWeb falls back to Startpage when Google is blocked", async () => {
  let startpageTokenFetched = 0;
  const fake = fakeFetch([
    ["html.duckduckgo.com", { body: DDG }],
    ["google.com/search", blocked()],
    ["search.brave.com", blocked()],
    ["bing.com/search", { body: BING }],
    [/^https:\/\/www\.startpage\.com\/$/, () => { startpageTokenFetched++; return { body: '<form action="/sp/search"><input type="hidden" name="sc" value="tok123"></form>' }; }],
    ["startpage.com/sp/search", { body: STARTPAGE }],
  ]);
  const out = await searchWeb("python asyncio tutorial", { maxResults: 8, ...fake });
  assert.ok(startpageTokenFetched >= 1, "the token page must be fetched");
  const sp = out.report.find((r) => r.engine === "startpage");
  assert.equal(sp.status, "ok");
  assert.ok(sp.count >= 2);
  const mergedShared = out.results.find((r) => r.key === "realpython.com/async-io-python");
  assert.ok(mergedShared, "the same page from DuckDuckGo and Startpage must merge");
  assert.ok(mergedShared.engines.includes("startpage"));
  // The POST body carries the query and the token.
  const post = fake.calls.find((c) => c.opts.method === "POST");
  assert.ok(post, "startpage search must be a POST");
  assert.match(post.opts.body, /query=python\+asyncio\+tutorial/);
  assert.match(post.opts.body, /sc=tok123/);
});

test("searchWeb keeps going when an engine throws and reports it as an error", async () => {
  const fake = fakeFetch([
    ["html.duckduckgo.com", () => { throw new Error("connection reset"); }],
    ["lite.duckduckgo.com", { body: fixture("duckduckgo-lite.html") }],
    ["google.com/search", () => { throw new Error("boom"); }],
    ["search.brave.com", blocked()],
    ["bing.com/search", { body: BING }],
    [/^https:\/\/www\.startpage\.com\/$/, { body: "<html>no token</html>" }],
  ]);
  const out = await searchWeb("python asyncio tutorial", { maxResults: 3, ...fake });
  assert.ok(out.results.length > 0, "DuckDuckGo Lite must cover for the HTML endpoint");
  const ddg = out.report.find((r) => r.engine === "duckduckgo");
  assert.equal(ddg.status, "ok");
  const google = out.report.find((r) => r.engine === "google");
  assert.equal(google.status, "error");
});

test("searchWeb supports a configured SearXNG instance with JSON results", async () => {
  const payload = JSON.stringify({
    results: [
      { title: "asyncio documentation", url: "https://docs.python.org/3/library/asyncio.html", content: "python asyncio tutorial reference" },
      { title: "asyncio tutorial", url: "https://realpython.com/async-io-python/", content: "python asyncio tutorial walkthrough" },
    ],
  });
  const fake = fakeFetch([["searx.test/search", { type: "application/json", body: payload }]]);
  const out = await searchWeb("python asyncio tutorial", { maxResults: 5, engines: ["searxng"], searxUrl: "https://searx.test/", ...fake });
  assert.equal(out.results.length, 2);
  assert.ok(out.results.every((r) => r.engines.includes("searxng")));
  assert.match(fake.calls[0].url, /format=json/);
});

test("searchWeb uses the Google Custom Search API when a key is configured", async () => {
  const payload = JSON.stringify({
    items: [
      { title: "asyncio docs", link: "https://docs.python.org/3/library/asyncio.html", snippet: "python asyncio tutorial" },
      { title: "asyncio guide", link: "https://realpython.com/async-io-python/", snippet: "python asyncio tutorial" },
    ],
  });
  const fake = fakeFetch([["googleapis.com/customsearch", { type: "application/json", body: payload }]]);
  const out = await searchWeb("python asyncio tutorial", {
    maxResults: 5, engines: ["google"], googleApi: { key: "k", cx: "c" }, ...fake,
  });
  assert.equal(out.results.length, 2);
  const google = out.report.find((r) => r.engine === "google");
  assert.equal(google.status, "ok");
  assert.match(fake.calls[0].url, /key=k&cx=c/);
});

test("searchWeb ignores a SEARXNG-like engine that is not configured", async () => {
  const fake = fakeFetch([["html.duckduckgo.com", { body: DDG }]]);
  const out = await searchWeb("python asyncio tutorial", { maxResults: 3, engines: ["searxng"], ...fake });
  assert.equal(out.results.length, 0);
  assert.equal(out.report[0].status, "empty");
});

test("searchWeb validates its inputs and clamps maxResults", async () => {
  await assert.rejects(() => searchWeb("q", {}), /needs fetchPage and decodeBody/);
  await assert.rejects(() => searchWeb("", { fetchPage: async () => ({}), decodeBody: () => "" }), /query is required/);
  const fake = fakeFetch([["html.duckduckgo.com", { body: DDG }]]);
  const out = await searchWeb("python asyncio tutorial", { maxResults: 500, engines: ["duckduckgo"], ...fake });
  assert.equal(out.results.length, 10, "every parsed DuckDuckGo row is returned");
  assert.ok(out.results.length <= 20);
});

test("formatSearchReport omits healthy engines and lists the rest", () => {
  assert.equal(formatSearchReport([{ engine: "duckduckgo", status: "ok", count: 8, dropped: 0, message: "" }]), "");
  const text = formatSearchReport([
    { engine: "duckduckgo", status: "ok", count: 8, dropped: 0, message: "" },
    { engine: "google", status: "blocked", count: 0, dropped: 0, message: "HTTP 429 or bot check" },
    { engine: "bing", status: "irrelevant", count: 0, dropped: 10, message: "engine returned results for a different query" },
  ]);
  assert.match(text, /google: blocked - HTTP 429/);
  assert.match(text, /bing: irrelevant/);
  assert.doesNotMatch(text, /duckduckgo/);
});

test("the shared text helpers have exactly one implementation", async () => {
  // decodeEntities lived in both the MCP server and the search engine, and had already
  // drifted: a null input decoded to "null" in one and "" in the other.
  const mcpSrc = fs.readFileSync(path.join(root, "bin", "cc-mcp.mjs"), "utf8");
  const searchSrc = fs.readFileSync(path.join(root, "bin", "cc-search.mjs"), "utf8");
  assert.ok(!/function decodeEntities/.test(mcpSrc), "the MCP server must not define its own");
  assert.ok(!/function decodeEntities/.test(searchSrc), "nor must the search engine");
  assert.match(fs.readFileSync(path.join(root, "bin", "cc-text.mjs"), "utf8"), /export function decodeEntities/);

  // And both importers must behave identically, including on null.
  const a = await import("../bin/cc-mcp.mjs");
  const b = await import("../bin/cc-search.mjs");
  for (const v of [null, undefined, "", "&amp;x", "&#x27;", 42]) {
    assert.equal(a.decodeEntities(v), b.decodeEntities(v), "the two importers disagree on " + JSON.stringify(v));
  }
  assert.equal(a.decodeEntities(null), "", "a null must decode to empty, not the string null");
});
