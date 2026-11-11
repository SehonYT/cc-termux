---
name: dep-audit
description: >
  Check dependencies and install scripts for risk before adding them. Use when
  adding any package, whenever the user says "add a dependency", "npm install",
  "install this", "pin the version", "audit deps", or asks whether a library is
  safe. Covers supply chain, lockfiles, install scripts and version ranges.
---

# Dependency and supply chain review

Adding a dependency is giving a stranger's code your permissions, your network and your
build. Weigh it before you do it.

## First: does it need to exist

- Is it already in the project or the standard library? Use that.
- Is it one function? Write the function. A dependency for ten lines is a permanent
  liability against a temporary convenience.
- Only then, add it.

## Before adding

1. **Check the package is the real one.** Name matches the repo, the repo has real history,
   the publisher is who you expect. Typosquats are the commonest supply-chain attack.
2. **Check it installs cleanly.** Prefer a package with no install scripts. In npm,
   `--ignore-scripts` and see what breaks; a postinstall that downloads a binary deserves
   an explanation.
3. **Check the version range.** Pin to a range you understand (`^1.2.3`). Never `*` or
   `latest` in a shipped dependency.
4. **Check the licence** is compatible with the project.
5. **Check size and freshness**: when was it last published, how many transitive deps does
   it pull in.

## Lockfiles

- Commit the lockfile. It is what makes a build reproducible.
- Do not hand-edit it. Regenerate.
- A lockfile change that pulls in packages nobody asked for is a finding, not noise.

## Reporting

For each dependency that looks risky: the name and version, what it can do at install and
at runtime, the evidence, and the smallest fix (pin, replace, drop, or vendor).

Never run an install script you have not looked at, and never add a dependency to make a
test pass.
