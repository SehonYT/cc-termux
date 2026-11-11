import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const setup = fs.readFileSync(path.join(root, "bin", "cc-setup.mjs"), "utf8");
const cli = fs.readFileSync(path.join(root, "bin", "cc-termux"), "utf8");

// The predicate is duplicated in both entry points on purpose (the CLI must not import the
// wizard), so the suite checks that they agree and that the lists stay in sync.
function predicateFrom(source, name) {
  const m = new RegExp("(?:const|function) " + name + "[^\\n]*\\n?[^\\n]*", "m").exec(source);
  assert.ok(m, name + " must exist");
  return m[0];
}

test("wizard and CLI share the same Gemini chat-model filter", () => {
  const a = predicateFrom(setup, "geminiChatModel");
  const b = predicateFrom(cli, "isGeminiChatModel");
  const body = (s) => (/\/\(([^)]*)\)\/i/.exec(s) || [])[1] || "";
  const outer = (s) => (body(s).match(/\[([^\]]*)\]/) || [])[1] || body(s);
  const tokens = (s) => outer(s).split("|").map((x) => x.trim()).filter(Boolean).sort();
  assert.deepEqual(tokens(a), tokens(b), "both filters must reject the same model names");
});

test("the Gemini filter rejects every non-chat family the API lists", () => {
  const src = predicateFrom(setup, "geminiChatModel");
  const body = /\/\(([^)]*)\)\/i/.exec(src)[1];
  const re = new RegExp(body, "i");
  const rejected = [
    "gemini-2.5-flash-preview-tts", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts",
    "gemini-2.5-flash-image", "gemini-3-pro-image", "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-nano-banana-2.1",
    "nano-banana-pro-preview", "gemma-4-31b-it", "gemma-4-26b-a4b-it",
    "gemini-embedding-001", "gemini-embedding-2", "imagen-4.0-generate",
    "veo-3.1-generate-preview", "lyria-3.5", "lyria-3-clip-preview",
    "gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-3.8-live-extended-thinking",
    "gemini-3.5-transcribe", "gemini-robotics-er-2-preview", "gemini-2.5-computer-use-preview-10-2025",
    "deep-research-pro-preview-12-2025", "antigravity-preview-latest", "gemini-2.5-flash-native-audio-preview-12-2025",
  ];
  for (const id of rejected) assert.equal(re.test(id), true, "must reject " + id);
  const kept = [
    "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash",
    "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3-flash-preview",
    "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest",
    "gemini-4-carbon", "gemini-4-argon", "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview-customtools", "gemini-3.1-flash-lite-preview",
  ];
  for (const id of kept) assert.equal(re.test(id), false, "must keep " + id);
});

test("retired Gemini 2.5 models are not offered", () => {
  assert.match(setup, /GEMINI_RETIRED = \/\^\(gemini-2\\\.\\d\|gemini-1\\\.\\d\)\//);
  assert.match(setup, /!GEMINI_RETIRED\.test\(m\.id\)/);
});

test("free and paid Gemini tiers are listed explicitly", () => {
  const ids = (re) => (/\^\(([^)]*)\)\$/.exec(re) || [])[1].split("|").map((x) => x.replace(/\\/g, ""));
  const free = ids(/GEMINI_FREE = (\/[^\n]*\/);/.exec(setup)[1]);
  const paid = ids(/GEMINI_PAID = (\/[^\n]*\/);/.exec(setup)[1]);
  for (const id of ["gemini-3\.8-flash", "gemini-3\.7-flash", "gemini-3\.6-flash", "gemini-3\.5-flash", "gemini-3\.5-flash-lite", "gemini-3\.1-flash-lite", "gemini-3-flash-preview"]) {
    assert.ok(free.includes(id), "free tier must include " + id);
    assert.ok(!paid.includes(id), "paid tier must not include " + id);
  }
  for (const id of ["gemini-4-carbon", "gemini-4-argon", "gemini-3\.1-pro-preview"]) {
    assert.ok(paid.includes(id), "paid tier must include " + id);
    assert.ok(!free.includes(id), "free tier must not include " + id);
  }
  // Gemini 2.5 is retired for new keys, so it must not be advertised as free.
  assert.ok(!free.includes("gemini-2\.5"), "retired 2.5 models must not be advertised");
});

test("the picker shows the tier when it is known", () => {
  assert.match(cli, /info\.tier === "free" \? "free tier"/);
  assert.match(cli, /info\.tier === "paid" \? "paid only"/);
});

test("per-model Gemini prices are present for every priced family", () => {
  const block = /const GEMINI_PRICE = \{([\s\S]*?)\};/.exec(setup)[1];
  for (const id of ["gemini-4-carbon", "gemini-4-argon", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-3-flash-preview"]) {
    assert.ok(block.includes('"' + id + '"'), "price missing for " + id);
  }
  assert.match(setup, /inUsd: price \? price\[0\] : null, outUsd: price \? price\[1\] : null/);
});
