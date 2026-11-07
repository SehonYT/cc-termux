import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { extractTgz } from "../bin/cc-tar.mjs";

function octal(v, len) { return v.toString(8).padStart(len - 1, "0") + "\0"; }
function tarEntry(name, content) {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write(octal(0o644, 8), 100, "ascii");
  header.write(octal(0, 8), 108, "ascii");
  header.write(octal(0, 8), 116, "ascii");
  header.write(octal(content.length, 12), 124, "ascii");
  header.write(octal(0, 12), 136, "ascii");
  header.write("        ", 148, "ascii");
  header.write("0", 156, "ascii");
  let sum = 0;
  for (const b of header) sum += b;
  header.write(octal(sum, 8), 148, "ascii");
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return Buffer.concat([header, padded]);
}

test("extractTgz unpacks files without the system tar", () => {
  const tgz = zlib.gzipSync(Buffer.concat([tarEntry("pkg/cli.js", Buffer.from("hello")), Buffer.alloc(1024)]));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tar-"));
  try {
    const out = extractTgz(tgz, tmp);
    assert.equal(out.files, 1);
    assert.equal(fs.readFileSync(path.join(tmp, "pkg", "cli.js"), "utf8"), "hello");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("extractTgz rejects path traversal", () => {
  const tgz = zlib.gzipSync(Buffer.concat([tarEntry("../escape.txt", Buffer.from("x")), Buffer.alloc(1024)]));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tar-"));
  try { assert.throws(() => extractTgz(tgz, tmp), /escapes destination/); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});