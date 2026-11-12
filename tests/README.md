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
| `uninstall.test.mjs` | removal: the plan separates what cc-termux owns from what it shares with Claude Code, restoring `settings.json` and `~/.claude.json` removes only our keys and leaves every other setting byte for byte, a corrupt or missing settings file is left alone rather than destroyed, only a cc-termux shim is replaced by the original launcher, and the skill pack is removed without deleting a skill the user wrote |
| `provider-headers.test.mjs` | provider URL joining (a baseUrl ending in /v1 must not become /v1/v1/responses, and no shipped preset may double a version segment), all three proxy paths resolving URLs and forwarding preset headers the same way, the AgentRouter client-identity headers its gateway requires, `cc-patch` resolving its root through cc-paths, and the installer moving an npm `.ps1` aside so PowerShell cannot prefer it over our shim |
| `platform.test.mjs` | the OS support contract: every platform and CPU we claim resolves to a usable target (Windows x64/arm64, macOS Intel and Apple Silicon, glibc and musl Linux, Android including 32-bit userland on an AArch64 kernel, and a JS fallback for anything unknown); musl detection across real Alpine layouts and never on glibc; every prefix is a real, platform-shaped path and Windows never resolves to `/usr/local`; an explicit `PREFIX` wins everywhere; and the CI matrix actually covers each OS it claims, including Intel macOS and a real Alpine container |
| `skills.test.mjs` | the shipped skill pack: every catalog entry has a valid SKILL.md whose `name` matches its directory, our own skills carry trigger words in their description, vendored skills keep upstream source and licence, install/status/remove are isolated per Claude config dir and never touch a skill the user wrote, and the installer and launcher both ship and restore the pack |
| `search.test.mjs` | engine parsers against saved pages (DuckDuckGo HTML + Lite, Bing, Brave, Google, Startpage), redirect unwrapping, canonical URLs, relevance gate and engine quarantine, reciprocal-rank merge, SearXNG JSON and Google Custom Search backends, per-engine status |
| `fetch.test.mjs` | HTML extraction (headings, tables, code blocks, boilerplate removal, entity decoding, dedupe), JSON pretty-printing, challenge detection, meta-refresh following, walled pages reported as blocked |
| `translate.test.mjs` | every protocol translator: `toOpenAI` / `fromOpenAI`, `toResponses` / `fromResponses`, `sanitizeBody`, `stripCache`, `flatten`, `mapStop`, `requestShapeError`, `estimate`, and both streaming factories (chunk splitting, parallel tool calls, upstream errors) |
| `antigravity.test.mjs` | Antigravity request translation, identity scrubbing, SSE proxying, live model/quota parsing against a local fake Google endpoint |
| `presets.test.mjs` | preset schema, endpoints, ordering, static model lists |
| `webproviders.test.mjs` | web search provider chain: Tavily (keyed and keyless), Brave and Jina request/response mapping, quota-vs-error classification, key-required providers being skipped, env-var keys, the fallback order ending at the built-in scraper, and Antigravity's Google Search grounding |
| `nararouter.test.mjs` | NaraRouter plan parsing from `/api/plans` (rpm, daily token cap, per-plan model lists), free detection by price rather than plan name, tier split for `free`/`paid`/`all`, key-scoped `/v1/models` with per-model tiers, the gateway's `rate_limited` 429 split (per-minute transient vs daily quota terminal), and the usage view |
| `openrouter-tier.test.mjs` | OpenRouter free/paid detection from `pricing` (not just the `:free` suffix), tier filtering for `free`/`paid`/`all`, free models that cannot call tools being dropped, tier persistence on the provider, and the refresh keeping its tier |
| `gemini-models.test.mjs` | Gemini AI Studio model filtering: the wizard and CLI must reject the same non-chat families (image/TTS/Live/embedding/agents), retired 2.5 ids stay out, free vs paid tier lists match the published table, and prices exist per family |
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
| `gemini-429.test.mjs` | Gemini 429 classification: per-minute (RPM/TPM) metrics are transient and retried with short backoff, a per-day (RPD) metric is terminal and fails fast without retrying, mixed bodies stay terminal, Google's `retry in 21h15m47s` hint is parsed, and the verdict is persisted to `quota.json` |
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
