#!/usr/bin/env node
// Minimal gzip+tar extractor used when the system `tar` is missing.
// Supports regular files, directories, symlinks and GNU long names.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

function readString(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const zero = slice.indexOf(0);
  return slice.subarray(0, zero === -1 ? slice.length : zero).toString("utf8");
}
function modeOf(buf) {
  const octal = readString(buf, 100, 8).trim();
  return octal ? parseInt(octal, 8) : 0o644;
}

export function extractTgz(input, dest) {
  const gz = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const buf = zlib.gunzipSync(gz);
  fs.mkdirSync(dest, { recursive: true });
  const root = fs.realpathSync(dest);
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  const safeParent = (target) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return inside(fs.realpathSync(path.dirname(target)));
  };
  let offset = 0;
  let longName = "";
  let files = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(readString(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = readString(header, 345, 155);
    let name = readString(header, 0, 100);
    if (prefix) name = prefix + "/" + name;
    if (longName) { name = longName; longName = ""; }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (type === "L") { longName = readString(buf, dataStart, size); offset = dataStart + Math.ceil(size / 512) * 512; continue; }
    if (type === "x" || type === "g") { offset = dataStart + Math.ceil(size / 512) * 512; continue; }
    const target = path.resolve(dest, name);
    if (!target.startsWith(path.resolve(dest) + path.sep) && target !== path.resolve(dest)) throw new Error("tar entry escapes destination: " + name);
    if (type === "5") {
      fs.mkdirSync(target, { recursive: true });
      if (!inside(fs.realpathSync(target))) { offset = dataStart + Math.ceil(size / 512) * 512; continue; }
    } else if (type === "2") {
      // tar stores the symlink target in the header linkname field (not the data block)
      const link = readString(header, 157, 100);
      const resolved = path.resolve(path.dirname(target), link);
      if (!inside(resolved)) { offset = dataStart + Math.ceil(size / 512) * 512; continue; }
      if (!safeParent(target)) { offset = dataStart + Math.ceil(size / 512) * 512; continue; }
      try { fs.unlinkSync(target); } catch { }
      fs.symlinkSync(link, target);
    } else if (type === "0" || type === "" || type === "\0") {
      if (!safeParent(target)) { offset = dataStart + Math.ceil(size / 512) * 512; continue; }
      fs.writeFileSync(target, buf.subarray(dataStart, dataEnd), { mode: modeOf(header) });
      files++;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return { files };
}