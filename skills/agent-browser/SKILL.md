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

## First: find the browser

Run this and read the answer before doing anything else.

```bash
command -v agent-browser && agent-browser --version
command -v chromium || command -v chromium-browser || command -v google-chrome || \
  command -v google-chrome-stable || command -v chrome || \
  ls ~/.cache/ms-playwright/*/chrome-linux*/chrome 2>/dev/null
```

Whichever path that prints is the browser. Keep it: every later command needs it.

### Where the browser comes from

| Platform | Browser | How it gets there |
|---|---|---|
| Termux / Android | `chromium-browser` | `pkg install x11-repo && pkg update && pkg install chromium` |
| Linux, macOS, Windows | Chrome or Chromium | the normal install for that OS |

**The Termux binary is `chromium-browser`, not `chromium`.** The package is `chromium`;
it installs a launcher at `$PREFIX/bin/chromium-browser`. Look for both names.

Termux's `x11-repo` is Termux's own official repository — the name only says the package
lives there, not that you need an X server. Chromium runs **headless with no display**:

```bash
chromium-browser --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --screenshot=/tmp/shot.png --window-size=1280,900 https://example.com
```

The DBus and inotify errors it prints are harmless on Android: there is no session bus and
`/proc/sys` is not fully readable. Ignore them and check for the output file instead.
Add `--virtual-time-budget=8000` when a page renders its content with JavaScript.

### Driving it from an agent

Chromium exposes the DevTools protocol, which is tool-agnostic — anything that speaks CDP
works, no browser-specific code needed:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=9222 --user-data-dir=/tmp/cdp about:blank
# then: http://127.0.0.1:9222/json/version  ->  webSocketDebuggerUrl
```

**Playwright and Puppeteer do not work on Termux** — both refuse to start on Android
(`Unsupported platform: android`) and publish no Android browser build. Use CDP directly,
or `agent-browser` if it is installed:

```bash
agent-browser --executable-path "$(command -v chromium-browser)" open https://example.com
# or for the whole session:
export AGENT_BROWSER_EXECUTABLE_PATH="$(command -v chromium-browser)"
```

**Never install a browser yourself.** Installing gives the user a 150 MB download, 480 MB
on disk and 129 packages; that is their decision, not yours. If none is present, show the
command for their platform and ask.

### If no browser is found

Say so in one line and use the fallback below. Do not install one on your own initiative,
and never build a browser from source: that is a multi-year project, not a task.

## Fallback without a browser

You can still do most of the job. Be explicit that rendering was not verified: never
pretend you opened a page you did not render.

- **Fetch the page**: `mcp__web__fetch`. It returns the served HTML as text. JavaScript
  that runs client-side is not executed, so a JS-rendered app will look empty.
- **Read the source**: if the project is local, read the components, styles and markup
  directly. For a layout bug that is usually faster and more reliable than a screenshot.
- **Check the built output**: run the dev or build script and read what it emits.
- **Blocked by a bot check**: cc-termux reports this instead of returning a challenge page.
  Try another source; do not attempt to defeat the challenge.
- **Say what you could not check.** "Verified in the markup, not in a browser" is honest
  and useful. "Looks fine" when you did not render it is not.

## While driving a browser

- One action per step, then check the result before the next. Do not chain clicks blindly.
- Find elements from a snapshot of the page rather than guessing selectors.
- Screenshot after a visual change, and actually look at the screenshot before saying it works.
- **Read the output file, do not trust the exit code.** Chromium prints DBus noise and
  still succeeds; a missing screenshot with exit 0 is a failure.
- Credentials: use the tool's own vault rather than putting secrets in a command line.
- Close what you opened. Headless sessions keep a profile directory: reuse one, not many.

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
