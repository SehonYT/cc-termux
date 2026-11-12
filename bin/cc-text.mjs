#!/usr/bin/env node
// Small text helpers used by both the search engine and the MCP server. They lived in two
// files and had already drifted, so a null input decoded to "null" in one and "" in the
// other, and their entity tables differed. One definition, imported by both.

// The union of both former tables: the search copy had the common named entities, the MCP
// copy had typography, currency and maths. Dropping either is a silent regression.
const ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'",
  hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", rsquo: "\u2019", lsquo: "\u2018",
  ldquo: "\u201c", rdquo: "\u201d", copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
  middot: "\u00b7", bull: "\u2022", deg: "\u00b0", times: "\u00d7", divide: "\u00f7",
  euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2", laquo: "\u00ab",
  raquo: "\u00bb", sect: "\u00a7", para: "\u00b6", plusmn: "\u00b1", micro: "\u00b5",
  frac12: "\u00bd", frac14: "\u00bc", frac34: "\u00be", sup2: "\u00b2", sup3: "\u00b3",
};

export function decodeEntities(s) {
  return String(s == null ? "" : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ""; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch (e) { return ""; } })
    .replace(/&([a-z]+|#\d+);/gi, (m, name) => {
      const v = ENTITIES[name.toLowerCase()];
      return v !== undefined ? v : m;
    });
}
