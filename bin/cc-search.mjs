// Multi-engine web search for the cc-termux web MCP server.
//
// Why this exists: the HTML of each engine is machine-readable, but each one differs in
// markup, redirect format, and anti-bot behaviour. This module keeps one parser per engine,
// a relevance gate that throws away junk (Bing is known to answer with results for a
// different query from some networks), and a reciprocal-rank merge that turns several
// partial lists into one ranked list with a per-engine status report.
//
// Everything here is pure apart from the engine runners, which use an injected
// `fetchPage`/`decodeBody` pair so they can be unit-tested against saved HTML.
//
// Engine markup decoded from live responses (2026-01) and cross-checked against
// open-webSearch (MIT) and SearXNG engine selectors:
//   DuckDuckGo HTML  .result__a / .result__snippet          (redirect: /l/?uddg=)
//   DuckDuckGo Lite  a.result-link / td.result-snippet      (single-quoted class attrs)
//   Bing             li.b_algo > h2 > a / .b_caption p      (redirect: /ck/a?u=a1<base64url>)
//   Brave            #results .snippet .result-content a    (SvelteKit SSR)
//   Startpage        a.result-title.result-link > h2        (POST with sc token, Google index)
//   Google           div.MjjYud/div.g > a[href="/url?q="] > h3

// ---------------------------------------------------------------- small HTML helpers

const ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'",
  hellip: "…", mdash: "-", ndash: "-", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"',
  copy: "(c)", reg: "(r)", trade: "(tm)", middot: "·", bull: "•",
};

export function decodeEntities(s) {
  return String(s == null ? "" : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ""; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch (e) { return ""; } })
    .replace(/&([a-z]+|#\d+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : m));
}

// Visible text of an HTML fragment, without pulling in a DOM parser.
export function plainText(html) {
  return decodeEntities(
    String(html == null ? "" : html)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function attr(html, name) {
  const m = new RegExp(name + "\\s*=\\s*[\"']([^\"']*)[\"']", "i").exec(html);
  return m ? decodeEntities(m[1]) : "";
}

function firstAnchor(block) {
  return /<a\b([^>]*)>/i.exec(block) || [];
}

// ---------------------------------------------------------------- URL normalisation

const TRACKING = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "gclid", "gclsrc", "dclid", "fbclid", "msclkid", "twclid", "yclid", "igshid",
  "mc_cid", "mc_eid", "_ga", "_gl", "spm", "scm", "ref_src", "ref_url",
]);

export function unwrapGoogleUrl(href) {
  let h = decodeEntities(href).trim();
  if (h.startsWith("/url?")) h = "https://www.google.com" + h;
  try {
    const u = new URL(h, "https://www.google.com");
    if (!/(^|\.)google\./.test(u.hostname)) return h;
    for (const key of ["q", "url", "u"]) {
      const v = u.searchParams.get(key);
      if (v && /^https?:\/\//i.test(v)) return v;
    }
    return "";
  } catch (e) { return ""; }
}

export function unwrapBingUrl(href) {
  const h = decodeEntities(href).trim();
  if (h.startsWith("//")) return "https:" + h;
  try {
    const u = new URL(h, "https://www.bing.com");
    if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname.startsWith("/ck/a")) {
      const payload = (u.searchParams.get("u") || "").trim();
      const b64 = payload.startsWith("a1") ? payload.slice(2) : payload;
      if (b64) {
        try {
          const decoded = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").trim();
          if (/^https?:\/\//i.test(decoded)) return decoded;
        } catch (e) { }
      }
      return "";
    }
    return u.href;
  } catch (e) { return ""; }
}

export function unwrapDuckDuckGoUrl(href) {
  let h = decodeEntities(href).trim();
  if (h.startsWith("//")) h = "https:" + h;
  try {
    const u = new URL(h, "https://duckduckgo.com");
    const target = u.searchParams.get("uddg");
    if (target) return decodeURIComponent(target);
    if (/(^|\.)duckduckgo\.com$/.test(u.hostname)) return "";
    return u.href;
  } catch (e) { return ""; }
}

export function unwrapStartpageUrl(href) {
  let h = decodeEntities(href).trim();
  if (h.startsWith("//")) h = "https:" + h;
  try {
    const u = new URL(h, "https://www.startpage.com");
    if (/(^|\.)startpage\.com$/.test(u.hostname)) {
      for (const key of ["url", "u"]) {
        const v = u.searchParams.get(key);
        if (v && /^https?:\/\//i.test(v)) return decodeURIComponent(v);
      }
      return "";
    }
    return u.href;
  } catch (e) { return ""; }
}

// Key used to spot the same page in different engines. Display URL stays untouched.
export function canonicalKey(raw) {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return "";
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) u.searchParams.delete(key);
    }
    u.hash = "";
    let host = u.hostname.toLowerCase().replace(/^www\./, "");
    let path = u.pathname.replace(/\/+$/, "");
    if (!path) path = "/";
    const q = u.searchParams.toString();
    return host + path + (q ? "?" + q : "");
  } catch (e) { return ""; }
}

// ---------------------------------------------------------------- relevance gate

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at", "by", "with",
  "is", "are", "was", "were", "be", "how", "what", "why", "when", "where", "who",
  "best", "top", "new", "vs", "versus", "using", "use", "about", "from", "that", "this",
]);

export function queryTokens(query) {
  const seen = new Set();
  return String(query || "").toLowerCase().split(/[^a-z0-9+#._-]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
}

export function coverage(tokens, row) {
  if (!tokens.length) return 1;
  const hay = ((row.title || "") + " " + (row.snippet || "") + " " + (row.url || "")).toLowerCase();
  const matched = tokens.filter((t) => hay.includes(t));
  return matched.length / tokens.length;
}

// A result is kept when it covers most of the query. This is what removes engine junk:
// e.g. Bing answering "github actions workflow syntax" with the GitHub homepage covers 1/4
// and is dropped, while a real workflow-syntax page covers 4/4.
export function isRelevant(tokens, row, { minCoverage = 0.5, minMatched = 2 } = {}) {
  if (!tokens.length) return true;
  const matched = tokens.filter((t) => ((row.title || "") + " " + (row.snippet || "") + " " + (row.url || "")).toLowerCase().includes(t));
  if (tokens.length <= 2) return matched.length >= 1;
  return matched.length >= minMatched && matched.length / tokens.length >= minCoverage;
}

// ---------------------------------------------------------------- engine parsers

function pushResult(out, { title, url, snippet, engine }) {
  const cleanTitle = plainText(title).slice(0, 240);
  const cleanUrl = String(url || "").trim();
  if (!cleanTitle || !/^https?:\/\//i.test(cleanUrl)) return;
  const key = canonicalKey(cleanUrl);
  if (!key) return;
  out.push({ title: cleanTitle, url: cleanUrl, snippet: plainText(snippet || "").slice(0, 400), engine, key });
}

export function parseDuckDuckGo(html) {
  const src = String(html || "");
  const out = [];
  const blockRe = /<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [...src.matchAll(snippetRe)].map((m) => m[1]);
  let m, i = 0;
  while ((m = blockRe.exec(src))) {
    const tag = firstAnchor(m[0]);
    const href = attr(tag[1] || "", "href");
    const url = unwrapDuckDuckGoUrl(href);
    pushResult(out, { title: m[1], url, snippet: snippets[i] || "", engine: "duckduckgo" });
    i++;
  }
  return out;
}

// DuckDuckGo Lite uses single-quoted class attributes and a table layout.
export function parseDuckDuckGoLite(html) {
  const src = String(html || "");
  const out = [];
  const linkRe = /<a\b[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td\b[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;
  const snippets = [...src.matchAll(snippetRe)].map((m) => m[1]);
  let m, i = 0;
  while ((m = linkRe.exec(src))) {
    const tag = firstAnchor(m[0]);
    const href = attr(tag[1] || "", "href");
    const url = unwrapDuckDuckGoUrl(href);
    pushResult(out, { title: m[1], url, snippet: snippets[i] || "", engine: "duckduckgo" });
    i++;
  }
  return out;
}

export function parseBing(html) {
  const src = String(html || "");
  const out = [];
  const blocks = src.split(/<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>|\bid=["']b_algo["']/i).slice(1);
  for (const block of blocks) {
    // Stop at the next result list item so a block never borrows the next snippet.
    const body = block.split(/<li\b/i)[0];
    const a = /<h2[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(body);
    if (!a) continue;
    const href = attr(a[1], "href");
    const url = unwrapBingUrl(href);
    const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(body) || /class=["'][^"']*b_caption[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(body);
    pushResult(out, { title: a[2], url, snippet: p ? p[1] : "", engine: "bing" });
  }
  return out;
}

// Brave renders its result list as SvelteKit SSR: #results > .snippet > .result-content.
export function parseBrave(html) {
  const src = String(html || "");
  const out = [];
  // "snippet" must be a whole class token: "search-snippet-title" and "generic-snippet"
  // also contain that word and would otherwise split the result card.
  const blocks = src.split(/<div\b[^>]*class=["'](?:[^"']*\s)?snippet(?:\s[^"']*)?["'][^>]*>/i).slice(1);
  for (const block of blocks) {
    const contentAt = block.search(/class=["'][^"']*result-content/i);
    const content = contentAt >= 0 ? block.slice(contentAt) : block;
    const link = /<a\b([^>]*)>/i.exec(content);
    if (!link) continue;
    const href = attr(link[1], "href");
    if (!/^https?:\/\//i.test(href)) continue;
    const titleM = /class=["'][^"']*search-snippet-title[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(content) ||
      /class=["'][^"']*search-snippet-title[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(content);
    const descM = /class=["'][^"']*generic-snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(content);
    pushResult(out, { title: titleM ? titleM[1] : "", url: href, snippet: descM ? descM[1] : "", engine: "brave" });
  }
  return out;
}

export function parseStartpage(html) {
  const src = String(html || "");
  const out = [];
  const linkRe = /<a\b[^>]*class=["'][^"']*result-title[^"']*result-link[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(src))) {
    const tag = firstAnchor(m[0]);
    if (!tag[1]) continue;
    const href = attr(tag[1], "href");
    const url = unwrapStartpageUrl(href);
    if (!/^https?:\/\//i.test(url)) continue;
    const titleM = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(m[1]);
    const after = src.slice(linkRe.lastIndex, linkRe.lastIndex + 1200);
    const descM = /<p\b[^>]*class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(after);
    pushResult(out, { title: titleM ? titleM[1] : m[1], url, snippet: descM ? descM[1] : "", engine: "startpage" });
  }
  return out;
}

// Google's result markup has two shapes in the wild:
//   classic  <div class="g"><a href="/url?q=..."><h3>..</h3></a><div class="VwiC3b">snippet</div>
//   modern   <div class="MjjYud"><div class="g">... or <a jsname="UWckNb" href="/url?q=...">
export function parseGoogle(html) {
  const src = String(html || "");
  const out = [];
  // Split on result containers; keep everything until the next container.
  const parts = src.split(/<div\b[^>]*class=["'][^"']*(?:\bMjjYud\b|\bg\b)[^"']*["'][^>]*>/i).slice(1);
  for (const part of parts) {
    const body = part.split(/<div\b[^>]*class=["'][^"']*(?:\bMjjYud\b)[^"']*["'][^>]*>/i)[0];
    const link = /<a\b([^>]*href=["'][^"']+["'][^>]*)>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(body) ||
      /<a\b([^>]*)>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(body);
    if (!link) continue;
    const url = unwrapGoogleUrl(attr(link[1], "href"));
    const snip = /<div\b[^>]*class=["'][^"']*(?:VwiC3b|IsZvec|lyLwlc)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(body);
    pushResult(out, { title: link[2], url, snippet: snip ? snip[1] : "", engine: "google" });
  }
  // Fallback for pages where the containers differ: scan /url?q= anchors with an h3.
  if (!out.length) {
    const re = /<a\b([^>]*href=["'][^"']*\/url\?[^"']*["'][^>]*)>([\s\S]{0,600}?)<h3[^>]*>([\s\S]*?)<\/h3>/gi;
    let m;
    while ((m = re.exec(src))) {
      const url = unwrapGoogleUrl(attr(m[1], "href"));
      pushResult(out, { title: m[3], url, snippet: plainText(m[2]).slice(0, 300), engine: "google" });
    }
  }
  return out;
}

export const PARSERS = {
  google: parseGoogle,
  brave: parseBrave,
  duckduckgo: parseDuckDuckGo,
  duckduckgolite: parseDuckDuckGoLite,
  bing: parseBing,
  startpage: parseStartpage,
};

// ---------------------------------------------------------------- merge and rank

const ENGINE_WEIGHT = { google: 1.25, brave: 1.15, startpage: 1.1, duckduckgo: 1.0, bing: 0.9 };

// Reciprocal-rank fusion: agreement between engines beats a single high rank, which is a
// better signal for agents than any one engine's ordering.
export function mergeRanked(lists, { maxResults = 8, tokens = [] } = {}) {
  const byKey = new Map();
  for (const list of lists) {
    list.results.forEach((row, rank) => {
      const key = row.key || canonicalKey(row.url);
      if (!key) return;
      const weight = ENGINE_WEIGHT[list.engine] || 1;
      const score = weight / (60 + rank + 1);
      const existing = byKey.get(key);
      if (existing) {
        existing.score += score;
        existing.engines.add(list.engine);
        if (!existing.snippet && row.snippet) existing.row.snippet = row.snippet;
        if (row.snippet.length > existing.row.snippet.length) existing.row.snippet = row.snippet;
        if (row.title.length > existing.row.title.length) existing.row.title = row.title;
      } else {
        byKey.set(key, { key, row: { ...row }, score, engines: new Set([list.engine]) });
      }
    });
  }
  return [...byKey.values()]
    .map((e) => ({ ...e.row, engine: [...e.engines][0], engines: [...e.engines], score: e.score, coverage: coverage(tokens, e.row) }))
    .sort((a, b) => b.score - a.score || b.coverage - a.coverage)
    .slice(0, Math.max(1, maxResults));
}

// ---------------------------------------------------------------- engine requests

export const ENGINE_URLS = {
  google: (q) => "https://www.google.com/search?q=" + encodeURIComponent(q) + "&num=20&hl=en&gl=us&pws=0",
  brave: (q) => "https://search.brave.com/search?q=" + encodeURIComponent(q) + "&source=web",
  duckduckgo: (q) => "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q) + "&kl=us-en",
  duckduckgolite: (q) => "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q),
  bing: (q) => "https://www.bing.com/search?q=" + encodeURIComponent(q) + "&setlang=en&mkt=en-US&form=QBLH",
  startpage: () => "https://www.startpage.com/sp/search",
};

export const ENGINE_HEADERS = {
  google: {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    cookie: "CONSENT=YES+cb.20240101-00-p0.en+FX+111; SOCS=CAI",
  },
  brave: {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://duckduckgo.com/",
  },
  duckduckgo: { referer: "https://html.duckduckgo.com/", origin: "https://html.duckduckgo.com" },
  duckduckgolite: { referer: "https://lite.duckduckgo.com/" },
  bing: { "accept-language": "en-US,en;q=0.9" },
  startpage: { "accept-language": "en-US,en;q=0.9" },
};

export const WALL_PATTERNS = {
  google: /enable ?javascript|enablejs|unusual traffic|our systems have detected|update your browser|before you continue|consent\.google|sorry\/index|if you are not redirected/i,
  brave: /too many requests|rate limit|captcha|verify you are human/i,
  duckduckgo: /anomaly|challenge|unusual traffic|captcha/i,
  duckduckgolite: /anomaly|challenge|captcha/i,
  bing: /captcha|verify you are human/i,
  startpage: /captcha|verify you are human|security check/i,
};

export function isWall(engine, status, html) {
  if (status === 429 || status === 403) return true;
  const head = String(html || "").slice(0, 8000);
  return (WALL_PATTERNS[engine] || /captcha/i).test(head);
}

// ---------------------------------------------------------------- orchestration

const DEFAULT_ENGINES = ["duckduckgo", "google", "brave", "bing"];

// Optional backends that need configuration. SEARXNG gives Google/Bing/Brave results through
// an instance the user controls (search.formats must include "json"); Google's own JSON API
// needs a key and a custom-search engine id.
function configuredEngines(searxUrl) {
  const list = DEFAULT_ENGINES.slice();
  if (searxUrl) list.push("searxng");
  return list;
}

// Startpage answers with Google's index and is the fallback when google.com itself
// refuses to serve HTML (its "enable JavaScript" wall). The token is valid for a while.
let startpageToken = null;
let startpageTokenAt = 0;
const STARTPAGE_TOKEN_TTL = 30 * 60 * 1000;

function finalizeEngine(engine, rows, attempts, tokens) {
  const kept = [];
  let dropped = 0;
  for (const row of rows) {
    if (isRelevant(tokens, row)) kept.push(row); else dropped++;
  }
  const notes = (attempts || []).filter((a) => a.status !== "ok");
  const blocked = notes.find((a) => a.status === "blocked");
  // Engine-level quarantine: if most of an engine's page does not match the query, that
  // engine is answering a different question (Bing does this from some networks/caches).
  // Keeping the few coincidental matches would inject junk into the merged ranking.
  const quarantined = rows.length >= 3 && kept.length / rows.length < 0.5;
  let status = "ok";
  if (!kept.length || quarantined) {
    if (quarantined || dropped) status = "irrelevant";
    else if (blocked) status = "blocked";
    else if (notes.length) status = notes[0].status;
    else status = "empty";
  }
  const message = status === "blocked" ? (blocked.message || "blocked")
    : status === "irrelevant" ? (quarantined ? "engine returned results for a different query (" + dropped + "/" + rows.length + " unrelated); ignored" : dropped + " unrelated results discarded")
      : status === "error" ? (notes[0] && notes[0].message) || ""
        : "";
  const finalKept = quarantined ? [] : kept;
  return { report: { engine, status, count: finalKept.length, dropped: quarantined ? rows.length : dropped, attempts: attempts || [], message }, list: finalKept.length ? { engine, results: finalKept } : null };
}

export async function searchWeb(query, { maxResults = 8, engines, fetchPage, decodeBody, timeoutMs = 7000, searxUrl = "", googleApi = null } = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("query is required");
  if (typeof fetchPage !== "function" || typeof decodeBody !== "function") {
    throw new Error("searchWeb needs fetchPage and decodeBody");
  }
  const requested = (Array.isArray(engines) && engines.length ? engines : configuredEngines(searxUrl))
    .map((e) => String(e).toLowerCase().trim())
    .filter((e, i, a) => e && a.indexOf(e) === i);
  const tokens = queryTokens(q);
  const started = Date.now();

  const fetchEngine = async (url, opts = {}) => {
    const res = await fetchPage(url, { timeoutMs, skipUaRetry: true, ...opts });
    return { res, html: decodeBody(res.body, res.headers["content-type"]) };
  };

  const getStartpageToken = async () => {
    if (startpageToken && Date.now() - startpageTokenAt < STARTPAGE_TOKEN_TTL) return startpageToken;
    const { res, html } = await fetchEngine("https://www.startpage.com/", { headers: ENGINE_HEADERS.startpage });
    if (isWall("startpage", res.status, html)) return null;
    const m = /name=["']sc["'][^>]*value=["']([^"']+)["']/i.exec(html) || /value=["']([^"']+)["'][^>]*name=["']sc["']/i.exec(html);
    if (!m) return null;
    startpageToken = m[1];
    startpageTokenAt = Date.now();
    return startpageToken;
  };

  const run = async (engine) => {
    const attempts = [];
    const parse = PARSERS[engine] || (() => []);
    try {
      if (engine === "startpage") {
        const token = await getStartpageToken();
        if (!token) return { engine, rows: [], attempts: [{ engine, status: "blocked", message: "no search token (anti-bot page)" }] };
        const body = new URLSearchParams({ query: q, cat: "web", t: "device", sc: token, abp: "1", abd: "1", abe: "1" }).toString();
        const { res, html } = await fetchEngine(ENGINE_URLS.startpage(q), {
          method: "POST",
          body,
          headers: {
            ...ENGINE_HEADERS.startpage,
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://www.startpage.com",
            referer: "https://www.startpage.com/",
          },
        });
        if (isWall("startpage", res.status, html)) {
          return { engine, rows: [], attempts: [{ engine, status: "blocked", message: "HTTP " + res.status + " (captcha/anti-bot)" }] };
        }
        return { engine, rows: parse(html), attempts };
      }

      if (engine === "google" && googleApi && googleApi.key && googleApi.cx) {
        try {
          const url = "https://www.googleapis.com/customsearch/v1?key=" + encodeURIComponent(googleApi.key) +
            "&cx=" + encodeURIComponent(googleApi.cx) + "&num=10&q=" + encodeURIComponent(q);
          const { res, html } = await fetchEngine(url, { headers: { accept: "application/json" } });
          if (res.status === 403 || res.status === 429) {
            return { engine, rows: [], attempts: [{ engine, status: "blocked", message: "Google API HTTP " + res.status + " (quota or key)" }] };
          }
          let payload = null;
          try { payload = JSON.parse(html); } catch (e) { }
          if (!payload) return { engine, rows: [], attempts: [{ engine, status: "error", message: "Google API returned no JSON" }] };
          if (payload.error) return { engine, rows: [], attempts: [{ engine, status: "blocked", message: "Google API: " + (payload.error.message || "error") }] };
          const rows = [];
          for (const item of payload.items || []) {
            pushResult(rows, { title: item.title || "", url: item.link || "", snippet: item.snippet || "", engine: "google" });
          }
          return { engine, rows, attempts };
        } catch (e) {
          return { engine, rows: [], attempts: [{ engine, status: "error", message: "Google API: " + e.message }] };
        }
      }

      if (engine === "searxng" && !searxUrl) {
        return { engine, rows: [], attempts: [{ engine, status: "empty", message: "not configured (set CC_TERMUX_SEARX_URL)" }] };
      }

      if (engine === "searxng" && searxUrl) {
        try {
          const url = String(searxUrl).replace(/\/+$/, "") + "/search?q=" + encodeURIComponent(q) +
            "&format=json&categories=general&language=en";
          const { res, html } = await fetchEngine(url, { headers: { accept: "application/json" } });
          if (res.status === 403 || res.status === 429) {
            return { engine, rows: [], attempts: [{ engine, status: "blocked", message: "SearXNG HTTP " + res.status }] };
          }
          let payload = null;
          try { payload = JSON.parse(html); } catch (e) { }
          if (!payload) {
            return { engine, rows: [], attempts: [{ engine, status: "blocked", message: "SearXNG did not return JSON (enable json in search.formats, or the instance is behind a bot check)" }] };
          }
          const rows = [];
          for (const item of payload.results || []) {
            const row = { title: item.title || "", url: item.url || "", snippet: item.content || item.snippet || "", engine: "searxng" };
            pushResult(rows, row);
          }
          return { engine, rows, attempts };
        } catch (e) {
          return { engine, rows: [], attempts: [{ engine, status: "error", message: "SearXNG: " + e.message }] };
        }
      }

      if (engine === "duckduckgo") {
        for (const id of ["duckduckgo", "duckduckgolite"]) {
          try {
            const { res, html } = await fetchEngine(ENGINE_URLS[id](q), { headers: ENGINE_HEADERS[id] });
            if (isWall(id, res.status, html)) {
              attempts.push({ engine: id, status: "blocked", message: "HTTP " + res.status + " or bot check" });
              continue;
            }
            const rows = (id === "duckduckgolite" ? parseDuckDuckGoLite : parseDuckDuckGo)(html);
            if (rows.length) return { engine, rows, attempts };
            attempts.push({ engine: id, status: "empty", message: "no results in the page" });
          } catch (e) {
            attempts.push({ engine: id, status: "error", message: e.message });
          }
        }
        return { engine, rows: [], attempts };
      }

      const { res, html } = await fetchEngine(ENGINE_URLS[engine](q), { headers: ENGINE_HEADERS[engine] });
      if (isWall(engine, res.status, html)) {
        return { engine, rows: [], attempts: [{ engine, status: "blocked", message: "HTTP " + res.status + " or bot check" }] };
      }
      return { engine, rows: parse(html), attempts };
    } catch (e) {
      return { engine, rows: [], attempts: [{ engine, status: "error", message: e.message }] };
    }
  };

  const settled = await Promise.allSettled(requested.map((e) => run(e)));
  const report = [];
  const lists = [];
  const collect = (engine, outcome) => {
    const { report: entry, list } = finalizeEngine(engine, outcome.rows || [], outcome.attempts || [], tokens);
    report.push(entry);
    if (list) lists.push(list);
    return entry;
  };
  requested.forEach((engine, i) => {
    const outcome = settled[i].status === "fulfilled" ? settled[i].value
      : { rows: [], attempts: [{ engine, status: "error", message: String(settled[i].reason && settled[i].reason.message || settled[i].reason) }] };
    collect(engine, outcome);
  });

  // Google's own HTML endpoint is JS-walled on many networks. Startpage serves the same
  // index from its own servers, so use it as a transparent fallback (and say so).
  const googleEntry = report.find((r) => r.engine === "google");
  if (googleEntry && googleEntry.status !== "ok" && !requested.includes("startpage")) {
    collect("startpage", await run("startpage"));
  }

  const merged = mergeRanked(lists, { maxResults: Math.max(1, Math.min(20, maxResults)), tokens });
  return { query: q, results: merged, report, summary: formatSearchReport(report), tookMs: Date.now() - started, tokens };
}

export function formatSearchReport(report) {
  return report
    .filter((r) => r.status !== "ok" || r.dropped)
    .map((r) => r.engine + ": " + r.status + (r.count ? " (" + r.count + ")" : "") + (r.message ? " - " + r.message : ""))
    .join("; ");
}
