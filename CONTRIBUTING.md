# Contributing

1. Fork and create a topic branch.
2. Keep changes small and focused; run `npm run check` and `npm test` before opening a PR.
3. Do not commit `config.json`, `keys.json`, binaries, or tarballs.
4. New provider presets go in `presets.json` (id, base URL, protocol).
5. Protocol translation lives in `proxy/translate.mjs`, gateway plumbing and adapters in
   `proxy/server.mjs`, Antigravity in `proxy/antigravity.mjs`, UI patches in
   `bin/cc-patch.mjs`.
6. Add a test for behaviour you change. Pure translators get unit tests in
   `tests/translate.test.mjs`; anything that spawns a process or server belongs in an
   integration suite. Document a new suite in `tests/README.md`.
7. If you add a command or change behaviour, update `README.md` (the showcase) and the
   relevant page in `docs/` (the details).

## Style

- ES modules, two-space indent, double quotes.
- No runtime dependencies outside Node's standard library.
- Prefer small pure functions; keep side effects at the edges.
