import test from "node:test";
import assert from "node:assert/strict";

const snap = await import("../bin/cc-shimsnap.mjs");

const SNAPSHOT = [
  "#!/usr/bin/env bash",
  "alias ls='ls --color'",
  "function find {",
  '  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"',
  "  (exec -a bfs \"$_cc_bin\" -S dfs -regextype findutils-default ${1+\"$@\"})",
  "}",
  "function grep {",
  "  command grep \"$@\"",
  "}",
  "",
].join("\n");

test("the bfs-backed find shim is replaced with the real find", () => {
  const out = snap.patchSnapshotText(SNAPSHOT);
  assert.ok(out.includes(snap.MARKER));
  assert.match(out, /function find \{ command find \$\{1\+"\$@"\}; \}/);
  assert.doesNotMatch(out, /exec -a bfs/);
  // grep shim is left alone
  assert.match(out, /function grep \{/);
  assert.ok(out.startsWith("#!/usr/bin/env bash"));
});

test("patching is idempotent and ignores unrelated text", () => {
  const once = snap.patchSnapshotText(SNAPSHOT);
  assert.equal(snap.patchSnapshotText(once), once);
  assert.equal(snap.patchSnapshotText("no shims here"), "no shims here");
});
