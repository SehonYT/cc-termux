# Tests

Everything uses Node's built-in `node:test` and the standard library only — no dependencies,
no test framework.

```bash
npm test                 # every suite, sequentially (the runner avoids port starvation)
npm test -- gateway      # only files whose name matches
npm run check            # syntax, JSON and shell checks (no tests run)
node --test tests/translate.test.mjs   # a single file directly
```

Tests must never write to `$PREFIX/bin` or the real `~/.local/share/cc-termux`. Every suite
that touches config sets an isolated `HOME`, `CC_TERMUX_ROOT`, `CC_TERMUX_CONFIG` and
`CC_TERMUX_CACHE` (or a temp prefix on Windows) and removes it afterwards.

## Unit suites

Pure or in-process: no network, no installed Claude Code, fast enough to run on a phone.

| File | Covers |
|---|---|
| `search.test.mjs` | engine parsers against saved pages (DuckDuckGo HTML + Lite, Bing, Brave, Google, Startpage), redirect unwrapping, canonical URLs, relevance gate and engine quarantine, reciprocal-rank merge, SearXNG JSON and Google Custom Search backends, per-engine status |
| `fetch.test.mjs` | HTML extraction (headings, tables, code blocks, boilerplate removal, entity decoding, dedupe), JSON pretty-printing, challenge detection, meta-refresh following, walled pages reported as blocked |
| `translate.test.mjs` | every protocol translator: `toOpenAI` / `fromOpenAI`, `toResponses` / `fromResponses`, `sanitizeBody`, `stripCache`, `flatten`, `mapStop`, `requestShapeError`, `estimate`, and both streaming factories (chunk splitting, parallel tool calls, upstream errors) |
| `antigravity.test.mjs` | Antigravity request translation, identity scrubbing, SSE proxying, live model/quota parsing against a local fake Google endpoint |
| `presets.test.mjs` | preset schema, endpoints, ordering, static model lists |
| `platform.test.mjs` | CPU/OS target matrix and Node/glibc guards |
| `tar.test.mjs` | gzip+tar extractor: symlinks and traversal safety |
| `ui.test.mjs` | progress bars, spinner, banner, non-TTY fallback |
| `paths.test.mjs` | POSIX/Windows path resolution, overrides, legacy fallback |
| `statusline.test.mjs` | status line install, idempotency, custom-line preservation, read-only dirs |
| `shimsnap.test.mjs` | bash snapshot `find` rewrite, idempotency, watcher behaviour |
| `patch.test.mjs` | patch apply/idempotency/revert, stamps, stale backups, byte correctness |
| `version.test.mjs` | build version and tag formatting |

## Integration suites

Spawn a real gateway, fake upstream servers or the installer in a temp directory.

| File | Covers |
|---|---|
| `gateway.test.mjs` | gateway contract: auth, no-provider error, tool-call translation, discovery, failure logging, count_tokens, classifier detection |
| `gateway-edge.test.mjs` | malformed bodies, unknown providers, provider switch mid-flight, degenerate SSE, silent upstreams, timeouts, 413 and keep-alive, 20-way concurrency |
| `cli-edge.test.mjs` | config matrix (missing/empty/corrupt/null), keys/settings variants, provider helpers, MCP protocol + SSRF + charsets + compression, status line |
| `cli-ux.test.mjs` | first-run `status` is friendly without config or providers |
| `launcher.test.mjs` | launcher wiring, env scrubbing, session files, gateway supervision |
| `mcp.test.mjs` | web MCP server: tool protocol, fetch/search behaviour, output fencing |
| `heal.test.mjs` | settings/env repair, foreign `claude` replacement, routing/picker rebuild, native layout, idempotency |
| `installer.test.mjs` | `install.mjs --check` plan output |
| `installer-codeonly.test.mjs` | `--code-only` keeps the binary and refreshes assets |
| `get-bootstrap.test.mjs` | no-TTY piped bootstrap runs the installer |
| `update.test.mjs` | provenance, self-update archive lookup, version stamps, cache/offline behaviour |
| `setup.test.mjs` | setup flag/help handling |
| `perf.test.mjs` | opt-in performance mode, defaults, env flags |
| `assets.test.mjs` | the installer ships every runtime file and every relative import resolves |
| `docs.test.mjs` | README/docs integrity: links resolve, sections and badge set exist, every suite is documented here |

Saved engine pages live in `tests/fixtures/search/` (`duckduckgo.html`, `duckduckgo-lite.html`,
`bing.html`, `brave.html`, `google.html`, `startpage.html`, plus `google-js-wall.html` and
`brave-wall.html` for the blocked-page paths). The Brave/Google result fixtures are hand-built
from the documented DOM shapes because live pages return an anti-bot wall from most networks;
the DuckDuckGo/Bing ones are trimmed real responses.

## Fixtures

- Fake upstreams are plain `http.createServer` handlers in the suite that needs them; there
  is no shared fixture server, so one suite's port cannot leak into another.
- Gateway suites pick a random high port and wait on `/health` before asserting.
- Installer suites build a throwaway root and never download Claude Code.
