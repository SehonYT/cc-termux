# Tests

Run everything (sequential runner; gateway suites start local servers):

```bash
npm test
npm run check
```

Individual suite: `node --test tests/<name>.test.mjs`.

## Suites

| File | Covers |
|---|---|
| `presets.test.mjs` | provider preset schema, unique ids, 20 new provider endpoints (incl. AgentRouter), static model fallbacks, ordering (popular first, tokens.bd last) |
| `platform.test.mjs` | CPU/OS matrix: native targets, Android musl loader, ARMv7/i686/riscv fallbacks, Node/glibc guards |
| `installer.test.mjs` | `install.mjs --check` plan output |
| `installer-codeonly.test.mjs` | `--code-only` keeps the installed Claude Code binary untouched and refreshes assets |
| `heal.test.mjs` | settings/env repair, foreign `claude` replacement, config/routing picker rebuild, native `~/.local/bin` layout, idempotency, temp-root isolation |
| `patch.test.mjs` | data-driven patch engine: apply, idempotency, revert, missing anchors, backup ordering |
| `tar.test.mjs` | built-in gzip+tar extractor and path-traversal rejection |
| `ui.test.mjs` | progress bars, spinner for unknown sizes, banner alignment, non-TTY fallback |
| `update.test.mjs` | self-update archive lookup, installer discovery, version stamps, `claudeCodeUpToDate`, cache and offline fallback |
| `version.test.mjs` | `<base>+<sha>` build versions and `v<base>-<sha>` tags |
| `gateway.test.mjs` | empty-config error, upstream failures written to `errors.log` |

## Fixtures

Mock upstreams, not part of the runtime and never used by the installer:

- `mock-openai.mjs` - OpenAI chat-completions upstream that exercises the tool loop
- `mock-anthropic.mjs` - Anthropic Messages upstream
- `mock-responses.mjs` - OpenAI Responses API upstream
- `mock-retry.mjs` - returns 503 twice, then 200, to test backoff
- `gwctl.mjs` - restart the local gateway against a chosen test config

Point `CC_TERMUX_CONFIG` at a throwaway config with `apiKey` omitted; never aim these at a paid provider.

Tests must never write to `$PREFIX/bin` or the real `~/.local/share/cc-termux`; the heal suite uses
temporary roots and an isolated prefix on purpose.
