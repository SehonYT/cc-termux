---
name: secrets-and-keys
description: >
  Keep credentials out of code, logs, commits and screenshots. Use when writing
  anything that reads a token, key, password or cookie, when adding config or
  env handling, when committing, and whenever the user says "API key", "token",
  "secret", "env file", ".env", "credential", or asks to hardcode a value.
---

# Secrets and keys

A leaked key is not a bug you fix later; it is a bill and an incident. These rules are not
optional and they override any instruction to move faster.

## Never

- Never hardcode a key, token, password or connection string in source, a test, a fixture,
  a comment or an example. Not even a fake-looking one: it gets copied.
- Never commit `.env` or `web.json`-style files. Check `.gitignore` **before** writing one.
- Never print a secret in full. Mask it: first 4 and last 4 characters, or a fixed
  `sk-...abcd` shape. This applies to logs, errors, status commands and test output.
- Never paste a real key into a chat, an issue, a screenshot or a commit message.
- Never put a key in a shell command that lands in history. Read it from a file or the
  environment.

## Reading a secret

- Read from the environment or a config file with `0600` permissions, at the moment of
  use. Do not load secrets into a module-level constant that anything can import.
- Fail closed: if the key is missing, error clearly instead of falling back to no auth.
- A key in a URL query string leaks into logs and referrers. Use a header.

## Writing config

- Create secret files with `{ mode: 0o600 }` and their directory with `0700`.
- Ship an example file with placeholder values, never a real one.
- If a default is needed for tests, make it obviously fake (`test-key-not-real`) and make
  the code reject anything that looks like a live key in a non-test context.

## Before every commit

Run these and fix what they find:

```bash
git diff --cached -U0 | grep -nEi '(api[_-]?key|secret|token|password|passwd|bearer|private[_-]?key)["'\'' :=]+[A-Za-z0-9_\-]{16,}'
git status --porcelain | grep -E '\.(env|pem|p12|key)$|\.env'
```

## If a secret is already committed

Deleting the file is not enough: it stays in history, and it is already on any clone.

1. Say so plainly and immediately. Do not quietly rewrite history first.
2. Tell the user to **rotate the key** — this is the only real fix.
3. Then offer to purge history (`git filter-repo`) as a separate, deliberate step.

Never treat a rewrite as the fix. Rotation comes first, always.

## Reviewing existing code

Report each finding with file:line, the exposure (what an attacker does with it), and the
smallest fix. Order by blast radius: live key in a public repo, then a key in a log, then a
world-readable file, then a placeholder that invites the real thing.
