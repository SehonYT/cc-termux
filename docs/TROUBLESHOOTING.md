# Troubleshooting

Start with:

```bash
modelmesh doctor          # providers, keys, gateway, picker, patches, deny rules
modelmesh diagnose        # deep install + gateway + key checks
modelmesh status          # gateway, active provider and model
```

## Quick reference

| Symptom | Cause / fix |
|---|---|
| `Prompt is too long` | the active model's context window is small; `modelmesh use <id>` refreshes it |
| `401` / `403` | wrong key or missing permission; re-run `modelmesh setup` |
| `429 ... quota` | provider quota. `modelmesh usage <provider>` shows the observed limit; hard quotas fail fast |
| model returns an empty answer | the provider rejected the tool schema; switch model or provider |
| provider does not appear in `/model` | `modelmesh sync-picker`, then reopen the picker |
| gateway down | `modelmesh restart`, then run `claude` again |
| `can't connect to the API server` | the gateway is not reachable; check `modelmesh status`, `curl http://127.0.0.1:8788/health` and `modelmesh logs` |
| `no provider configured on this machine` | expected on a fresh install; run `modelmesh setup` |
| proxy variables break localhost | add `127.0.0.1` to `NO_PROXY` when `HTTP_PROXY`/`HTTPS_PROXY` are set |

## `Error relocating ... libtermux-exec-ld-preload.so`

The musl loader inherited Termux's bionic `LD_PRELOAD`. The launcher strips it, so updating
modelmesh fixes it. Installing `patchelf` (`pkg install patchelf`) switches the install to
direct exec and avoids loader mode entirely.

## Claude shows an Anthropic model and "invalid API key"

`claude` resolves to a different build (an official npm/native install earlier in `PATH`)
instead of the modelmesh shim, so it talks to Anthropic directly.

- `modelmesh diagnose` shows `claude ... [NOT ours]` and validates each provider key.
- `modelmesh doctor --fix` backs the foreign binary up to `claude.official-backup` and
  installs the shim.

## Claude shows Opus although setup selected another model

Claude Code's `settings.json` can contain a stale `model` or an `env` block with
`ANTHROPIC_MODEL` / `ANTHROPIC_BASE_URL`; settings env wins over the launcher. The launcher
repairs both at startup and logs it, and `modelmesh doctor --fix` does the same on demand.

## Setup lists providers without keys

An older install copied the sample config. Remove those entries in `modelmesh setup` with
`r`, or delete `~/.config/modelmesh/config.json` and re-run setup. New installs start empty.

## `Cross-session messaging is off` warning

Some devices run Claude Code inside a user namespace without a uid map (for example some
proot/Termux setups). Claude Code then refuses its shared socket directory because it cannot
verify file ownership. This only disables cross-session messaging; Claude itself works.

The launcher passes an explicit `CLAUDE_CODE_MESSAGING_SOCKET` pointing at
`~/.cache/modelmesh/messaging/messaging.sock` (directory mode 0700), which fixes the socket
setup on affected devices. If the warning persists, the process really has no uid mapping and
no userspace workaround can enable the feature; it is safe to ignore. Running under a mapped
namespace (`unshare -Ur`, where supported) restores it.

## Logs

| File | Contents |
|---|---|
| `~/.cache/modelmesh/gateway.log` | gateway output: startup, requests, retries |
| `~/.cache/modelmesh/errors.log` | one JSON line per failure: `{ at, kind, provider, model, status, message }` |

```bash
modelmesh logs
modelmesh errors 50
```

## Still stuck?

Open an issue with the output of `modelmesh diagnose`, your platform and the last lines of
`modelmesh logs`. For quick help, join the [Discord server](https://discord.gg/AF8zvEDcSG).
