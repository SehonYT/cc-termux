---
name: agent-browser
description: >
  Drive a real browser to check, test or use a web page: open a site, click,
  fill a form, screenshot, read rendered content, debug why a page breaks, or
  verify a frontend change in an actual browser. Use for "open this page",
  "check the site", "test the form", "take a screenshot", "does the layout
  work", "why is this page broken".
---

# Browser automation

Two very different situations. Pick the right one before starting.

## First: check what is available on this device

```bash
command -v agent-browser && agent-browser --version
command -v chromium || command -v google-chrome || command -v chromium-browser
```

- **agent-browser installed** — use it. It drives Chrome over the DevTools protocol and is
  built for agents. Read its own docs for exact commands: `agent-browser skills get`.
- **A Chromium exists but agent-browser does not** — do not install a Rust toolchain on
  Termux to get it: that build is slow, large and fails on some devices. Use the fallback
  below instead.
- **Neither** — there is no browser on this device. Say so in one line and use the
  fallback; never pretend you opened a page.

## Fallback without a browser

You can still do most of the job. Be explicit that rendering was not verified.

- **Fetch the page**: `mcp__web__fetch`. It returns the served HTML as text. JavaScript
  that runs client-side is not executed, so a JS-rendered app will look empty.
- **Read the source**: if the project is local, read the components, styles and markup
  directly. For a layout bug that is usually faster and more reliable than a screenshot.
- **Check the built output**: run the dev or build script and read what it emits.
- **Blocked by a bot check**: cc-termux reports this instead of returning a challenge page.
  Try another source; do not attempt to defeat the challenge.
- **Say what you could not check.** "Verified in the markup, not in a browser" is honest
  and useful. "Looks fine" when you did not render it is not.

## If agent-browser is available

- One action per step, then check the result before the next. Do not chain clicks blindly.
- Snapshot the accessibility tree to find elements rather than guessing selectors.
- Screenshot after a visual change, and look at the screenshot before claiming it works.
- Credentials: use the tool's own vault rather than putting secrets in a command line.
- Close what you opened.

## Testing a local app

```bash
# start the app, note the port, then open it
npm run dev &
agent-browser open http://127.0.0.1:5173
```

`127.0.0.1` is reachable for the browser but refused by `mcp__web__fetch` by design
(SSRF protection), so a local page must be checked with a browser tool.

## Never

- Never claim a page was rendered, tested or screenshotted unless a browser actually did it.
- Never type real credentials into a page you were not asked to use.
- Never bypass a captcha or bot challenge.
