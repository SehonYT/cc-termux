# How cc-termux works

This document is the deep dive: what runs, how requests are translated and how the
platform-specific pieces fit together. The README covers what cc-termux does; this covers
how it does it.

- [Gateway lifecycle](#gateway-lifecycle)
- [Protocol adapters](#protocol-adapters)
- [Routing and provider switching](#routing-and-provider-switching)
- [Auto mode classifier](#auto-mode-classifier)
- [Google Antigravity](#google-antigravity)
- [Web search and page fetch](#web-search-and-page-fetch)
- [WebFetch domain check](#webfetch-domain-check)
- [Shell shims](#shell-shims)
- [Binary patches](#binary-patches)
- [Install layout and self-repair](#install-layout-and-self-repair)
- [Failures and diagnostics](#failures-and-diagnostics)
- [Platform mechanics](#platform-mechanics)
- [Performance mode](#performance-mode)

## Gateway lifecycle

The gateway is not a daemon and does not listen on a public port.

```
claude (shim)
  └─ bin/cc-launcher.mjs
       ├─ registers a session file in ~/.cache/cc-termux/sessions/
       ├─ starts proxy/server.mjs on 127.0.0.1:8788 if it is not already running
       ├─ sets ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN for this process
       └─ execs the real Claude Code binary
```

- Concurrent sessions share one gateway. The last session to exit stops it.
- The gateway self-exits after ~10 seconds without session files (managed mode).
- `claude --version` and `claude --help` never start it.
- Stale instances are killed before a new gateway starts; `cc-termux restart` stops all of them.
- The gateway reloads `config.json` on every request, so a provider switch applies to a
  running session without a restart.

## Protocol adapters

Claude Code speaks the Anthropic Messages API. The gateway picks an adapter per provider
through `type` and `apiMode`:

| Adapter | Used for | Wire format |
|---|---|---|
| `anthropic` | Anthropic-compatible endpoints (including tokens.bd's Anthropic endpoint) | pass-through `/v1/messages` |
| `openai` (chat) | OpenAI-compatible providers, local servers | `/v1/chat/completions` |
| `openai` (responses) | OpenAI Responses API | `/v1/responses` |
| `antigravity` | Google Antigravity (OAuth) | `v1internal:streamGenerateContent` (SSE) |
| `gemini` | Google AI Studio compatibility endpoint | `/v1beta/openai` |

The translation layer lives in `proxy/translate.mjs`:

- **Requests** — system prompts, text, images, tool definitions, tool choice, tool results
  and generation parameters are mapped to the upstream schema. Anthropic-only fields
  (`thinking`, `betas`, `cache_control`, `context_management`, `output_config`) are dropped,
  because third-party endpoints reject them.
- **Responses** — text and tool calls are turned back into Anthropic content blocks, with
  `stop_reason` mapped from the upstream finish reason.
- **Streams** — OpenAI SSE deltas and Responses API events are re-emitted as Anthropic
  `message_start` / `content_block_delta` / `message_delta` / `message_stop` events,
  including partial tool-call arguments.
- The Responses adapter falls back to chat completions when the endpoint does not exist.

Upstream calls share four properties: per-attempt timeout (`provider.timeoutMs`, default
15 minutes, headers only), exponential backoff with jitter for 408/409/425/429/5xx,
`Retry-After` support, and client-disconnect propagation.

### Rate limits: per-minute versus per-day

Google answers **the same** `RESOURCE_EXHAUSTED` body for three different limits, and sends
no `Retry-After` header, so the metric identifier inside the message is the only reliable
signal:

```
* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests,
  limit: 20, model: gemini-3.8-flash, description: Generate content requests per day limit exceeded on Free Tier.
```

`classifyGemini429()` reads those lines and decides:

| Metric | Meaning | Gateway behaviour |
|---|---|---|
| `..._requests` + "per day" | RPD — daily budget spent | **terminal**: fail fast with the real message, no retry |
| `..._requests` + "per minute" | RPM — short burst | **transient**: retry with 1s/2s/4s… backoff up to `retryMaxMs` |
| `..._input_token_count` + "per minute" | TPM — token burst | **transient**: same as RPM |
| anything else | undecided | fall through to the generic retry path |

A body that lists both a per-minute and a per-day metric is terminal, because the day limit
will not clear. Google's `Please retry in 21h15m47.838953365s.` hint is parsed, but a hint
longer than a minute is discarded for bursts — sleeping for hours inside a request would
hang the agent. Every observation is recorded in `~/.cache/cc-termux/quota.json` with its
`kind` (`burst` or `daily`) and `classes`; `cc-termux doctor` only warns about a burst for
ten minutes, while a daily limit stays visible for a day.

## NaraRouter plans and tiers

`https://router.bynara.id/v1` is OpenAI-compatible and publishes its plan table on the
public `/api/plans` endpoint, so free/paid detection needs no key:

| Plan | Price | Rate | Daily tokens | Models |
|---|---|---|---|---|
| `free` | free | 15 req/min | 7M | 2 |
| `freemium` | Rp5000/day | 50 req/min | 25M | 5 |
| `freemium-max` | Rp10000/day | 60 req/min | 60M | 5 |
| `gpt-fams-promo` | Rp20000/day | 50 req/min | 25M | 3 |
| `freemium-ultra` | Rp30000/day | 60 req/min | 200M | 5 |

A plan is free when **both** its daily and weekly price are zero; a plan whose code says
free but which charges is not. Free tier means the models reachable on that zero-cost plan
(`agnes-2.5-flash`, `laguna-s-2.1`), paid tier means the aliases only paid plans add. Setup
asks for the tier exactly as it does for OpenRouter, and `/v1/models` then narrows the
result to the aliases the key itself is entitled to.

`cc-termux nararouter usage` prints the plan table with its limits, the tier split and the
free-tier model list; `cc-termux nararouter plans --json` emits the raw table.

Rate limits are reported through one 429 type (`rate_limited`): a per-minute breach is
transient and retried, while a daily token quota is per model tier and terminal for the day.
The gateway classifies it from the message the same way it does for Gemini, and only that
tier stops working — other tiers keep serving.

## OpenRouter model tiers

OpenRouter publishes one catalog of ~470 models where free and paid entries are mixed.
Setup asks which tier to import:

| Choice | What is imported |
|---|---|
| free only (default) | models whose prompt **and** completion prices are `0` |
| paid only | everything that costs anything |
| everything | both, each labelled in `/model` |

Free detection reads `pricing` rather than trusting the `:free` id suffix, because the
router aliases (`openrouter/free`) carry no suffix and a suffix alone would mislabel a
priced model. A free model that does not advertise `tools` in `supported_parameters` is
skipped: Claude Code cannot do anything with a model that cannot call tools. The choice is
stored on the provider as `tier`, so `cc-termux sync` keeps refreshing the same list instead
of quietly pulling 450+ paid models into a free-only setup.

## Google AI Studio model list

`GET /v1beta/models` returns every model the key can see, and only some of them can answer
a chat completion. The wizard (`bin/cc-setup.mjs`) and `cc-termux doctor` therefore share
one predicate and keep only ids that work through `/v1beta/openai/chat/completions`:

- **Dropped**: image (`*-image`, `nano-banana*`), speech (`*-tts`), Live API (`*-live`),
  transcription, `embedding`, `imagen`, `veo`, `lyria`, robotics, computer-use,
  Deep Research, `antigravity-*` and the Gemma text-only checkpoints.
- **Dropped as retired**: `gemini-2.5-*`. The API still lists them, but calls answer
  `404 no longer available to new users`, so they are never offered.
- **Kept**: the Gemini 3.x Flash/Lite/Pro families, the `*-latest` aliases, the Gemini 4
  tier and Omni.

Free and paid availability cannot be read from the API, so it comes from the published
pricing table and is stored per model as `tier`: `gemini-3.8-flash`, `gemini-3.7-flash`,
`gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` and
`gemini-3-flash-preview` are free tier; `gemini-4-carbon`, `gemini-4-argon` and
`gemini-3.1-pro-preview` need billing enabled. The `/model` picker shows `free tier` or
`paid only` next to the name. A 429 on a free key means the key itself is out of quota,
not that the model is unavailable.

## Routing and provider switching

`pickRoute()` resolves a requested model id in this order:

1. `prov/<provider>/<model>` — always routes to that provider.
2. A configured `override` (set by `/provider` or a `provswitch/<provider>` row).
3. A `routing` entry (the `/model` picker rows).
4. The active provider, passing the model through or mapping it through its aliases.

Provider switches and model choices are always explicit: a request is never silently sent
to a different provider as a fallback (no cross-provider fallback).

## Auto mode classifier

Auto mode asks Claude Code to send one extra `/v1/messages` request to a classifier model
before running a tool, and only proceeds when the answer is `<block>no</block>`.

- Claude Code 2.1.322+ prefers a server-side classifier, which cannot work behind a local
  gateway. The launcher sets `CLAUDE_CODE_AUTO_MODE_SERVER=0` so the CLI runs its own model
  classifier instead of refusing every tool call.
- The classifier is detected by its system prompt
  (`You are a security monitor for autonomous AI coding agents`) and its stop sequences,
  never by model name.
- The gateway gives that turn a thinking-free budget, pins a Claude-capable classifier model
  when one is configured, and otherwise uses the active provider's model.
- `CC_TERMUX_CLASSIFIER_ALLOW=1` (or `classifier.allow` in `config.json`) answers the
  classifier locally with an allow verdict. This disables Claude Code's tool-call safety
  check for the session — the same trust level as bypassing permissions — so it is off by
  default.

## Google Antigravity

Antigravity authenticates with a Google account instead of an API key. Credentials live in
`~/.config/cc-termux/antigravity.json` (mode 0600) and the gateway refreshes the access
token automatically.

- Requests are sent to Cloud Code's `v1internal:streamGenerateContent?alt=sse` on
  `daily-cloudcode-pa.googleapis.com`, with a secondary host as fallback.
- Google's filter refuses requests that look like a competing agent or contain an
  Anthropic billing header. The adapter strips those identity lines, keeps Antigravity's own
  system prompt upstream and moves the client system prompt into the first user turn.
- A bare `429 RESOURCE_EXHAUSTED` is often content-triggered rather than quota. The adapter
  retries at most twice, honours `Retry-After` / `RetryInfo`, and caches an identical
  refusal for 2–30 minutes so the same body is not resent.
- The model list comes from Google's `agentModelSorts`, so models appear and disappear with
  the account's entitlements (Argon on paid plans, for example).
- Quota percentages shown by `cc-termux antigravity usage` and the status line are
  **remaining** budget and are labelled `left`.

## Web search and page fetch

Claude Code's built-in WebFetch and WebSearch use Anthropic's servers. On Android the
bundled musl build cannot resolve DNS at all (there is no `/etc/resolv.conf`), so those
tools cannot work behind cc-termux.

The launcher registers an MCP server named `web` (`bin/cc-mcp.mjs`) in `~/.claude.json`,
which exposes two tools to the model:

| Tool | Escapes as | What it returns |
|---|---|---|
| `mcp__web__search` | Web Search | results from several engines, merged and ranked, with a per-engine status line |
| `mcp__web__fetch` | Web Fetch | readable page text: title, description, headings, lists, tables, code and links |

### Search engines

`bin/cc-search.mjs` holds one parser per engine plus the merge/rank logic. The HTML of each
engine is decoded rather than scraped blindly:

| Engine | Endpoint | Redirect format |
|---|---|---|
| DuckDuckGo | `html.duckduckgo.com/html/` | `/l/?uddg=<url-encoded>` |
| DuckDuckGo Lite | `lite.duckduckgo.com/lite/` | same, `result-link` attributes use single quotes |
| Google | `google.com/search` | `/url?q=<url-encoded>` |
| Brave | `search.brave.com/search` | plain links inside SvelteKit `.snippet` cards |
| Bing | `bing.com/search` | `/ck/a?u=a1<base64url>` |
| Startpage | POST `startpage.com/sp/search` with an `sc` token | plain links (Google index) |

- **Relevance gate**: each result must cover a meaningful part of the query (stopwords are
  dropped). An engine whose page mostly does not match is *quarantined* as a whole — this is
  what stops Bing, which sometimes answers with a completely different query from certain
  networks or caches, from injecting coincidental junk into the ranking.
- **Reciprocal-rank fusion** merges the surviving lists: a page found by two engines outranks
  a page found by one, and duplicates are collapsed on a canonical URL (tracking parameters,
  `www.`, fragments and trailing slashes are normalised away).
- **Per-engine status** is reported to the model, e.g. `google: blocked - HTTP 200 or bot
  check; bing: irrelevant - engine returned results for a different query`. A search never
  silently returns nothing without saying why.
- **Google fallback**: when google.com serves its JavaScript wall, the same index is requested
  from Startpage. A configured SearXNG instance (`CC_TERMUX_SEARX_URL`, JSON API) or Google
  Custom Search (`CC_TERMUX_GOOGLE_KEY` + `CC_TERMUX_GOOGLE_CX`) is used when available.
- Requests use browser headers, a shared cookie jar and up to five redirects. Each engine
  gets a short per-request timeout so one slow engine cannot hold the whole search up.

### Fetch

- Requests look like a real browser: rotating Chrome/Safari/Firefox user agents, full
  `Accept` / `Accept-Language` / `Sec-Fetch-*` / `Sec-CH-UA` headers, same-origin `Referer`,
  a shared cookie jar, up to five redirects, `<meta http-equiv="refresh">` following, and one
  retry with a second fingerprint on 403/429/503.
- **Address-family fallback**: every DNS answer is validated, IPv4 is tried first and IPv6 is
  tried when the first address is refused with 403/429/451/503. This is what makes
  `google.com` fetchable on networks where one family is blocked outright.
- Forms can be POSTed (used by the Startpage search flow) while keeping the same SSRF checks
  on every redirect hop.
- Bodies are decoded from gzip/brotli, charsets are detected from headers or `<meta>`, JSON
  responses are pretty-printed, and long pages are paginated with `offset`.
- **HTML extraction** keeps the main/article region, headings, lists, pipe-separated table
  rows and fenced `<pre>` blocks; it drops navigation, sidebars, footers, forms and duplicate
  consecutive lines, and decodes entities exactly once.
- **Challenge detection** recognises Cloudflare/Anubis/DataDome interstitials and Google's
  "enable JavaScript" wall, and says *blocked by a bot check* instead of returning the wall as
  page content.
- **SSRF protection**: only `http(s)`, no credentials in the URL, every redirect hop is
  validated, private/loopback/link-local/CGNAT/ULA/metadata addresses are refused, and the
  connection is pinned to the vetted IP so a second DNS answer cannot rebind it.
  `CC_TERMUX_WEB_ALLOW_PRIVATE=1` allows private addresses for local development.
- **Prompt-injection guard rails**: control and zero-width characters are stripped, the text
  is fenced as `<<<UNTRUSTED WEB CONTENT ... >>>` with a "data, not instructions" banner, and
  instruction-smuggling phrases are flagged in a warning banner.

Environment: `CC_TERMUX_WEB_TIMEOUT_MS` (20000), `CC_TERMUX_WEB_MAX_BYTES` (4000000),
`CC_TERMUX_WEB_ALLOW_PRIVATE`, `CC_TERMUX_WEB_READER_PROXY=1` (read blocked pages through
`r.jina.ai`), `CC_TERMUX_SEARX_URL` (SearXNG base URL with JSON enabled),
`CC_TERMUX_GOOGLE_KEY` + `CC_TERMUX_GOOGLE_CX` (Google Custom Search API).

## WebFetch domain check

Before fetching a page, Claude Code asks `api.anthropic.com/api/web/domain_info` whether the
domain is safe. With no Anthropic account that check fails and every WebFetch is blocked.

A binary patch rewrites that URL to a loopback helper served by the gateway on
`127.0.0.1:8799`, which answers `{"can_fetch":true}`. The port is fixed because the patch
replaces the URL with an equal-length string; `CC_TERMUX_DOMAIN_CHECK_PORT` is ignored (and
logged) rather than letting WebFetch fail silently. `cc-termux doctor` checks that the helper
answers and that the installed binary is patched.

## Shell shims

Claude Code writes a bash snapshot per session that shadows `find` with an embedded `bfs`
and `grep` with an embedded `ugrep`. On Android/Termux the embedded `bfs` dies with
`Bad system call` (SIGSYS) inside the sandboxed shell, so `find` silently returns nothing.

`bin/cc-shimsnap.mjs` runs at launch and rewrites the `find` function in existing and newly
created snapshots to call the real findutils binary. `grep` is left alone because the
embedded `ugrep` works. Repair by hand with `node bin/cc-shimsnap.mjs --once`.

## Binary patches

Patch definitions live in `patches.json`, not in code. Each anchor may list alternatives, so
a new Claude Code release can be supported by editing JSON. Install and update re-apply them,
missing anchors are skipped with a message, and the unpatched binary is kept as
`claude.bin.orig`. Apply/status/revert:

```bash
cc-termux patch status
cc-termux patch revert
CC_TERMUX_NO_UI_PATCH=1 bash install.sh   # skip during install
```

A `<binary>.patched` stamp records the applied state; the launcher re-applies patches when
the binary is newer than the stamp, and `cc-termux doctor --fix` repairs them on demand.

## Install layout and self-repair

Claude Code's `/status` expects the native layout, so the installer reproduces it:

```
~/.local/bin/claude                        -> ~/.local/share/claude/versions/<version>
~/.local/share/claude/versions/<version>   the cc-termux launcher
$PREFIX/bin/cc-termux, $PREFIX/bin/ccp     CLI shims
~/.claude.json                             {"installMethod":"native"}
```

`bin/cc-heal.mjs` runs after every install and update and is idempotent:

- removes `ANTHROPIC_*` and context override keys from Claude Code's `settings.json` env
- replaces a stale `settings.model` with the active provider model
- replaces a foreign `claude` binary earlier in `PATH` with the cc-termux shim
- removes sample provider entries left by older releases
- repairs config sanity (active provider, override, routing table, 0600 permissions)
- regenerates the `/model` picker rows and `settings.model`
- reinstalls missing launcher shims, restores `commands/provider.md`, rotates logs over 5 MB
- clears stale session files and idle gateways

Run it on demand with `cc-termux heal`.

## Failures and diagnostics

Every failure is persisted, not just printed:

- `~/.cache/cc-termux/gateway.log` — gateway output (startup, requests, retries).
- `~/.cache/cc-termux/errors.log` — one JSON line per failure:
  `{ at, kind, provider, model, status, message }`, where `kind` is `upstream`, `stream` or
  `gateway`. Secrets are redacted before writing.

```bash
cc-termux errors [n]   # recent failures, formatted
cc-termux logs         # gateway log tail
cc-termux diagnose     # deep install + gateway + key checks
```

## Platform mechanics

| Host | Build | Notes |
|---|---|---|
| Termux aarch64 | `linux-arm64-musl` | executed through an Alpine musl loader |
| Termux on a 32-bit userland with an aarch64 kernel | JS build fallback | no native 32-bit build exists |
| Termux x86_64 | `linux-x64-musl` | musl loader |
| Linux glibc x64 / arm64 | `linux-x64` / `linux-arm64` | direct exec |
| Linux musl (Alpine, …) | `*-musl` | auto-detected |
| macOS arm64 / x64 | `darwin-arm64` / `darwin-x64` | |
| Windows x64 / arm64 | `win32-x64` / `win32-arm64` | `.cmd` shims |
| Other (ARMv7, i686, riscv64, ppc64, FreeBSD) | JS build 2.1.112 | feature-frozen fallback |

The installer refuses Node < 18, retries downloads three times, falls back to a built-in
gzip+tar extractor when system `tar` is missing, switches to the musl build on glibc older
than 2.27, and supports `--force-js` / `CC_TERMUX_FORCE_JS=1` to exercise the fallback.

The native binary is fetched fresh from Anthropic's official npm registry on every install;
cc-termux never hosts or redistributes Claude Code.

## Performance mode

Opt-in, off by default, and remembered per install (`cc-termux tune on|off`). It disables
mouse clicks, fancy window titles, undo checkpoints, background work, scheduled tasks, extra
git prompt text and animations. One-off: `CC_TERMUX_PERF=1 claude`.
