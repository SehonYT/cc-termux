# Troubleshooting

Start with:

```bash
cc-termux doctor          # providers, keys, gateway, picker, patches, deny rules
cc-termux diagnose        # deep install + gateway + key checks
cc-termux status          # gateway, active provider and model
```

## Quick reference

| Symptom | Cause / fix |
|---|---|
| `Prompt is too long` | the active model's context window is small; `cc-termux use <id>` refreshes it |
| `401` / `403` | wrong key or missing permission; re-run `cc-termux setup` |
| `429 ... quota` | provider quota. `cc-termux usage <provider>` shows the observed limit; hard quotas fail fast |
| model returns an empty answer | the provider rejected the tool schema; switch model or provider |
| provider does not appear in `/model` | `cc-termux sync-picker`, then reopen the picker |
| gateway down | `cc-termux restart`, then run `claude` again |
| `can't connect to the API server` | the gateway is not reachable; check `cc-termux status`, `curl http://127.0.0.1:8788/health` and `cc-termux logs` |
| `no provider configured on this machine` | expected on a fresh install; run `cc-termux setup` |
| proxy variables break localhost | add `127.0.0.1` to `NO_PROXY` when `HTTP_PROXY`/`HTTPS_PROXY` are set |

## `Error relocating ... libtermux-exec-ld-preload.so`

The musl loader inherited Termux's bionic `LD_PRELOAD`. The launcher strips it, so updating
cc-termux fixes it. Installing `patchelf` (`pkg install patchelf`) switches the install to
direct exec and avoids loader mode entirely.

## Claude shows an Anthropic model and "invalid API key"

`claude` resolves to a different build (an official npm/native install earlier in `PATH`)
instead of the cc-termux shim, so it talks to Anthropic directly.

- `cc-termux diagnose` shows `claude ... [NOT ours]` and validates each provider key.
- `cc-termux doctor --fix` backs the foreign binary up to `claude.official-backup` and
  installs the shim.

## Claude shows Opus although setup selected another model

Claude Code's `settings.json` can contain a stale `model` or an `env` block with
`ANTHROPIC_MODEL` / `ANTHROPIC_BASE_URL`; settings env wins over the launcher. The launcher
repairs both at startup and logs it, and `cc-termux doctor --fix` does the same on demand.

## Setup lists providers without keys

An older install copied the sample config. Remove those entries in `cc-termux setup` with
`r`, or delete `~/.config/cc-termux/config.json` and re-run setup. New installs start empty.

## `Cross-session messaging is off` warning

Some devices run Claude Code inside a user namespace without a uid map (for example some
proot/Termux setups). Claude Code then refuses its shared socket directory because it cannot
verify file ownership. This only disables cross-session messaging; Claude itself works.

The launcher passes an explicit `CLAUDE_CODE_MESSAGING_SOCKET` pointing at
`~/.cache/cc-termux/messaging/messaging.sock` (directory mode 0700), which fixes the socket
setup on affected devices. If the warning persists, the process really has no uid mapping and
no userspace workaround can enable the feature; it is safe to ignore. Running under a mapped
namespace (`unshare -Ur`, where supported) restores it.

## Logs

| File | Contents |
|---|---|
| `~/.cache/cc-termux/gateway.log` | gateway output: startup, requests, retries |
| `~/.cache/cc-termux/errors.log` | one JSON line per failure: `{ at, kind, provider, model, status, message }` |

```bash
cc-termux logs
cc-termux errors 50
```

## Still stuck?

Open an issue with the output of `cc-termux diagnose`, your platform and the last lines of
`cc-termux logs`. For quick help, join the [Discord server](https://discord.gg/AF8zvEDcSG).
