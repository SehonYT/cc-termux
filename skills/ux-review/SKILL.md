---
name: ux-review
description: >
  Audit an interface and fix the worst problems first. Use when the user says
  "this feels off", "the UI is bad", "clean up the design", "is this usable",
  "review the UX", or asks for a design pass on screens that already exist.
  Different from webapp-quality: that builds, this judges what is there.
---

# UX review

Judge the interface that exists, then fix in priority order. Never redesign what the user
did not ask you to redesign.

## Look at it first

Read the markup and styles, or render the page and screenshot it if a browser tool is
available. Do not review from memory of what the code is supposed to do.

## What to check, in this order

**Blocking** — cannot be used by someone.
- Unreachable or unlabelled controls, keyboard traps, no focus indicator.
- Contrast below 4.5:1 on body text.
- Content clipped or overflowing at common widths.
- An action with no feedback: the user cannot tell if it worked.

**Confusing** — usable but wrong.
- More than one primary action competing for the same glance.
- Labels that name the implementation ("Submit query") instead of the result ("Search").
- Errors that state the problem but not the fix.
- Destructive actions without a confirm, or with the dangerous one pre-selected.
- Empty and error states missing, so a failure looks like "nothing here".

**Cramped** — usable and correct but unpleasant.
- Inconsistent spacing; align to one scale (4/8/12/16/24/32).
- Weak hierarchy: everything the same size and weight, so nothing leads.
- Line length over ~80 characters, or centred paragraphs.
- Too many borders, too many accent colours, decorative shadows on flat content.
- Motion that decorates rather than explains.

## Output

Numbered findings, worst first. Each one: file:line, what is wrong, the smallest fix, and
who it hurts. Then fix them unless the user asked for a review only. Say what you did not
check.
