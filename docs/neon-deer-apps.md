# Neon Deer apps: workflow blocks and portal prerequisites

Neon Deer's own Attio apps contribute workflow blocks that depend on setup in the Neon Deer portal (**app.neondeerdata.com**). This doc covers what the MCP knows about them and when it tells the human to go to the portal.

Schemas here are read from each app's **source**, not harvested, so they cover blocks nobody has configured yet. Sources are pinned in `app-blocks.json` (`apps.<slug>.source`). 30 of the 36 Advanced Workflow Automations blocks are also confirmed by configs Attio's UI wrote (`config-keys.json`). The 6 confirmed from source only: `a-note-content-updated`, `a-note-title-updated`, `b-task-deleted`, `f-call-recording-created`, `g-comment-created`, `h-fail-workflow`.

## Tools

| Tool | Use |
|---|---|
| `list_app_blocks` | Installed apps, their live `app_id`, a ready `provider`, and per-block `needs` (plan feature, portal steps) |
| `describe_app_block` | One block's config keys, allowed values, outcomes, prerequisites, failure text, gotchas |
| `app_workflow_target` | Builds the encoded `workflow_id` for Schedule a workflow run and Call a subflow |
| `add_block` / `set_block_config` | For mapped app blocks: refuse values the app's runtime rejects, and return `app_block_review` (prerequisites + warnings) to relay to the human |

**Provider shape** (verified on live blocks): `{"type":"app","app_id":"<live>","app_block_id":"<slug>","app_user_connection_membership_id":null}`. The production `app_id` matches across workspaces, but dev builds use a different one, so always take it from `list_app_blocks`.

## When to send the human to the portal

| Situation | Tell the human |
|---|---|
| Any Neon Deer app block, workspace not connected | Sign up free at app.neondeerdata.com, then Attio > Workspace settings > Apps > (app) > connect Neon Deer. Without it, steps fail and triggers refuse to turn on. |
| Find lookup table row (`c-lookup-row-find`) | Paid or trial plan (`automations.lookup`). Build the table at `/automations/tables`, turn on "Lookup key" for the search field and "Return to workflows" for each output field. Ask for the table URL (it carries `?table=<uuid>`). |
| Start a scheduled run, Schedule a workflow run, Start a subflow, Call a subflow | Paid or trial plan (`automations.schedule`). The target workflow must exist with its start trigger and be turned on in Attio. Org time zone (`/settings/general`) is the schedule default. |
| Task assignee, deadline, status changed / Task deleted triggers | Check the task baseline at `/automations` > Settings (admins can Re-run). |
| Send email notification | Both connections at `/email-notifications/setup`, and **Email alerts switched on** at `/email-notifications?view=settings` (off by default). |
| Anything about duplicates or merging | Duplicate Detection lives in the portal (`/duplicates/...`); there are no workflow blocks for it. |

Plan gates: the free plan withholds `automations.lookup` and `automations.schedule`; trial and paid include both.

## Advanced Workflow Automations (`workflow-utilities`)

`*` = required by the block schema. Full detail per key: `describe_app_block`.

| app_block_id | Type | Title | Config keys | Outcomes | Plan gate |
|---|---|---|---|---|---|
| `a-note-create` | step | Create note | `title`*, `format`*, `content_rich`, `content`, `parent_record`*, `meeting_id` | `created` |  |
| `a-note-find` | step | Find notes | `note_id`, `parent_object`, `parent_record`, `created_by`, `created_before`, `created_after`, `meeting_status` | `completed` |  |
| `a-note-move` | step | Move note | `source_note_id`*, `target_parent_object`*, `target_parent_record`* | `moved` |  |
| `b-task-find` | step | Find tasks | `task_id`, `completion_status`, `deadline_status`, `deadline_before`, `deadline_after`, `assignee`, `linked_object`, `linked_record` | `completed` |  |
| `c-lookup-row-find` | step | Find lookup table row | `table_id`*, `lookup_definition_id`*, `lookup_text`, `lookup_number`, `lookup_boolean`, `lookup_date`, `lookup_timestamp`, `lookup_email`, `lookup_domain`, `lookup_phone`, `lookup_url`, `lookup_member`, `lookup_member_id`, `lookup_record`, `record_object` | `completed` | `automations.lookup` |
| `c-member-find` | step | Find workspace member | `find_by`*, `workspace_member_id`, `email`, `case_sensitive`, `normalize_email` | `completed` |  |
| `d-compare-members` | step | Compare members | `previous_members`, `new_members` | `changed` |  |
| `d-compare-records` | step | Compare records | `record_object`*, `previous_records`, `new_records` | `changed` |  |
| `d-compare-values` | step | Compare values | `attribute_type`*, `previous_domain_values`, `new_domain_values`, `previous_email_values`, `new_email_values`, `previous_phone_values`, `new_phone_values` | `changed` |  |
| `e-value-get-primary` | step | Get primary value | `attribute_type`*, `domain_values`, `email_values`, `phone_values` | `completed` |  |
| `e-value-transform` | step | Convert value | `input`*, `target_type`* | `converted`, `invalid_input` |  |
| `e-value-transform-html-to-markdown` | step | Convert HTML to markdown | `html`* | `converted` |  |
| `f-call-recording-transcript-get` | step | Get call transcript | `meeting_id`*, `call_recording_id`* | `ready` |  |
| `f-meeting-get` | step | Get meeting | `meeting_id`* | `completed` |  |
| `g-comment-get` | step | Get comment | `comment_id`* | `completed` |  |
| `g-thread-get` | step | Get comment thread | `thread_id`* | `completed` |  |
| `h-fail-workflow` | step | Fail workflow | `message`* |  |  |
| `i-folder-create` | step | Create folder | `object`*, `name`*, `record`*, `storage_provider`* | `created` |  |
| `j-schedule-record` | step | Schedule a workflow run | `object`*, `workflow_id`*, `run_at`*, `record`* | `scheduled` | `automations.schedule` |
| `j-scheduled-runs-cancel` | step | Cancel scheduled runs | `mode`*, `scheduled_run_id`, `object`, `record` | `completed` |  |
| `j-scheduled-runs-find` | step | Find scheduled runs | `object`*, `record`*, `workflow_scope`*, `workflow_id`, `selection`* | `found` |  |
| `j-subflow-return` | step | Return from a subflow | `object`, `workflow_id`, `subflow_id`*, `status`, `outputs`, `named_outputs` | `returned` |  |
| `j-subflow-run` | step | Call a subflow | `object`*, `workflow_id`*, `record`*, `named_inputs`, `wait_for_result`, `dont_wait`, `timeout_minutes`* | `returned`, `started` | `automations.schedule` |
| `a-note-content-updated` | trigger | Note content updated | none | `updated` |  |
| `a-note-deleted` | trigger | Note deleted | none | `deleted` |  |
| `a-note-title-updated` | trigger | Note title updated | none | `updated` |  |
| `b-task-assignee-changed` | trigger | Task assignee changed | none | `assignee_changed` |  |
| `b-task-created` | trigger | Task created | none | `created` |  |
| `b-task-deadline-changed` | trigger | Task deadline changed | none | `deadline_changed` |  |
| `b-task-deleted` | trigger | Task deleted | none | `deleted` |  |
| `b-task-status-changed` | trigger | Task status changed | none | `completed`, `uncompleted` |  |
| `f-call-recording-created` | trigger | Call recording created | none | `created` |  |
| `g-comment-created` | trigger | Comment created | none | `created` |  |
| `j-scheduled-record` | trigger | Start a scheduled run | `object`* | `scheduled` | `automations.schedule` |
| `j-subflow-start` | trigger | Start a subflow | `object`*, `output_definitions`, `input_definitions` | `started` | `automations.schedule` |
| `k-record-deleted` | trigger | Record deleted | none | `deleted` |  |

### Gotchas when writing configs over the API

- **UI defaults are not applied.** The configurator fills defaults the API never sees, so the runtime fallback applies. Example: Find tasks with no `completion_status` returns **open tasks only**; the UI shows "any". `app_block_review.warnings` lists every such key.
- **Encoded `workflow_id`s.** Build them with `app_workflow_target`; anything malformed is refused before writing.
  - `j-schedule-record`: `'["<workflowId>","<entryPointId>"]'`
  - `j-subflow-run`: `'["<workflowId>","<entryPointId>","<signature>"]'`, where `entryPointId` is the target's Start a subflow block id and `signature` is the sha256 hex of the JSON array of its output keys (`fieldKey(name)`: trimmed, lowercased, non-alphanumerics to `_`). Verified against three live blocks. **The signature changes when the target's output names change**, and the step then errors until rebuilt.
  - `j-scheduled-runs-find`: a **bare** workflow uuid.
  - Some live `j-schedule-record` / `j-subflow-run` blocks hold a bare uuid (older app versions). The current runtime cannot parse those.
- **Subflow returns map by position.** The UI writes `j-subflow-return` `outputs` rows as `{value}` only, matched in order to the start trigger's `output_definitions`.
- **Only the active branch is read.** Compare values, Convert value and Find lookup table row read just the keys for the selected type.
- **Legacy keys** still read but no longer written: `j-subflow-run.dont_wait`; `j-subflow-return.named_outputs`, `.object`, `.workflow_id`. The review warns if you write them.
- `j-subflow-run` reports `status` as `Succeeded`/`Failed`; `j-subflow-return` config takes `succeeded`/`failed`.
- `lookup_definition_id` is not shown in the portal UI. Copy it from a Find lookup table row block configured in the Attio UI (`get_workflow`).

## Email Notifications (`email-notifications`)

| app_block_id | Type | Title | Config keys | Outcomes | Plan gate |
|---|---|---|---|---|---|
| `send-email-notification` | step | Send email notification | `recipient`*, `subject`*, `body`* | `queued` |  |

- `recipient` must be a workspace member actor; one recipient per step.
- `subject` is one line (multi-line is refused); the org's prefix is added automatically.
- `body` is rich text used only for line breaks, shortened at 2,000 characters.
- **`queued` is not "sent".** Plan-limit, inactive-recipient and bounce failures appear only in the portal Activity view (`/email-notifications?view=activity`), never in the Attio run. Free plan: 20 emails a month.
- No templates, sender choice or domain setup.

## Duplicate Detection & Merging (`check-for-duplicates`)

No workflow blocks. The MCP only needs to know what it does to records, and when to send the human there.

- Setup: `/duplicates/setup` ("Workspace access" + "Automatic detection"). Rules at `/duplicates/rules`, scans at `/duplicates/scans` and `/duplicates/schedules`, review and merge at `/duplicates/sets`.
- **The platform is the only merge authority.** Don't build auto-merge workflows; send the human to `/duplicates/sets`.
- **A merge mints a new record id.** Anything keyed to the old id (workflows, scheduled runs, lookup-table record cells) will point at a dead record.
- Merges run pair by pair, so record created/updated/deleted workflows on people and companies can fire in bursts.
- **Unverified:** whether a merge fires `record.deleted`, i.e. whether Record deleted (`k-record-deleted`) workflows run on merged-away records.
- **What the Attio app writes:**
  - Lists "Duplicate Companies" (`company_deduplication_history`) and "Duplicate People" (`person_deduplication_history`). Each flagged duplicate becomes an entry.
  - List attributes `duplicate_reason`, `duplicate_of` (record reference), `input_value`, `matched_value`, `details`, `merged` (checkbox, set true on `record.merged`).
  - Timestamp attribute `nddl_last_duplicate_check` on people and companies. Otherwise it writes nothing to records, and it never merges.
  - Slugs may carry a suffix. They don't exist until the app has run in a workspace, so check the workspace before referencing them.
- Workflows can trigger on entries added to those lists or filter on `merged`. Don't build workflows that edit the `duplicate_*` attributes.

## Updating

`app-blocks.json` is maintained by Neon Deer Data Labs and updated here when an app ships a new version. To check it against a live install, run `ATTIO_WORKSPACE_SLUG=<workspace with the app> node test-full.js`. Section 8b fails if the live install and the corpus disagree.
