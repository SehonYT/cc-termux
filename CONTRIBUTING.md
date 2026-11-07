# Contributing

1. Fork and create a topic branch.
2. Keep changes small and focused; run `npm run check` before opening a PR.
3. Do not commit `config.json`, `keys.json`, binaries, or tarballs.
4. New provider presets go in `presets.json` (id, base URL, protocol).
5. Gateway adapters live in `proxy/server.mjs`; UI patches in `bin/cc-patch.mjs`.

## Style

- ES modules, two-space indent, double quotes.
- No runtime dependencies outside Node's standard library.
- Prefer small pure functions; keep side effects at the edges.
