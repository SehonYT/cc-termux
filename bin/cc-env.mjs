#!/usr/bin/env node
// Emits shell exports for the active provider: model aliases and context window.

import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const p = (cfg.providers || {})[cfg.active] || {};
const model = p.model || p.defaultModel;
const a = p.aliases || {};
const out = [];
const safe = (v) => /^[A-Za-z0-9._/:@-]+$/.test(v);
if (model && safe(model)) {
  // NOTE: ANTHROPIC_MODEL is intentionally NOT exported - it overrides the /model picker.
  // The default model lives in ~/.claude/settings.json ("model"), written by cc-setup.
  out.push(['ANTHROPIC_DEFAULT_OPUS_MODEL', a.opus || model]);
  out.push(['ANTHROPIC_DEFAULT_SONNET_MODEL', a.sonnet || model]);
  out.push(['ANTHROPIC_DEFAULT_HAIKU_MODEL', a.haiku || model]);
  out.push(['CLAUDE_CODE_SUBAGENT_MODEL', a.subagent || model]);
}
if (p.contextWindow && Number(p.contextWindow) > 0) out.push(['CLAUDE_CODE_MAX_CONTEXT_TOKENS', String(Math.floor(Number(p.contextWindow)))]);
out.push(['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', '1']);
for (const [k, v] of out) console.log("export " + k + "='" + String(v).replace(/'/g, "'\\''") + "'");