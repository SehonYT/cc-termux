# Environment variables

Every variable modelmesh reads, what it does, and its default. Anything not listed here is
part of a third-party tool, not modelmesh.

## Layout

Where modelmesh keeps its files. These override the platform defaults, which are
`~/.config/modelmesh`, `~/.local/share/modelmesh` and `~/.cache/modelmesh` on POSIX and the
`%APPDATA%` equivalents on Windows.

| Variable | Default | Purpose |
|---|---|---|
| `MODELMESH_ROOT` | `~/.local/share/modelmesh` | install root: code, the Claude Code binary, patches |
| `MODELMESH_CONFIG` | `~/.config/modelmesh/config.json` | provider config; `keys.json` sits beside it |
| `MODELMESH_CACHE` | `~/.cache/modelmesh` | logs, session state, model cache |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's own directory. Read, never written except for settings |

The pre-rename names `CC_TERMUX_ROOT`, `CC_TERMUX_CONFIG` and `CC_TERMUX_CACHE` still work as
fallbacks, and the old directories are migrated on first use.

## Gateway

| Variable | Default | Purpose |
|---|---|---|
| `MODELMESH_GATEWAY_TOKEN` | generated | token the local gateway requires; the launcher sets it per run |
| `MODELMESH_REPO` | the upstream repo | which repository `update` fetches from |
| `MODELMESH_NO_BANNER` | unset | `1` hides the banner, for scripted installs |
| `MODELMESH_NO_PROMPT` | unset | `1` skips every interactive question |
| `MODELMESH_NO_WEB_PROMPT` | unset | `1` skips only the web-search question |
| `MODELMESH_NO_TUNE` | unset | `1` skips the optional device tuning step |
| `MODELMESH_PERF_VERBOSE` | unset | `1` logs gateway startup timings |
| `MODELMESH_SHIM_WATCH_MS` | 2000 | how often the shim watcher re-checks |

## Install and update

| Variable | Default | Purpose |
|---|---|---|
| `MODELMESH_FORCE_JS` | unset | `1` installs the JavaScript build instead of a native binary |
| `MODELMESH_COMMIT_SHA` | unset | stamps a build with the commit it came from; set by the updater |
| `MODELMESH_COMMIT_DATE` | unset | the commit's date, for the update check |

## Antigravity

The defaults are the values the official client uses. Override them only to point at a
different endpoint, which is useful for testing.

| Variable | Purpose |
|---|---|
| `MODELMESH_ANTIGRAVITY_CLIENT_ID` | OAuth client id |
| `MODELMESH_ANTIGRAVITY_CLIENT_SECRET` | OAuth client secret |
| `MODELMESH_ANTIGRAVITY_AUTH_URL` | authorization endpoint |
| `MODELMESH_ANTIGRAVITY_TOKEN_URL` | token endpoint |
| `MODELMESH_ANTIGRAVITY_USERINFO_URL` | userinfo endpoint |
| `MODELMESH_ANTIGRAVITY_BOOTSTRAP_URL` | Cloud Code discovery endpoint |
| `MODELMESH_ANTIGRAVITY_GENERATE_URL` | generation endpoint |
| `MODELMESH_ANTIGRAVITY_CODE` | an authorization code, for a scripted login |
| `MODELMESH_ANTIGRAVITY_OAUTH_CALLBACK_URL` | loopback redirect; must match the client |
| `MODELMESH_ANTIGRAVITY_ALL_MODELS` | `1` lists every model the account can see, not only chat models |
| `MODELMESH_ANTIGRAVITY_GROUNDING_MODEL` | which Gemini model runs a grounded search |

Antigravity search uses Google grounding, which only Gemini models honour. That is why
grounding is retargeted to a Gemini model even when another model is answering.

## Web search and fetch

| Variable | Default | Purpose |
|---|---|---|
| `MODELMESH_SEARX_URL` | unset | a SearXNG instance to use as an engine |
| `MODELMESH_GOOGLE_KEY` | unset | Google Custom Search key, used with `MODELMESH_GOOGLE_CX` |
| `MODELMESH_GOOGLE_CX` | unset | Google Custom Search engine id |
| `MODELMESH_WEB_TIMEOUT_MS` | 20000 | per-request timeout |
| `MODELMESH_WEB_MAX_BYTES` | 2 MB | most a single page may return before it is truncated |
| `MODELMESH_WEB_ALLOW_PRIVATE` | unset | `1` allows loopback and private addresses. Off by default: it is an SSRF guard |
| `MODELMESH_WEB_READER_PROXY` | unset | a reader service to fetch pages through |

Search keys for Tavily, Brave and Jina live in `web.json` beside the config, not here.
`modelmesh web key <name> <key>` writes them.

## Setup, for scripted provider creation

`modelmesh setup` can be driven without prompts. Useful in a Dockerfile or a provisioning
script.

| Variable | Purpose |
|---|---|
| `CC_SETUP_NONINTERACTIVE` | `1` never asks; every value must come from the rest |
| `CC_SETUP_PRESET` | a preset id from `presets.json`, for example `openrouter` |
| `CC_SETUP_PROVIDER` | the provider id to create |
| `CC_SETUP_NAME` | display name |
| `CC_SETUP_TYPE` | `openai`, `anthropic`, `gemini` or `antigravity` |
| `CC_SETUP_BASE_URL` | API base URL |
| `CC_SETUP_PATH` | request path, when it is not the default |
| `CC_SETUP_KEY` | the API key |
| `CC_SETUP_MODEL` | default model id |
| `CC_SETUP_CONTEXT` | context window in tokens, when the API does not report one |
| `CC_SETUP_TIER` | `free` or `paid`, for tiered providers |
| `CC_SETUP_BACKGROUND` | `1` starts the gateway after setup |

Example:

```bash
CC_SETUP_NONINTERACTIVE=1 CC_SETUP_PRESET=openrouter CC_SETUP_KEY="$KEY" \
  modelmesh setup
```

## Third-party

Read but not set by modelmesh: `APPDATA`, `LOCALAPPDATA`, `PATH`, `PREFIX` (Termux),
`TOKENS_BD_KEY`. The `CC_TERMUX_*` variables are the pre-rename names and still work.
