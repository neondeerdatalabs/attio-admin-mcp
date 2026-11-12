# Workflow run history (modern engine), captured 2026-11-12

Source: Playwright capture of the Attio UI while a published workflow's run history was opened, then each call replayed read-only with the session cookie. Workspace neon-deer-data-labs.

Base: `https://app.attio.com/api/common/workspaces/{slug}`. Path ids: `{wf}` workflow, `{ver}` workflow_version_id, `{run}` workflow_version_run_id, `{frame}` workflow_version_run_frame_id, `{exec}` workflow_version_run_frame_block_execution_id.

## Verified (replayed, 200)

| Call | Returns |
|---|---|
| `GET /workflows/{wf}/runs/latest` | `{latest_run:{workflow_version_id, workflow_version_run_id, sort_key}}` |
| `POST /workflows/{wf}/runs/query` | `{value:[run...]}`, newest first. Body `{sort_key_cursor:{sort_key, inclusive}, limit, filter:{}}`. `sort_key_cursor` is required (400 without). Seed with `runs/latest` sort_key + `inclusive:true`; next page = last row's sort_key + `inclusive:false`. UI uses limit 500. No next cursor in response; stop when a page is short. Paged 10 + rest returned all 34 runs, no dupes. |
| `GET /workflows/{wf}/versions/{ver}/runs/{run}` | One run (same shape as a list row). |
| `GET .../runs/{run}/frames` | `{value:[frame]}`: `type` (`root`, plus child frames for loops/subflows), `parent_workflow_version_run_frame_id`, `status`, `interrupts`, timings. |
| `GET .../frames/{frame}/block-executions` | `{value:[exec]}`: `workflow_version_block_instance_id` (maps to the block), `parent` (previous exec), `status`, `outcome` (`done` etc.), `failure_reason`, `error_message`, `waiting_reason`, `did_continue_on_error`, `attempts`, `latest_attempt_id`, `has_evaluated_config`, `has_outcome_data`, `execution_cost {amount,is_final}`, timings. |
| `GET .../block-executions/{exec}/outcome-data` | `{runtime_value}`: the block's output as typed runtime values (`{__type:"object", entries:{...}}`, `string`, `number`, `attio-entity-reference {entity_definition_id, entity_instance_id}`). Contains real record data (PII). |
| `GET .../runs/{run}/retry-pointers` | `{retried_to:[]}` |
| `GET /workflows/{wf}/statistics` | `last_7_days_runs`, `_completed_runs`, `_failed_runs`, `_filtered_runs`, `_executing_runs`, `_credits_consumed` |
| `POST /workflows/batch-run-counts` | Body `{workflow_ids:[...]}` -> `{[wf]:{state, value:{value:<total runs>}}}` |

Run row: `workflow_version_id` (runs span versions; 5 seen on one workflow, so build detail paths from the row), `sequence_number`, `status` (`completed`, `failed` seen), `filterable_status`, `retried_from`, `created_at/completed_at/failed_at/paused_at/canceled_at` (+ `_by`), `sort_key` (`{ns timestamp}_{ver}_{run}`).

Failure example: block exec `status:"failed"`, `failure_reason:"block-execute-responded-with-error"`, `error_message:"Missing required key \"formKey\" at formKey"`.

## Legacy engine (already in the reference doc)

`GET /workflow-runs/{id}`, `/workflow-runs/{id}/node-executions`, `/subgraph-runs` were polled by the UI for an older workflow. They 404 for modern run ids. `GET /workflows/{wf}/runs` still 400s "legacy workflows only" on modern.

## Retry (captured from a UI click, second pass)

`POST .../runs/{run}/frames/{frame}/block-executions/{exec}/retry`, body `{retry_workflow_version_run_frame_id:<new uuid>, retry_workflow_version_run_frame_block_execution_id:<new uuid>}` (client-minted, like other creates). `{frame}`/`{exec}` = the failed execution. 200 returns `{workflow_version_run (status back to "executing"), retry_workflow_version_run_frame (type "retry", parent = original frame, created_by workspace member), workflow_version_run_frame_block_execution_mrl}`. The same run id is reused; the retry is a new frame on it. The test retry failed again with the same formKey error, as expected.

Also seen: `GET .../frames/{frame}` (one frame) and `GET .../frames/{frame}/block-executions/{exec}` (one execution), both polled after a retry.

## Not available in the UI

- Status filter: the UI's "Failed" status is a count only, not a list filter. `runs/query` is always sent with `filter:{}`; filter client-side on `status`.
- Evaluated block inputs: the run viewer shows only the error, not the inputs, and made no inputs call. `has_evaluated_config` exists but no endpoint was observed. The configured (not evaluated) inputs are available from the workflow version's block config.
