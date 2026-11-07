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

- Node.js 18+ — **installed automatically if missing**: Termux uses `pkg install nodejs-lts`, Linux/macOS download the official Node tarball into `~/.local/share/cc-termux/runtime`, Windows downloads the official zip
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

## Updates

cc-termux updates itself, separately from the Claude Code binary:

```bash
cc-termux update --check   # is a newer cc-termux available?
cc-termux update           # self-update; skips the Claude Code binary download when it is current
cc-termux update --redownload # force reinstall of the Claude Code binary + patches
cc-termux update-claude    # only reinstall the Claude Code binary
```

When Claude Code is launched interactively, the launcher checks at most once per 24 hours (2.5 s timeout,
silent on failure) and prints a one-line notice if a newer commit is available. Installed state is kept
in `~/.local/share/cc-termux/cc-termux.json` (`version`, commit `sha`, `installedAt`).

## First run

Non-interactive setup is available too:

```bash
cc-termux setup --preset openrouter --key sk-or-... [--test]
cc-termux setup --provider tokens --key tok_live_... --model deepseek/deepseek-v4.1-flash
cc-termux setup --provider custom --type openai --base-url https://host/v1 --key ...
cc-termux setup --help
```

In the interactive wizard the model list supports **search** (type any part of a model id/name instead
of a number), and after adding a provider it offers to send a small test request (`--test` forces it).


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

## Platform support

| Host | Build used |
|---|---|
| Termux aarch64, or 32-bit Termux on an AArch64 kernel | official `linux-arm64-musl` + Alpine musl loader |
| Termux x86_64 | official `linux-x64-musl` + musl loader |
| Linux x64 / arm64 (glibc) | official `linux-x64` / `linux-arm64` |
| Linux musl distros | official `*-musl` builds (auto-detected) |
| macOS arm64 / x64 | official `darwin-arm64` / `darwin-x64` |
| Windows x64 / arm64 | official `win32-x64` / `win32-arm64` |
| Everything else (ARMv7, i686, riscv64, ppc64, FreeBSD, …) | JS build 2.1.112 (feature-frozen fallback) |

The installer additionally:

- refuses to run on Node < 18 with a clear message
- retries downloads three times with backoff
- falls back to a built-in gzip+tar extractor when the system `tar` is missing
- switches to the musl build on glibc older than 2.27
- supports `--force-js` / `CC_TERMUX_FORCE_JS=1` to test the fallback path

## UI patches (data-driven)

Patch definitions are in `patches.json`, not code. Each anchor may be a list of alternatives,
so a new Claude Code release can be supported by editing JSON. Install/update re-applies them,
missing anchors are skipped with a message, and the unpatched binary stays in `claude.bin.orig`.

```bash
cc-termux patch status
cc-termux patch revert
```

## Automatic repair on install

`install.mjs` runs a self-heal step after every install/update (`bin/cc-heal.mjs`), so no manual
`doctor --fix` is needed:

- removes `ANTHROPIC_*` / context override keys from `~/.claude/settings.json` `env`
- replaces a stale `model` (`default`, `opus`/`sonnet`/`haiku`, bare `claude-*-<n>`) with the active provider model
- replaces foreign `claude` binaries earlier in `PATH` with the cc-termux shim (original kept as `claude.official-backup`)
- removes sample provider entries left by older releases (no key, no catalog)
- repairs config sanity (active provider, override, routing table, 0600 permissions)
- regenerates `/model` picker rows and `settings.model`
- reinstalls missing launcher shims in `$PREFIX/bin`
- clears stale session files / idle gateways and rotates logs over 5 MB
- restores `~/.claude/commands/provider.md` when missing

It is idempotent and also available on demand:

```bash
cc-termux heal
```

## Tests

```bash
npm run check     # syntax + JSON validation
npm test          # heal, gateway contract and installer-plan tests
```

CI runs both on Node 18/20/22. The heal test plants a foreign `claude` binary, a stale settings
file and a sample config in a temp directory and asserts all three are repaired; gateway tests
assert the no-provider error and that upstream failures land in `errors.log`.

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
| Claude shows Opus 5.5 **and** "invalid API key" together | `claude` resolves to a different build (official npm/native install earlier in `PATH`) instead of the cc-termux shim, so it talks to Anthropic directly. `cc-termux diagnose` shows `claude ... [NOT ours]`; `cc-termux doctor --fix` backs the foreign binary up to `claude.official-backup` and installs the shim. `cc-termux diagnose` also validates each provider key against its models endpoint |
| Claude shows Opus 5.5 although setup selected another model | `~/.claude/settings.json` contains a stale `model` **or** an `env` block with `ANTHROPIC_MODEL` / `ANTHROPIC_BASE_URL` (settings env wins over the launcher). The launcher now repairs both at startup and logs it; `cc-termux doctor --fix` does the same on demand | stale `settings.json` model (missing or a bare Anthropic id). The launcher pins the provider model for that case and `cc-termux doctor --fix` rewrites `settings.model` |
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
