# Development fixtures

Mock upstreams used while working on the gateway. They are not part of the runtime
and are not invoked by the installer.

- `mock-openai.mjs` - OpenAI chat-completions upstream that exercises the tool loop
- `mock-anthropic.mjs` - Anthropic Messages upstream
- `mock-responses.mjs` - OpenAI Responses API upstream
- `mock-retry.mjs` - returns 503 twice, then 200, to test backoff
- `gwctl.mjs` - restart the local gateway against a chosen test config

Run them on the loopback interface and point `CC_TERMUX_CONFIG` at a throwaway config
with `apiKey` omitted; never point them at a paid provider.
