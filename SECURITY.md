# Security

## Reporting

Open a private security advisory on the repository instead of a public issue.

## Secrets

- API keys are stored in `~/.config/cc-termux/keys.json` with mode 0600.
- Keys are read by the local gateway only; they are not exported to Claude Code's
  environment and are never written to `config.json`, logs, or the model picker.
- The installer adds `permissions.deny` entries to `~/.claude/settings.json` so the
  agent's file tools cannot read the config directory.
- This is a single-user tool: the gateway and the agent run as the same OS user, so
  file permissions are the only boundary. Run it on a machine/account you trust.

## Network

The gateway listens on `127.0.0.1` only (port configurable in `config.json`).
All traffic to model providers uses the provider's public HTTPS endpoint.
