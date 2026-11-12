---
description: Choose the active LLM provider with an arrow-key selector
argument-hint: [provider-name | list | off]
allowed-tools: AskUserQuestion, Bash(modelmesh provider *)
---
!`modelmesh provider --json`

Using the JSON provider list above, call AskUserQuestion with one option per provider:
- label: "<name> (current)" for the active provider, otherwise "<name>"
- description: model, type and key mask

Then run `modelmesh provider <chosen name>` with the Bash tool and tell the user which provider is now active.