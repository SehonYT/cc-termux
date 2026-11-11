<div align="center">
  <img src="assets/logo.png" alt="cc-termux" width="150">

  <h1>cc-termux</h1>

  <p><strong>Claude Code, anywhere, on any model.</strong></p>

  <p>Run Anthropic's Claude Code on Android/Termux, Linux, macOS and Windows — with no<br>
  Anthropic account — and point it at Gemini, OpenRouter, Antigravity, tokens.bd, Ollama<br>
  or any other OpenAI- and Anthropic-compatible endpoint.</p>

  <p>
    <a href="https://github.com/SehonYT/cc-termux/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/SehonYT/cc-termux/ci.yml?branch=main&style=flat-square" alt="CI"></a>
    <a href="https://github.com/SehonYT/cc-termux/releases"><img src="https://img.shields.io/github/v/tag/SehonYT/cc-termux?style=flat-square&label=release" alt="Release"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT"></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-3c873a?style=flat-square" alt="Node 18+"></a>
    <img src="https://img.shields.io/badge/platforms-Termux%20%7C%20Linux%20%7C%20macOS%20%7C%20Windows-lightgrey?style=flat-square" alt="Platforms">
    <a href="https://github.com/anthropics/claude-code"><img src="https://img.shields.io/badge/Claude%20Code-2.1.x-8a2be2?style=flat-square" alt="Claude Code 2.1.x"></a>
    <a href="https://discord.gg/AF8zvEDcSG"><img src="https://img.shields.io/badge/Discord-join%20the%20server-5865F2?logo=discord&logoColor=white&style=flat-square" alt="Discord"></a>
  </p>

  <p>
    <a href="#quick-start">Quick start</a> ·
    <a href="#features">Features</a> ·
    <a href="#providers">Providers</a> ·
    <a href="#commands">Commands</a> ·
    <a href="docs/ARCHITECTURE.md">Architecture</a> ·
    <a href="docs/TROUBLESHOOTING.md">Troubleshooting</a>
  </p>
</div>

---

**cc-termux** is a cross-platform installer and local gateway that makes Claude Code run
where Anthropic does not ship a supported build, and makes it talk to whatever model you
actually pay for.

- **One command to install** — Claude Code plus everything around it, with a provider wizard.
- **35 providers out of the box** — OpenAI, Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI,
  local Ollama/LM Studio/llama.cpp, and many more. Custom endpoints too.
- **One gateway, four protocols** — Anthropic Messages, OpenAI chat completions, OpenAI
  Responses and Google Antigravity, translated per provider.
- **Termux-first** — runs on Android, including 32-bit userlands on aarch64 kernels.

## Quick start

macOS, Linux and Termux:

```bash
curl -fsSL https://raw.githubusercontent.com/SehonYT/cc-termux/main/get.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/SehonYT/cc-termux/main/get.ps1 | iex
```

The installer downloads the official Claude Code build for your platform from Anthropic's
npm registry, then starts a three-step setup:

1. **Pick a provider** — a preset, or any OpenAI/Anthropic-compatible base URL.
2. **Paste a key** — validated immediately (or use Google OAuth for Antigravity).
3. **Pick a model** — searchable list with context window and price where the provider
   exposes them.

That writes the gateway configuration and makes `claude` use it. Re-run the wizard at any
time with `cc-termux setup`.

> **Requirements:** Node.js 18+ (installed automatically if missing), `tar`, and a shell.
> Termux optionally uses `patchelf`. Offline installs and custom roots are supported.

## Features

| Feature | What you get |
|---|---|
| **Any provider** | 35 presets plus custom OpenAI- and Anthropic-compatible endpoints. No Anthropic login, no Claude subscription. |
| **Model picker** | Every provider's models appear in Claude Code's `/model` picker with context window and price. Switch models mid-session. |
| **Provider switching** | `/provider`, `cc-termux provider <name>`, or a `provswitch/` picker row. The gateway reloads config per request, so it applies to a running session. |
| **No hidden fallback** | A request is only ever sent to the provider you selected. No cross-provider silent rerouting. |
| **Tool calling** | Anthropic tools, tool choice and tool results are translated to the upstream schema, including streamed partial arguments. |
| **Auto mode** | Claude Code's safety classifier works behind the gateway: the launcher forces the local classifier and the gateway gives it a fast verdict budget. |
| **Web Search + Web Fetch** | A bundled MCP server searches Google, Brave, DuckDuckGo and Bing, merges and ranks what comes back, reports which engines answered, and fetches pages with SSRF protection and prompt-injection fencing. |
| **Antigravity (OAuth)** | Google-account access to Cloud Code models, quota reporting in the status line, and model discovery from Google's own list. |
| **Self-healing installs** | Install and update repair PATH, settings, picker, patches and stale config automatically. `cc-termux doctor --fix` on demand. |
| **Performance mode** | One opt-in switch that turns off animations, mouse, checkpoints, background work and more on phones and slow machines. |

<details>
<summary><strong>More detail</strong></summary>

- **Termux support**: the official `linux-arm64-musl` build is executed through an Alpine
  musl loader; devices with a 32-bit userland fall back to the last JavaScript build.
- **Native install layout**: `claude` is installed the way Claude Code's own `/status`
  expects, so diagnostics stay clean.
- **Self-update**: `cc-termux update` updates the tool and, only when needed, the Claude Code
  binary. A once-a-day notice appears in interactive sessions.
- **Optional UI patches**: rename the model picker and add provider hints. Data-driven from
  `patches.json`, skipped automatically when an anchor is missing, revertible at any time.
- **Failure logs**: every upstream, stream and gateway failure is persisted and shown by
  `cc-termux errors`, with secrets redacted.
- **Search backends**: a SearXNG endpoint (`CC_TERMUX_SEARX_URL`) or a Google Custom Search
  key is used automatically when configured, which is the reliable option on networks where
  Google and Brave answer with an anti-bot wall.

</details>

## Providers

<details open>
<summary><strong>35 built-in presets</strong></summary>

| Preset | Provider | Auth | Notes |
|---|---|---|---|
| `openrouter` | OpenRouter | API key | free models end with `:free` |
| `gemini` | Google Gemini (AI Studio) | API key | free tier is per-key |
| `antigravity` | Google Antigravity | Google OAuth | Claude and Gemini models via Cloud Code |
| `tokens` | tokens.bd | API key | also exposes an Anthropic-compatible endpoint |
| `groq` | Groq | API key | |
| `deepseek` | DeepSeek | API key | |
| `xai` | xAI (Grok) | API key | |
| `mistral` | Mistral | API key | |
| `cerebras` | Cerebras | API key | |
| `nvidia` | NVIDIA NIM | API key | |
| `together` | Together AI | API key | |
| `fireworks` | Fireworks AI | API key | |
| `huggingface` | HuggingFace Router | API key | |
| `github-models` | GitHub Models | API key | |
| `sambanova` | SambaNova | API key | |
| `novita` | Novita AI | API key | |
| `nebius` | Nebius AI Studio | API key | |
| `chutes` | Chutes | API key | |
| `scaleway` | Scaleway Generative APIs | API key | |
| `ovh` | OVHcloud AI Endpoints | API key | |
| `zai` | Z.AI (GLM) | API key | |
| `moonshot` | Moonshot (Kimi) | API key | |
| `qwen` | Qwen (DashScope) | API key | |
| `minimax` | MiniMax | API key | |
| `siliconflow` | SiliconFlow | API key | |
| `deepinfra` | DeepInfra | API key | |
| `upstage` | Upstage | API key | |
| `perplexity` | Perplexity | API key | |
| `cohere` | Cohere compatibility API | API key | |
| `requesty` | Requesty Router | API key | |
| `featherless` | Featherless AI | API key | |
| `agentrouter` | AgentRouter | API key | |
| `ollama` | Ollama | local | `http://127.0.0.1:11434/v1` |
| `lmstudio` | LM Studio | local | `http://127.0.0.1:1234/v1` |
| `llamacpp` | llama.cpp server | local | `http://127.0.0.1:8080/v1` |

</details>

Any other OpenAI-compatible or Anthropic-compatible endpoint can be added by URL. Local
servers work without a key; a dummy key is accepted if the server requires an authorization
header.

```bash
cc-termux presets                                        # list every preset
cc-termux setup --preset openrouter --key sk-or-...      # non-interactive setup
cc-termux setup --provider custom --type openai --base-url https://host/v1 --key ...
```

## Usage

```bash
claude                          # Claude Code, routed through the local gateway
claude -p "explain this repo"   # headless
```

Switch providers while working:

```
/provider                    # in-session selector
/model                       # picker: switch rows and every provider model
!cc-termux provider tokens   # local command, works even with no credit
```

## Commands

**Getting started**

- `cc-termux setup` — interactive provider wizard
- `cc-termux status` — gateway, active provider, model and quota dashboard
- `cc-termux doctor [--fix]` — self-check and repair
- `cc-termux test [prompt]` — headless request through the gateway

**Providers and models**

- `cc-termux provider [name|list]` — list or switch provider
- `cc-termux models [--all]` — model catalog with context window and price
- `cc-termux use <model-id>` — switch model and aliases
- `cc-termux key <provider> <key>` — store an API key
- `cc-termux sync` / `sync-picker` — refresh catalog / rebuild the `/model` picker
- `ccp` — standalone provider picker

**Google Antigravity**

- `cc-termux antigravity login` — Google OAuth login
- `cc-termux antigravity usage` — live 5-hour and weekly quota
- `cc-termux antigravity models --update` — refresh models from Google
- `cc-termux statusline --install` — model and quota in Claude's status line

**Maintenance**

- `cc-termux update [--check]` — update cc-termux (and Claude Code when needed)
- `cc-termux update-claude` — reinstall the Claude Code binary
- `cc-termux patch [status|revert]` — optional TUI patches
- `cc-termux heal` — auto-repair PATH, settings and picker
- `cc-termux restart` — stop the gateway
- `cc-termux logs` / `errors [n]` — gateway log / recent failures
- `cc-termux diagnose` — deep install, gateway and key check
- `cc-termux tune [on|off]` — performance mode
- `cc-termux path` — print install and config paths

## How it works

```
claude (shim) --> bin/cc-launcher.mjs
                    |  starts and supervises the gateway
                    |  sets ANTHROPIC_BASE_URL=http://127.0.0.1:8788
                    v
              proxy/server.mjs
                    |-- Anthropic Messages passthrough   -> /v1/messages
                    |-- OpenAI chat completions           -> /v1/chat/completions
                    |-- OpenAI Responses API              -> /v1/responses
                    +-- Google Antigravity (OAuth)        -> v1internal:streamGenerateContent
                    v
              your provider
```

The gateway binds to loopback only, reloads its configuration per request, translates
requests, responses and streaming events, retries transient upstream failures with backoff,
and records every failure. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the details.

## Configuration

| | Termux / Linux / macOS | Windows |
|---|---|---|
| Code, Claude Code binary, patches | `~/.local/share/cc-termux` | `%LOCALAPPDATA%\cc-termux` |
| Config and API keys | `~/.config/cc-termux` | `%APPDATA%\cc-termux` |
| Cache, logs, status line | `~/.cache/cc-termux` | `%LOCALAPPDATA%\cc-termux\cache` |
| Claude Code's own settings | `~/.claude` | `%USERPROFILE%\.claude` |

`~/.config/cc-termux/config.json`:

```json
{
  "listen": { "host": "127.0.0.1", "port": 8788 },
  "active": "tokens",
  "override": { "provider": "tokens", "model": "deepseek/deepseek-v4.1-flash" },
  "routing": { "prov/tokens/deepseek/deepseek-v4.1-flash": "tokens::deepseek/deepseek-v4.1-flash" },
  "providers": {
    "tokens": {
      "type": "openai",
      "baseUrl": "https://tokens.bd",
      "path": "/v1/chat/completions",
      "apiMode": "auto",
      "model": "deepseek/deepseek-v4.1-flash",
      "contextWindow": 1000000,
      "aliases": { "opus": "...", "sonnet": "...", "haiku": "..." },
      "retries": 5
    }
  }
}
```

Keys are stored separately in `~/.config/cc-termux/keys.json` (mode 0600), never in
`config.json`, the environment passed to Claude Code, or the model picker.

Overrides: `CC_TERMUX_ROOT`, `CC_TERMUX_CONFIG`, `CC_TERMUX_CACHE`, and Claude's own
`CLAUDE_CONFIG_DIR`.
## Security

- The gateway listens on `127.0.0.1` only.
- API keys live in a 0600 file and are masked in all command output and logs.
- The installer adds `permissions.deny` rules to `~/.claude/settings.json` so the agent's
  file tools cannot read the config directory.
- Web access from the agent goes through an SSRF-guarded MCP server; fetched content is
  fenced and treated as data, not instructions.
- Claude Code is always downloaded from Anthropic's official npm registry. cc-termux never
  hosts or redistributes it.

This is a single-user tool: the gateway and the agent share an OS account, so file
permissions are a guardrail, not a security boundary. Run it on a device you control. See
[SECURITY.md](SECURITY.md) for reporting a vulnerability.

## Platform support

| Host | Build used |
|---|---|
| Termux aarch64, or 32-bit Termux on an AArch64 kernel | official `linux-arm64-musl` + Alpine musl loader |
| Termux x86_64 | official `linux-x64-musl` + musl loader |
| Linux x64 / arm64 (glibc) | official `linux-x64` / `linux-arm64` |
| Linux musl distributions | official `*-musl` builds (auto-detected) |
| macOS arm64 / x64 | official `darwin-arm64` / `darwin-x64` |
| Windows x64 / arm64 | official `win32-x64` / `win32-arm64` |
| Everything else (ARMv7, i686, riscv64, ppc64, FreeBSD, …) | JavaScript build 2.1.112 (feature-frozen fallback) |

The installer refuses Node < 18, retries downloads three times with backoff, falls back to a
built-in gzip+tar extractor when system `tar` is missing, switches to the musl build on glibc
older than 2.27, and supports `--force-js` / `CC_TERMUX_FORCE_JS=1` to exercise the fallback.

## Updates and self-repair

```bash
cc-termux update --check    # is a newer cc-termux available?
cc-termux update            # self-update; skips the binary when it is current
cc-termux update-claude     # reinstall the Claude Code binary + patches
cc-termux heal              # run the repair pass on demand
```

Install and update keep your configuration and keys, re-apply the optional UI patches, and
repair a stale `settings.model`, foreign `claude` binaries earlier in `PATH`, the `/model`
picker and config permissions. A newer commit notice appears at most once per 24 hours in
interactive sessions.

## Manual install

```bash
git clone https://github.com/SehonYT/cc-termux && cd cc-termux
bash install.sh                 # Linux, macOS, Termux
powershell -File install.ps1    # Windows
node install.mjs                # any platform, no shell wrapper
node install.mjs --check        # print the plan, touch nothing
```

Useful flags: `--root <dir>`, `--tarball <file>` (offline), `--version <v>`,
`--no-setup`, `--no-shims`.

## Development

```bash
npm test              # all suites, sequentially
npm test -- translate # filter by suite name
npm run check         # syntax, JSON and shell checks
```

Tests use Node's built-in `node:test` and need no dependencies. CI runs both commands on
Ubuntu, macOS and Windows across Node 18, 20 and 22, plus an install smoke test. See
[tests/README.md](tests/README.md) for every suite.

```
get.sh, get.ps1                        one-line bootstrap installers
install.mjs, install.sh, install.ps1   local installers
bin/cc-launcher.mjs                    cross-platform launcher + gateway supervisor
bin/cc-termux                          control CLI
bin/cc-setup.mjs                       provider wizard
bin/cc-mcp.mjs                         web search/fetch MCP server
proxy/server.mjs                       gateway, routing, retries
proxy/translate.mjs                    Anthropic <-> OpenAI translation layer
proxy/antigravity.mjs                  Google Antigravity adapter
patches.json                           data-driven binary patches
presets.json                           provider presets
docs/                                  architecture and troubleshooting
tests/                                 test suites (node:test)
```

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Every push to `main` is
tagged by CI as `v<version>-<short sha>`.

## Limitations

- Non-Anthropic models through Claude Code are best-effort; tool-calling quality varies.
- Android background sessions and some clipboard features are unavailable.
- UI patches are tied to specific release strings and may be skipped after an update.
- Windows and macOS installs use the same Node installer but are less battle-tested than
  Linux/Termux.
- Some sites answer automated clients with a JavaScript bot challenge; Web Fetch reports
  those as blocked instead of returning content.

## Community

Setups, release notes and help: [join the cc-termux Discord](https://discord.gg/AF8zvEDcSG).

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE). This project is unofficial and not
affiliated with Anthropic. Claude Code remains subject to Anthropic's terms.
