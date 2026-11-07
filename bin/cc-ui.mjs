#!/usr/bin/env node
// Small terminal UI helpers shared by the installer and self-updater.
// Everything degrades to plain lines when stderr is not a TTY.

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return "?";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " kB";
  return Math.round(n) + " B";
}

export function bar(received, total, width = 28) {
  if (!total || !Number.isFinite(total)) return "-".repeat(width);
  const ratio = Math.max(0, Math.min(1, received / total));
  const filled = Math.round(ratio * width);
  return "#".repeat(filled) + "-".repeat(width - filled);
}

export function progressLine(label, received, total, elapsedMs) {
  const pct = total ? Math.min(100, Math.floor((received / total) * 100)) : null;
  const speed = elapsedMs > 300 ? received / (elapsedMs / 1000) : 0;
  const parts = [];
  if (pct != null) parts.push(String(pct).padStart(3) + "%");
  parts.push(formatBytes(received) + (total ? "/" + formatBytes(total) : ""));
  if (speed > 0) parts.push(formatBytes(speed) + "/s");
  return "  [" + bar(received, total) + "] " + parts.join("  ");
}

export function isTty(stream = process.stderr) {
  return Boolean(stream && stream.isTTY);
}

export function banner(lines, { stream = process.stderr, tty = isTty(stream) } = {}) {
  if (!tty) { for (const l of lines) stream.write(l + "\n"); return; }
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  const width = Math.max(...plain.map((l) => l.length));
  const rule = "  +" + "-".repeat(width + 2) + "+";
  stream.write(rule + "\n");
  for (let i = 0; i < lines.length; i++) {
    const pad = " ".repeat(width - plain[i].length);
    stream.write("  | " + lines[i] + pad + " |\n");
  }
  stream.write(rule + "\n");
}

export function step(text, { stream = process.stderr, tty = isTty(stream) } = {}) {
  stream.write((tty ? "\x1b[36m\u2714\x1b[0m " : "[ok] ") + text + "\n");
}

export function info(text, { stream = process.stderr, tty = isTty(stream) } = {}) {
  stream.write((tty ? "\x1b[2m\u00b7\x1b[0m " : "  - ") + text + "\n");
}

// Progress renderer. TTY: animated single line. Non-TTY: milestones only.
export function createProgress(label, { stream = process.stderr, tty = isTty(stream), width = 28 } = {}) {
  const started = Date.now();
  let lastPct = -10;
  let lastLineLen = 0;
  let frame = 0;
  let lastUnknownAt = 0;
  const print = (text, final) => {
    if (!tty) return;
    const line = "\r\x1b[2K" + text;
    stream.write(line);
    lastLineLen = text.length;
    if (final) stream.write("\n");
  };
  if (tty) stream.write("  " + label + "\n");
  return {
    update(received, total) {
      const pct = total ? Math.floor((received / total) * 100) : null;
      if (tty) {
        if (total) {
          print(progressLine(label, received, total, Date.now() - started));
        } else {
          const spin = ["|", "/", "-", "\\"][frame++ % 4];
          const elapsed = Math.max(1, Date.now() - started);
          print("  [" + spin + "] " + label + "  " + formatBytes(received) + "  " + formatBytes(received / (elapsed / 1000)) + "/s");
        }
        return;
      }
      if (pct != null && pct >= lastPct + 20) {
        lastPct = pct - (pct % 20);
        stream.write("  " + label + ": " + pct + "% (" + formatBytes(received) + "/" + formatBytes(total) + ")\n");
      } else if (pct == null && received > 0 && Date.now() - lastUnknownAt > 800) {
        lastUnknownAt = Date.now();
        stream.write("  " + label + ": " + formatBytes(received) + " downloaded\n");
      }
    },
    done({ ok = true, message = "" } = {}) {
      if (tty) {
        print("  " + (ok ? "\x1b[32m\u2714\x1b[0m " : "\x1b[31m\u2716\x1b[0m ") + label + (message ? "  " + message : ""), true);
      } else {
        stream.write("  " + (ok ? "[ok] " : "[!!] ") + label + (message ? " - " + message : "") + "\n");
      }
    },
  };
}