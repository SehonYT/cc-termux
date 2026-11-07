# cc-termux

[![CI](https://github.com/SehonYT/cc-termux/actions/workflows/ci.yml/badge.svg)](https://github.com/SehonYT/cc-termux/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-3c873a)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platforms-Termux%20%7C%20Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)]
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1.x-8a2be2)](https://github.com/anthropics/claude-code)

Run [Claude Code](https://claude.com/claude-code) on Linux, macOS, Windows and Android/Termux, and connect it to the model provider of your choice through a local gateway.

## Quick install

```bash
# macOS / Linux / Termux
curl -fsSL https://raw.githubusercontent.com/SehonYT/cc-termux/main/get.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/SehonYT/cc-termux/main/get.ps1 | iex
```

Prefer a clone? See [Manual install](#manual-install).

## What it solves

- **Android/Termux**: modern Claude Code releases ship native binaries only (no `cli.js`).
  Termux uses bionic libc, and many devices run a 32-bit userland on an aarch64 kernel.
  `cc-termux` handles both: the official `linux-arm64-musl` build is executed through an
  Alpine musl loader, and 32-bit-only devices fall back to the last JavaScript build.
- **Providers**: Claude Code speaks the Anthropic Messages API only. The gateway translates that
  to OpenAI chat completions or the OpenAI Responses API, or passes it through to any
  Anthropic-compatible endpoint.
- **Multi-provider**: keep several providers configured, switch mid-session when one is rate
  limited, and keep provider models in the `/model` picker.

## Requirements

- Node.js 18 or newer (Termux: `pkg install nodejs`)
- `tar` (present on Linux, macOS, Termux and Windows 10+)
- Termux only: optional `patchelf` (installed automatically when available)

## Manual install

Clone the repository first: `git clone https://github.com/SehonYT/cc-termux && cd cc-termux`.

Linux, macOS, Termux:

```bash
bash install.sh
```

Windows (PowerShell):

```powershell
powershell -File install.ps1
```


Any platform without a shell wrapper:

```bash
node install.mjs
node install.mjs --check      # print the install plan, touch nothing
```

The installer is idempotent: running it again upgrades the Claude Code binary, keeps your
configuration and keys, and re-applies the optional UI patches.

Useful flags: `--root <dir>`, `--tarball <file>` (offline install), `--version <v>`,
`--no-setup`, `--no-shims`.

## First run

After installing, a setup wizard runs. It asks for a provider, validates the key, fetches the
model list (with context window and price where the provider exposes them) and writes the
gateway configuration. Re-run it any time with `cc-termux setup`, or pick a built-in preset:

```
cc-termux presets
cc-termux setup        # choose "6" for free/online presets
```

### Provider presets

| Preset | Base URL | Key |
|---|---|---|
| openrouter | `https://openrouter.ai/api/v1` | yes, free `:free` models |
| gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | yes |
| groq | `https://api.groq.com/openai/v1` | yes |
| cerebras | `https://api.cerebras.ai/v1` | yes |
| mistral | `https://api.mistral.ai/v1` | yes |
| nvidia | `https://integrate.api.nvidia.com/v1` | yes |
| sambanova | `https://api.sambanova.ai/v1` | yes |
| huggingface | `https://router.huggingface.co/v1` | yes |
| github-models | `https://models.github.ai/inference` | GitHub token |
| together | `https://api.together.xyz/v1` | yes |
| ollama | `http://127.0.0.1:11434/v1` | no (local) |
| lmstudio | `http://127.0.0.1:1234/v1` | no (local) |
| llamacpp | `http://127.0.0.1:8080/v1` | no (local) |
| tokens | `https://tokens.bd` | yes |

Custom OpenAI-compatible and Anthropic-compatible endpoints can be added by URL.

## Usage

```bash
claude                 # normal Claude Code, routed through the local gateway
claude -p "..."        # headless
```

### Switching providers

```
/provider            # selector (needs a working model to answer)
/model               # picker: switch rows and every provider model
!cc-termux provider <name>   # local bash command, works even with no credit
cc-termux provider <name>    # from another terminal
```

The gateway reloads its configuration per request, so a switch applies to a running session.
`/model` rows named `provswitch/<provider>` change the provider; other rows select a model.

### Commands

 | Command | Description |
|---|---|
| `cc-termux status` | gateway, providers, model and context |
| `cc-termux setup` | add or change a provider (interactive) |
| `cc-termux presets` | list built-in provider presets |
| `cc-termux models` | cached model catalog with context and price |
| `cc-termux use <id>` | set a model and its context limit |
| `cc-termux provider [name\|list\|off]` | list or switch providers |
| `cc-termux key <provider> <key>` | store a key |
| `cc-termux doctor [--fix]` | self-check and repair |
| `cc-termux sync` | refresh the model catalog |
| `cc-termux sync-picker` | rebuild the `/model` picker |
| `cc-termux usage [provider]` | spend windows, key caps, observed quota |
| `cc-termux patch [status\|revert]` | UI byte patches |
| `cc-termux update` | reinstall the latest Claude Code |
| `ccp` | standalone provider picker TUI |

## Architecture

```
claude (shim) -> bin/cc-launcher.mjs
                   |  starts and supervises the gateway
                   |  sets ANTHROPIC_BASE_URL=http://127.0.0.1:8788
                   v
             proxy/server.mjs
                   |-- Anthropic Messages passthrough  -> /v1/messages
                   |-- OpenAI chat completion adapter    -> /v1/chat/completions
                   |-- OpenAI Responses adapter          -> /v1/responses
                   v
             provider (tokens.bd, OpenRouter, Gemini, Groq, Ollama, ...)
```

The gateway selects the adapter per provider (`apiMode: auto`), translates tools, tool results,
streaming events and usage, and strips Anthropic-only fields that third-party endpoints reject.

## Configuration

`~/.config/cc-termux/config.json` (created on install):

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

Keys are kept separately in `~/.config/cc-termux/keys.json` (0600) and are never written into
`config.json`, the environment passed to Claude Code, or the model picker.

## Security

- The gateway binds to `127.0.0.1` only.
- API keys live in a 0600 file, masked in all command output.
- The installer adds `permissions.deny` rules to `~/.claude/settings.json` so the agent cannot
  read the configuration directory with its file tools.
- This is a single-user tool: the gateway and the agent share an OS account, so file permissions
  are a guardrail, not a security boundary. Run it on a device you control.

## UI patches (optional)

`bin/cc-patch.mjs` can rewrite a few equal-length byte ranges in the installed binary to rename
the model picker and add provider hints. Patches are re-applied by the installer, are skipped
automatically when an anchor is missing in a new release, and can be removed:

```bash
cc-termux patch status
cc-termux patch revert
CC_TERMUX_NO_UI_PATCH=1 bash install.sh   # skip on install
```

See `NOTICE` for the caveats.

## Gateway lifecycle

The gateway is not a daemon. It starts when `claude` runs and stops when the last Claude Code
session exits:

- `claude` / `claude -p` -> launcher registers a session file in `~/.cache/cc-termux/sessions/`,
  starts `proxy/server.mjs` if it is not already up, then execs Claude Code. `--version` and
  `--help` do not start it.
- on exit the launcher removes its session file; when no sessions remain it stops the gateway.
- the gateway also self-exits after ~10s without live session files (managed mode).
- concurrent sessions share one gateway; the last one to exit stops it.
- stale instances are killed before a new gateway starts, and `cc-termux restart` stops all of them.

## Failure logs

Every failure is persisted, not just printed:

- `~/.cache/cc-termux/gateway.log` - raw gateway output (startup, requests, retries).
- `~/.cache/cc-termux/errors.log` - one JSON line per failure:
  `{ at, kind, provider, model, status, message }` where `kind` is `upstream`, `stream` or `gateway`.

```bash
cc-termux errors          # last 20 failures, formatted
cc-termux errors 50       # more
cc-termux logs            # raw gateway log tail
```

Upstream HTTP failures include status and the provider's message (no keys are written).
Stream errors, gateway exceptions and provider switchovers are recorded too.

## Diagnostics

```bash
cc-termux doctor          # providers, keys, gateway, picker, patches, deny rules
cc-termux doctor --fix    # repair stale settings, picker, override, gemini catalog, log size
cc-termux usage <provider>
cc-termux logs
```

## Troubleshooting

 | Symptom | Cause / fix |
|---|---|
| `Prompt is too long` | context window of the active model is small; `cc-termux use <id>` refreshes it |
| `401`/`403` | wrong key or missing permission; re-run `cc-termux setup` |
| `429 ... quota` | provider quota. `cc-termux usage <provider>` shows the observed limit; the gateway retries transient limits and fails fast on hard quotas |
| model returns an empty answer | provider rejected the tool schema; switch model or provider |
| `Error relocating ... libtermux-exec-ld-preload.so` | the musl loader inherited Termux's bionic `LD_PRELOAD`. The launcher now strips it; update with the install command. Installing `patchelf` (`pkg install patchelf`) switches to direct exec and avoids loader mode entirely |
| setup lists providers with `no key` | an older install copied the sample config. Remove them with `cc-termux setup` -> `r`, or delete `~/.config/cc-termux/config.json` and re-run setup. New installs start empty |
| provider does not appear in `/model` | `cc-termux sync-picker`, then reopen the picker |
| Claude shows Opus 5.5 although setup selected another model | stale `settings.json` model (missing or a bare Anthropic id). The launcher pins the provider model for that case and `cc-termux doctor --fix` rewrites `settings.model` |
| gateway down | `cc-termux restart`, then run `claude` again |
| `can't connect to the API server` | the local gateway is not reachable. Check `cc-termux status`, `curl http://127.0.0.1:8788/health` and `tail -30 ~/.cache/cc-termux/gateway.log`. If no provider is configured, run `cc-termux setup`. Launcher now prints the gateway log tail when startup fails |
| `no provider configured on this machine` | expected on a fresh install: run `cc-termux setup` and add a provider key |
| proxy variables break localhost | if `HTTP_PROXY`/`HTTPS_PROXY` are set, add `127.0.0.1` to `NO_PROXY` |

## Project layout

```
get.sh, get.ps1                        one-line bootstrap installers
install.mjs, install.sh, install.ps1   local installers
bin/cc-launcher.mjs                    cross-platform launcher + gateway supervisor
bin/cc-termux                          control CLI
bin/cc-setup.mjs                       provider wizard
bin/cc-patch.mjs                       optional UI patches
bin/ccp.mjs                            standalone picker
bin/cc-env.mjs                         model/context environment for Claude Code
proxy/server.mjs                       gateway and protocol adapters
presets.json                           provider presets
commands/provider.md                   /provider slash command
tests/                                 mock upstreams for development
```

## Limitations

- Non-Anthropic models through Claude Code are best-effort; tool calling quality varies.
- Android background sessions and some clipboard features are unavailable.
- The UI patches are tied to specific release strings and may be skipped after updates.
- Windows and macOS installs are implemented in the Node installer but are less tested than
  Linux/Termux.

## License

MIT. See `LICENSE` and `NOTICE`. This project is unofficial and not affiliated with Anthropic.
Claude Code itself remains subject to Anthropic's terms.
