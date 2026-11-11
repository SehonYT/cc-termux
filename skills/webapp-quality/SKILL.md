---
name: webapp-quality
description: >
  Build or review a web app, page or feature that holds up in real use. Use for
  any UI, frontend, app or site work: "build a page", "make an app", "add a
  screen", "this looks broken", "review the frontend", "why is this slow".
  Covers the states people forget, responsive layout, accessibility and a
  performance budget.
---

# Web app quality

A feature is not done when the happy path renders. Work through these before saying done.

## Every screen has five states

1. **Loading** — a skeleton or spinner, never a blank page or a jump in layout.
2. **Empty** — no data yet: say why and what to do next, do not show an empty table.
3. **Error** — what failed, in plain words, with a way to retry.
4. **Partial** — some data missing or stale; show what you have and mark the rest.
5. **Full** — the real content, including the long case: very long text, 1000 rows, a
   one-character name.

If you did not build a state, say so in one line rather than leaving it silently missing.

## Layout

- Mobile first, then widen. Test at 320px, 768px and 1280px.
- Nothing overflows horizontally. Long words, URLs and code blocks wrap or scroll.
- Touch targets are at least 44x44 px. Never rely on hover alone for anything important.
- Reserve space for images and async content so the page does not shift.

## Accessibility

- Every control is reachable and operable by keyboard, in a sensible order.
- Visible focus. Never `outline: none` without a replacement.
- Text contrast at least 4.5:1; 3:1 for large text and UI borders.
- Every input has a label. Every image has alt text, or empty alt if decorative.
- Do not use colour alone to carry meaning.
- Respect `prefers-reduced-motion`.

## Performance

- Ship what the first screen needs. Lazy-load the rest.
- Images: correct dimensions, modern format, `loading="lazy"` below the fold.
- Do not add a dependency for something the platform or the codebase already does.
- A list of hundreds of items gets virtualised or paginated.

## Reviewing existing UI

Report findings with file:line, what is wrong, the smallest fix and the user impact. Order
them: broken (data loss, unusable, inaccessible) then degraded (slow, cramped, confusing)
then polish. Never restyle what the user did not ask you to restyle.
