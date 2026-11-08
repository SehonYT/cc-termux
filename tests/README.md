# Tests

Run everything (sequential runner; gateway suites start local servers):

```bash
npm test
npm run check
```

Individual suite: `node --test tests/<name>.test.mjs`.

## Suites

| File | Covers |
|---|---|
| `antigravity.test.mjs` | Antigravity OAuth/code paste, request translation, SSE proxy, live model/quota parsing |
| `assets.test.mjs` | installer ships every runtime file and every relative import |
| `gateway.test.mjs` | empty-config error, auth, failure logging, image-aware count_tokens |
| `get-bootstrap.test.mjs` | no-TTY piped bootstrap runs the installer |
| `heal.test.mjs` | settings/env repair, foreign claude replacement, routing/picker rebuild, native layout, idempotency |
| `installer.test.mjs` | `install.mjs --check` plan output |
| `installer-codeonly.test.mjs` | `--code-only` keeps the binary and refreshes assets |
| `patch.test.mjs` | patch apply/idempotency/revert, stale backups, byte correctness |
| `perf.test.mjs` | opt-in performance mode, defaults, env flags |
| `platform.test.mjs` | CPU/OS target matrix and Node/glibc guards |
| `presets.test.mjs` | preset schema, endpoints, ordering, static model lists |
| `setup.test.mjs` | setup flag/help handling |
| `tar.test.mjs` | gzip+tar extractor, symlinks, traversal safety |
| `ui.test.mjs` | progress bars, spinner, banner, non-TTY fallback |
| `update.test.mjs` | provenance, self-update archive lookup, version stamps, cache/offline behavior |
| `version.test.mjs` | build version and tag formatting |

Tests must never write to `$PREFIX/bin` or the real `~/.local/share/cc-termux`; temp roots and
isolated prefixes are used on purpose.
