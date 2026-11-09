# Workflow context

`workflow_guide` gives the model what it needs to build Attio workflows well, not just the API calls to do it. The data comes from Erik Wood's attio toolkit and is compiled into `workflow-context.json`.

## What is in it

| Part | Count | Source |
|---|---|---|
| System block references | 27 | `catalog/capabilities/workflow.block.*` |
| Neon Deer app overview + block references | 1 + 37 (36 matched to `app-blocks.json`) | `workflow.app.*` |
| Lifecycle, triggers, logs, builder, production review, variables, filters | 8 | other `workflow.*`, `variables.workflow`, `filters.*` |
| Recipes | 5 | `recipes/` plus `mcp_steps` written here |
| Guides | 5 | workflows, workflow-blocks, variables, filters, neon-deer-automations |

Each block reference carries inputs, outputs, claims, gaps, the matching section of `known-gaps.md`, and its example config inlined (the JSON pointer target only).

## Evidence levels

Strongest first: `effect-verified` (ran, and the change was read back), `runtime-verified` (ran, outputs observed), `config-verified` (saved and read back), `ui-observed`, `documented`, `unresolved`. A block's `evidence` is its strongest claim. Read the claim `scope` before generalizing.

## Calling it

- No arguments: build rules, evidence legend, and an index of recipes, guides and blocks.
- `block`: `"aggregate-values"`, `"step-find-records"`, `"j-subflow-run"` or a capability id.
- `recipe`: a pattern plus the attio-admin tools that build it, in order.
- `query`: keyword search; rare words weigh more.
- `guide`: a long-form guide in full.

The same references appear as `reference` on `describe_app_block`, a summary on `list_blocks`, and `reference_outputs` on `list_block_outputs`. The build rules are also sent as the server `instructions` on `initialize`.

## Rebuilding

```
node tools/build-workflow-context.js ~/dev/erik-attio-toolkit-2026-11-06/attio
node test-workflow-context.js
```

`mcp_steps` live in `tools/build-workflow-context.js`; update them when tools change.

## Public build

This copy was built with `--public`: client names, emails and the production-review index are removed, and workspace ids are replaced with placeholders.
