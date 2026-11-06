# Attio Workflows API — External Reference

A complete, standalone reference for building Attio workflows programmatically, from any language, with no browser automation and no Attio-specific tooling. If you have access to an Attio account, you can use this.

Reverse-engineered from live traffic and verified against real workspaces across two Attio accounts, Aug 14–19 2026. Everything below was executed against the real API unless explicitly marked otherwise.

**Verification legend:**
- **[VERIFIED]** — executed against the live API and the result confirmed.
- **[OBSERVED]** — seen in captured browser traffic, not independently re-issued.
- **[INFERRED]** — reasoned from adjacent behaviour. Not proven. Treat as a hypothesis.

> **This is an unofficial, undocumented API.** Attio can change it without notice. It is not covered by their public API stability guarantees. Use accordingly.

---

## 1. Scope

Attio's **public** API (`api.attio.com/v2`) covers records, objects, lists, attributes and notes. It does **not** expose the Workflows builder.

This document covers the **internal** API behind `app.attio.com`, which is what the Workflows UI itself talks to. Use it to create, read, modify, publish and delete workflows.

Use the **public** API for the data those workflows operate on — object and attribute UUIDs in particular, which you will need constantly here.

**You will usually want both credentials.** The internal API takes a session cookie and nothing else; an API key returns `401`. **Workspace members** and **lists** are only on the public API, which takes an API key and not the cookie. See §5.5.

> **Corrected 2026-08-24:** select **option ids** were previously listed here as public-API-only. They are not — `GET /entity-definitions/{def}/attribute-definitions/{attr}/select-options` serves them on the cookie alone. The earlier probe missed it because that endpoint wraps its payload as `{accurate_at, values:[…]}` — `values`, plural — where the rest of this API uses `{value:[…]}`. See the internal-API reference §6.

**Two engine generations.** Older workspaces contain pre-modern workflows that store their definition in snapshots rather than versions. §2–§10 describe the modern engine; §11 covers the legacy one. Do not assume a workspace is all one or the other: in one client workspace, 8 of 11 workflows were legacy.

---

## 2. Authentication

### 2.1 API keys do not work

An Attio API key that returns `200` on `api.attio.com/v2/objects` returns this on the internal API: **[VERIFIED]**

```json
{"statusCode":401,"error":"Unauthorized",
 "message":"The requesting user presented an invalid authentication token"}
```

There is no token, OAuth client, or service-account path into this API. The only credential is a **user session cookie**.

### 2.2 What you need

**A session cookie.** Of a captured `Cookie` header, only three entries matter; the rest is analytics and can be discarded: **[VERIFIED]**

| Cookie | Role |
|---|---|
| `attio-session` | ES256 JWT. The actual credential. |
| `attio-app-session` | Same JWT value. |
| `attio-session-id` | Session UUID. |

**Plus an `Origin` header on every non-GET request.** This is mandatory and validated. Browsers set it automatically, which is why it is invisible when experimenting in a devtools console, and why it is the single most common reason an external client fails.

| Verb | Without `Origin` | With `Origin: https://app.attio.com` |
|---|---|---|
| `GET` | 200 | 200 |
| `PUT` | **403** | 200 |
| `POST` | **403** | 200 |
| `PATCH` | **403** | 200 |
| `DELETE` | **403** | 204 |

A wrong `Origin` value is rejected. A `Referer` header does **not** substitute. `POST` endpoints that are semantically reads (`batch-query-mrl`, `batch-get-config`) still require it. **[VERIFIED]**

No CSRF token and no other custom header is required.

### 2.3 Obtaining the cookie

In Chrome, logged into Attio:

1. DevTools → **Network**. Clear any text in the filter box.
2. Click **Fetch/XHR**.
3. Click into any workflow so requests fire.
4. Click any request to `app.attio.com/api/common/...`.
5. **Headers → Request Headers → `Cookie:`** → copy the whole value.

Store it outside source control, e.g. `~/.attio-session` with mode `600`.

### 2.4 Session lifetime

`attio-session` is a JWT, so expiry is readable rather than a guess:

```bash
echo "$ATTIO_COOKIE" | grep -o 'attio-session=[^;]*' | cut -d= -f2 \
  | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool
```

```json
{"iat":1786739862,"iss":"https://app.attio.com","exp":1789331862,
 "aud":"https://app.attio.com","sub":"<user_id>","sid":"<session_id>"}
```

`exp - iat` = 2,592,000 s = **exactly 30 days**. **[VERIFIED]**

Consequences:
- Plan on re-capturing monthly. There is no refresh endpoint identified. **[INFERRED]**
- The credential is per-user and cannot be scoped. Everything you do carries that user's permissions and appears as them in `created_by`.
- Logging out of the browser session invalidates it.

### 2.4b A cookie is scoped to an account, not a workspace

**A session cookie reaches exactly the workspaces its user belongs to.** This is the most common source of confusion when a client "works for one workspace but not another".

- Several workspaces under the **same** Attio login → one cookie covers all of them; just change the slug in the URL.
- A workspace under a **different** Attio login → that cookie will never work, whatever slug you use. You need a separate cookie captured from a session logged into that account.

`GET /api/common/workspaces` (note: **not** workspace-scoped) returns the definitive list for a given cookie: **[VERIFIED]**

```bash
curl -s https://app.attio.com/api/common/workspaces -H "Cookie: $ATTIO_COOKIE" \
  | python3 -c 'import sys,json;[print(w["workspace"]["slug"], "|", w["workspace"]["name"]) for w in json.load(sys.stdin)]'
```

Targeting an unreachable slug returns `403`/`404`, which reads like a permissions or path bug. Check this endpoint first.

### 2.5 Minimal working requests

```bash
SLUG="your-workspace-slug"
BASE="https://app.attio.com/api/common/workspaces/$SLUG"

# Read — no Origin needed
curl -s "$BASE/workflows/$WF_ID" -H "Cookie: $ATTIO_COOKIE"

# Write — Origin required
curl -s -X PUT "$BASE/workflows/$(uuidgen | tr 'A-Z' 'a-z')" \
  -H "Cookie: $ATTIO_COOKIE" \
  -H "Origin: https://app.attio.com" \
  -H "Content-Type: application/json" \
  -d '{"title":"My workflow","is_modern":true}'
```

---

## 3. Conventions

**Base URL.** `https://app.attio.com/api/common/workspaces/{workspace-slug}`. The workspace is addressed by **slug** (the one in your Attio URL), not by UUID.

**REST, not GraphQL.** No GraphQL endpoint is involved. **[VERIFIED]**

**The client generates UUIDs.** Workflows, block instances and paths are all created by `PUT`ting to a URL containing a UUID you generate. There is no `POST` collection endpoint; `POST /workflows` returns a real `404`. **[VERIFIED]**

**Response envelopes are inconsistent.** Collection endpoints wrap results as `{accurate_at, value}`; single-object endpoints usually return the object bare. `batch-get-config` nests deeper still. Check per endpoint.

**A `200` is not proof the endpoint exists.** Unknown paths under `/api/` fall through to the single-page app and return `200` with an HTML body. **Always check `Content-Type` contains `json` before trusting a response.** A genuinely missing API route returns `404` with body `Not found`. **[VERIFIED]**

**Status codes you will meet:**

| Code | Meaning here |
|---|---|
| `400` | Malformed body. Usually returned with an **empty body `{}`** and no detail. See §9. |
| `401` | Session cookie missing, wrong or expired. |
| `403` | Missing or wrong `Origin` header. |
| `404` | Route or resource does not exist. |
| `409` | Resource already exists (e.g. `PUT` on an existing block instance). |

---

## 4. Object model

Four resources, not one document:

```
workflow                          metadata + pointers to versions
 └─ version                       an immutable-ish snapshot of the graph
     ├─ block-instances[]         the nodes
     │    └─ /config              each node's typed config tree
     └─ paths[]                   the edges
```

### 4.1 Workflow

```json
{
  "workflow_id": "...", "title": "...", "description": "...",
  "status": "draft",
  "draft_workflow_version_id": "...",
  "active_workflow_version_id": null,
  "is_modern": true, "is_transient": true, "is_archived": false,
  "max_credits_per_run": 50, "timezone": null,
  "first_set_live_at": null, "last_status_change": null, "last_run_failed_at": null,
  "created_by": {"type": "workspace-member", "id": "..."}, "created_at": "..."
}
```

**A workflow holds a draft version and an active version simultaneously.** Editing mutates the draft. Publishing promotes it. This is what makes it safe to build through the API: nothing runs until you explicitly activate. **[VERIFIED]**

`status` values seen: `draft`, `live`, `paused`, `archived`. **[VERIFIED except `archived`, which appears only in list filters]**

### 4.2 Version

```json
{"workflow_version_id":"...","base_workflow_version_id":"...","type":"...",
 "initialization_status":"...","latest_activation":null,"created_at":"..."}
```

Metadata only, **not** the graph. Versions cannot be created directly (`PUT` on a version path returns `404`); the server provisions them. **[VERIFIED]**

### 4.3 Block instance (node)

```json
{
  "workflow_version_block_instance_id": "...",
  "block_type": "trigger",
  "provider": {"type":"system","system_block_slug":"on-record-created","system_block_version":"v1"},
  "description": "When a company is created",
  "position": {"x": 100, "y": 200}
}
```

- `block_type` — `"trigger"` or `"step"`.
- `position` — canvas coordinates, **cosmetic only**. Execution order comes entirely from paths.

**System provider:**
```json
{"type":"system","system_block_slug":"update-record","system_block_version":"v2"}
```
`system_block_version` **differs per block** (`find-records` is `v1`, `update-record` is `v2`). Getting the pair wrong is a `400`.

**App provider** (blocks supplied by an installed integration): **[VERIFIED]**
```json
{"type":"app","app_id":"af419e46-512a-4de3-9489-b655bf35768f",
 "app_block_id":"send-message","app_user_connection_membership_id":null}
```
`app_user_connection_membership_id` was `null` on a working live Slack block, so the connection appears to resolve at run time. **[INFERRED]**

### 4.4 Path (edge)

```json
{"workflow_version_path_id":"...",
 "source":{"workflow_version_block_instance_id":"...","outcome":"done"},
 "target":{"workflow_version_block_instance_id":"..."}}
```

**Outcome vocabulary:**

| Outcome | Used by | Status |
|---|---|---|
| `done` | normal system triggers and steps | **[VERIFIED]** |
| `true` / `false` | `branch` (UI label "If") | **[VERIFIED]** |
| `case_<caseId>` | `switch`, one per case | **[VERIFIED]** |
| `triggered` | **app-provided triggers** (e.g. `app:lemlist-activity`) | **[VERIFIED]** |
| `error` | error handling leg | **[INFERRED]**, not observed |

Note that app triggers do **not** use `done`. Read the existing path off a real workflow rather than assuming.

**Switch outcomes are dynamic.** A `switch` config contains `entries.cases`, an array whose items each carry an `id`:
```json
{"id":{"type":"string","value":"b281c5bf"}, "predicate":{...}}
```
The matching path outcome is that id prefixed with `case_`, e.g. `case_b281c5bf`. The two live in different resources with no referential integrity, so if you change one without the other the leg silently disconnects. The unmatched fall-through renders as **Default** in the UI and simply has no path. **[VERIFIED]**

---

## 5. Endpoint reference

All paths relative to `https://app.attio.com/api/common/workspaces/{slug}`.
All non-GET requests require `Origin: https://app.attio.com`.

### 5.1 Workflows

| Operation | Call | Notes |
|---|---|---|
| Create | `PUT /workflows/{client-uuid}` | Body `{"title":"...","is_modern":true}`. **[VERIFIED]** |
| Read | `GET /workflows/{id}` | Metadata only. **[VERIFIED]** |
| Update | `PUT /workflows/{id}` | Same verb on an existing id. **[VERIFIED]** |
| Delete | `DELETE /workflows/{id}` | `204`. Cascades to versions, blocks, paths. **[VERIFIED]** |
| List | `POST /workflows/batch-query-mrl` | See below. **[VERIFIED]** |
| Run counts | `POST /workflows/batch-run-counts` | Body `{"workflow_ids":[...]}`. **[OBSERVED]** |
| Latest run | `GET /workflows/{id}/runs/latest` | **[OBSERVED]** |
| List versions | `GET /workflows/{id}/versions` | **[OBSERVED]** |

> **`is_modern: true` is load-bearing on create.** Without it the workflow is created with `draft_workflow_version_id: null` and no draft version is provisioned, leaving you unable to add anything. With it, the server auto-creates the draft and returns its id. **[VERIFIED, both branches tested]**

**Listing:**
```bash
curl -s -X POST "$BASE/workflows/batch-query-mrl" \
  -H "Cookie: $ATTIO_COOKIE" -H "Origin: https://app.attio.com" \
  -H "Content-Type: application/json" \
  -d '[{"id":"q",
       "filters":[{"field":"status","operator":"eq","mode":"must-not","value":"archived"}],
       "sort":{"field":"last_published_at","direction":"desc","isDefault":true}}]'
```

Three requirements, each giving `400 {}` if broken: **[VERIFIED]**
1. Body must be a **top-level array**. It batches multiple named queries in one call.
2. **`sort` is mandatory**, even with valid filters. Easiest one to miss.
3. `Origin` is required, as for any POST.

`id` may be any string. Operators seen: `eq`, `lte`, `gte`. Modes: `must`, `must-not`.

**The response returns bare ids, triple-nested:**
```
response[yourQueryId].value.value  →  ["b5cafe5d-...", "3e6ef8fe-...", ...]
```
Listing with titles is therefore two-step: query for ids, then `GET` each. There is no bulk metadata endpoint. **[VERIFIED]**

### 5.2 Block instances

| Operation | Call | Notes |
|---|---|---|
| List | `GET /workflows/{wf}/versions/{ver}/block-instances` | Returns `{accurate_at, value:[...]}`. Not in execution order. **[VERIFIED]** |
| Read one | `GET .../block-instances/{id}` | Metadata only, **no config**. **[VERIFIED]** |
| **Create** | `PUT .../block-instances/{client-uuid}` | **`409` if the id already exists — create-only.** **[VERIFIED]** |
| **Update metadata** | `PATCH .../block-instances/{id}` | Send the full block fields. Config-only body returns `400 "No change provided"`. **[VERIFIED]** |
| **Update config** | `PUT .../block-instances/{id}/config` | Body `{"config": <bare node>}`. **[VERIFIED]** |
| Delete | `DELETE .../block-instances/{id}` | `204`. **[VERIFIED]** |
| Batch read configs | `POST .../block-instances/batch-get-config` | Body `{"workflow_version_block_instance_ids":[...]}`. **[VERIFIED]** |

**Create body:**
```json
{
  "block_type": "step",
  "provider": {"type":"system","system_block_slug":"create-record","system_block_version":"v2"},
  "description": null,
  "position": {"x": 810, "y": 90},
  "config": {"type":"object","entries":{}}
}
```

Three rules, each of which produces an opaque `400 {}`: **[VERIFIED]**
1. **`config` is required**, even if empty (`{"type":"object","entries":{}}`).
2. **Do not send id fields in the body.** No `workspace_id`, `workflow_id`, `workflow_version_id`, `workflow_version_block_instance_id`. They come from the URL. Echoing a read response back verbatim fails for this reason.
3. **Send the bare config node**, not the `{state, value}` wrapper that reads return.

> **The PUT is create-only.** To change an existing block you must use `PATCH` (metadata) or `PUT .../config` (config). This is the least obvious part of the API.

**Config nesting differs between the two read endpoints:**
```
single: GET  .../block-instances/{id}/config   →  response.config.value
batch:  POST .../block-instances/batch-get-config →  response[blockId].value.config.value
```
Both wrap the node as `{state, value}`. Mixing them up yields `undefined`, and writing that back gives a `400`.

### 5.3 Paths

| Operation | Call | Notes |
|---|---|---|
| List | `GET /workflows/{wf}/versions/{ver}/paths` | **[VERIFIED]** |
| Create | `PUT .../paths/{client-uuid}` | **[VERIFIED]** |
| Delete | `DELETE .../paths/{id}` | **[INFERRED]** by symmetry, not tested |

```json
{"source":{"workflow_version_block_instance_id":"...","outcome":"false"},
 "target":{"workflow_version_block_instance_id":"..."}}
```

### 5.4 Publish lifecycle

Publishing is **two calls**, and the version you activate is **not** the draft id: **[OBSERVED in UI traffic]**

```
POST /workflows/{wf}/versions/{draft_ver}/commit     → produces a NEW immutable version
POST /workflows/{wf}/versions/{new_ver}/activate     → makes it live
```

**The full shape is now known.** **[VERIFIED via HAR capture, Erik Ash, 2026-08-20]**

```
POST /workflows/{wf}/versions/{draft_ver}/commit
     {"immutable_workflow_version_id": "<NEW uuid you mint yourself>"}     → 200
POST /workflows/{wf}/versions/{that same immutable id}/activate
     {}                                                                    → 200, status=live
```

The missing piece was that **the client mints the new immutable version id and hands it to `commit`** — consistent with the rest of this API, where the client generates every uuid. `commit` returns a fresh draft alongside the immutable version; you then activate the immutable one, never the draft.

> **Scope note — deliberately not implemented.** `attio-admin-mcp` exposes no publish tool, and this is a standing decision, not an unmapped gap. Building, reading, modifying and cloning drafts are fully covered; activation stays a human action in the Attio UI until the tooling has proven itself over more client builds. The shape is documented here so the decision is reversible in minutes, not so it can be quietly worked around. `deactivate_workflow` **is** implemented, because turning a live workflow off is a safety valve rather than a risk.

For the record, the earlier probe of `commit` failed only because it never tried that key name. Every one of these returns `400` with an empty body: no body, `{}`, `{"workflow_version_id":…}`, `{"new_workflow_version_id":…}`, `{"target_workflow_version_id":…}`, `{"base_workflow_version_id":…}`. The empty `400` carries no hint, which is why capture beat guessing here. **[VERIFIED as failing]**

Two constraints that still hold, and explain why `commit` is mandatory:
- `activate` on a draft version fails with `"The provided Workflow Version is not an immutable..."`. An immutable version is genuinely required. **[VERIFIED]**
- There is no version-creation endpoint. `PUT /versions/{uuid}` and `POST /versions` both return `404`. `GET /versions` works (list only). **[VERIFIED]**

**Deactivation is fully mapped and works**, which matters more than publishing for safety: you can always turn a live workflow off from the API even though you cannot turn one on.

After activation: `status` → `live`, `active_workflow_version_id` → the new version.

**To take it back off:**
```bash
curl -s -X POST "$BASE/workflows/$WF/versions/$ACTIVE_VER/deactivate" \
  -H "Cookie: $ATTIO_COOKIE" -H "Origin: https://app.attio.com" \
  -H "Content-Type: application/json" -d '{}'
```
Result: `status` → **`paused`**, `active_workflow_version_id` → `null`. **[VERIFIED]**

> **Publishing makes the workflow fire on real data immediately.** A workflow must also pass UI-level validation to publish; an incompletely configured block blocks it. Note that `config_state: "complete"` from the API is **not** the same as passing that validation — the API reports whether the config expression resolves, not whether required inputs are filled.

### 5.5 Supporting endpoints

| Call | Purpose |
|---|---|
| `GET /api/common/workspaces` | **Not workspace-scoped.** Every workspace the session cookie can reach, with `slug`, `name`, `id`. The definitive answer to "why can't I see workspace X". **[VERIFIED]** |
| `GET /entity-definitions` | Workspace objects with `entity_definition_id`, `api_slug`, `singular_noun`, `entity_type`. This is where config object UUIDs come from. **[VERIFIED]** |
| `GET /apps` | Installed/available apps. Source of `provider.app_id`. Each entry carries `has_workflow_blocks`. **[VERIFIED]** |
| `POST /entity-definition-permissions/batch-get` | Body `{"entity_definition_ids":[...]}`. **[OBSERVED]** |
| `POST /workflows/batch-get-resolved-action-policies` | **[OBSERVED]** |
| `GET /usage-metrics/automation-credits-used` | **[OBSERVED]** |

**Discovered later, and more useful than most of the above:**

| Call | Purpose |
|---|---|
| `GET /workflow-blocks` | **The workspace's live catalog of SYSTEM blocks.** Every built-in trigger and step, with `system_block_type`, `title`, `workflow_block_id` and `execution_cost`. Served per workspace, so it is correct on a brand-new account with no workflows in it. Prefer this over any hardcoded list. **App blocks are NOT included** (corrected 2026-10-20; see `GET /apps` `.surfaces`). **[VERIFIED]** |
| `GET /apps/{app}` | One app. Its `surfaces[]` lists every block it contributes: `type` `workflow-block-step` / `workflow-block-trigger`, `slug` (= `app_block_id`), `title`, `description`. Also returned for every app by `GET /apps`. **[VERIFIED]** |
| `GET /app-installations` | Installed apps with `app_installation_id`, installed `major`/`minor`, `installation_kind` and `connection_definitions`. Envelope `{app_installations:[...]}`. **[VERIFIED]** |
| `GET /apps/{app}/installations/{inst}` | One installation (same shape). `/bundle` under it serves the app's client JavaScript, useful to confirm which source version is deployed. **[VERIFIED]** |
| `GET /entity-definitions/{eid}/attribute-definitions` | An object's attributes with `attribute_definition_id`, `api_slug`, `title`, `type`. Response wrapped in `{"value":[...]}`. Required for any variable path that reads a field off a record. **[VERIFIED]** |
| `GET /apps/{app}/installations/{inst}/bundle/{bundle}/workflow-blocks/{slug}/schema` | An **app** block's INPUT schema, i.e. its exact config keys and their types. The only place config keys are served rather than guessed. **[VERIFIED]** |
| `GET /workflows/{id}/runs` | Run ids for a workflow. Returns `400 "This endpoint is for legacy workflows only"` on modern workflows. **[VERIFIED]** |
| `GET /workflow-runs/{run_id}` | One run: `status`, timings, `failure_reason`, and the `workflow_snapshot_id` it executed. **[VERIFIED]** |

**Workspace members** live only on the public v2 API and need an API key, not the cookie. (Select **option ids** do NOT — see the correction in §2.2 and the internal-API reference §6.)

```
GET https://api.attio.com/v2/objects/{slug}/attributes/{attr}/options    # select, multiselect
GET https://api.attio.com/v2/objects/{slug}/attributes/{attr}/statuses   # status, pipeline
GET https://api.attio.com/v2/workspace_members
GET https://api.attio.com/v2/lists
```

**The two APIs share one id space.** Verified against `deals/stage`: the public API's `object_id` and `attribute_id` are byte-identical to the internal API's `entity_definition_id` and `attribute_definition_id`. So an option id fetched from the public API drops straight into a workflow config as `pipeline_stage_id`. **[VERIFIED]**

---

## 6. Block catalog

Complete as of Aug 15 2026, harvested from the live editor. **[VERIFIED]**

**Labels and slugs diverge, often badly.** "If" is `branch`, "Filter" is `guard`, "Create or update record" is `assert-record`, "Attribute value changed" is `on-attribute-invalidated`. Never infer a slug from a label.

### 6.1 Triggers (`block_type: "trigger"`)

| UI label | `system_block_slug` |
|---|---|
| Record command | `on-record-action` |
| Record created | `on-record-created` |
| Record updated | `on-record-updated` |
| List entry command | `on-list-entry-action` |
| Record added to list | `on-list-entry-created` |
| List entry updated | `on-list-entry-updated` |
| Attribute value changed | `on-attribute-invalidated` |
| Task created | `on-task-created` |
| Note created | `on-note-created` |
| Webhook received | `on-inbound-webhook` |
| Manual run | `on-manual-run` |
| Recurring schedule | `on-recurring-schedule` |

### 6.2 Steps (`block_type: "step"`, `provider.type: "system"`)

**Records**

| UI label | slug |
|---|---|
| Create record | `create-record` |
| Create or update record | `assert-record` |
| Update record | `update-record` |
| Find records | `find-records` |

**Lists**

| UI label | slug |
|---|---|
| Add record to list | `create-list-entry` |
| Update list entry | `update-list-entry` |
| Delete list entry | `delete-list-entry` |
| Find list entries | `find-list-entries` |

**Tasks & notes**

| UI label | slug |
|---|---|
| Create task | `create-task` |
| Update task | `update-task` |
| Complete task | `complete-task` |
| Find tasks | `find-tasks` |
| Create note | `create-note` |

**AI & agents**

| UI label | slug |
|---|---|
| Custom agent | `run-custom-ai-agent` |
| Web agent | `research-entity` |
| Classify record | `classify-entity` |
| Classify text | `classify-text` |
| Summarize record | `summarize-entity` |

**Control flow**

| UI label | slug |
|---|---|
| If | `branch` |
| Switch | `switch` |
| Filter | `guard` |
| Loop | `for-each` |
| Delay | `delay` |
| Delay until | `delay-until` |
| Round robin | `round-robin` |

**Data & compute**

| UI label | slug |
|---|---|
| Formula | `formula` |
| Aggregate values | `aggregate-values` |
| Adjust time | `adjust-timestamp` |
| Random number | `generate-random-number` |
| Parse JSON | `parse-json` |
| Execute code | `execute-code` |
| SQL query (Enterprise) | `query-particle-sql` |

**Sequences & messaging**

| UI label | slug |
|---|---|
| Enroll in sequence | `enroll-in-sequence` |
| Exit from sequence | `exit-from-sequence` |
| Send HTTP request | `send-http-request` |
| Broadcast message | `send-workspace-toast` |
| Celebration | `send-workspace-celebration` |

### 6.3 App steps (`provider.type: "app"`)

| UI label | `app_block_id` | App |
|---|---|---|
| Post message to channel | `send-message` | Slack (`af419e46-512a-4de3-9489-b655bf35768f`) |
| Post actions to channel | `send-actions` | Slack |
| Add to Mixmax sequence | `add-email-to-sequence` | Mixmax |
| Add member to audience | `add-member-to-audience` | (audience tool) |

App availability is workspace-specific. Get `app_id` values from `GET /apps`, and an app's `app_block_id` values from the same response: each app's `surfaces[]` entries of type `workflow-block-step` / `workflow-block-trigger` carry the slug. (Corrected 2026-10-20: an earlier note said no endpoint lists them.) `list_app_blocks` does this for you. **[VERIFIED]**

**`app_id` is per build, not per app.** The production Advanced Workflow Automations app has the same `app_id` in every workspace it is installed in, but a dev build of the same app runs under a different id. Always resolve `app_id` live; never copy it between workspaces. **[VERIFIED]**

**Neon Deer's own apps** (Advanced Workflow Automations, Email Notifications, Duplicate Detection) have source-derived schemas and portal prerequisites in `app-blocks.json`. See [neon-deer-apps.md](neon-deer-apps.md).

### 6.4 Three slug namespaces — the single most confusing thing here

The same block is called three different things depending on where you look, and using the wrong one produces **no error at all**: the write returns 200 and the editor renders "Unsupported block".

| Where | Field | Example |
|---|---|---|
| Block catalog (`GET /workflow-blocks`) | `system_block_type` | `step-outbound-webhook` |
| Catalog, prefix stripped | — | `outbound-webhook` |
| **What configs actually use** | `provider.system_block_slug` | **`send-http-request`** |

**Only the third one works in `add_block`.** The list in §6.2 is the provider-slug list; use it.

Known divergences, all verified:

| Catalog slug | Provider slug (use this) |
|---|---|
| `outbound-webhook` | `send-http-request` |
| `foreach` | `for-each` |
| `create-entry` | `create-list-entry` |
| `update-entry` | `update-list-entry` |
| `delete-entry` | `delete-list-entry` |
| `find-entries` | `find-list-entries` |
| `random` | `generate-random-number` |
| `shift-timestamp` | `adjust-timestamp` |
| `user-round-robin` | `round-robin` |
| `on-attribute-updated` | `on-attribute-invalidated` |
| `on-entry-created` / `on-entry-updated` | `on-list-entry-created` / `on-list-entry-updated` |
| `on-webhook` | `on-inbound-webhook` |
| `on-interval-activated` | `on-recurring-schedule` |

Blocks whose names match in both (`find-records`, `create-record`, `assert-record`, `create-task`, `formula`, `guard`, `switch`, `branch`, `classify-text`, `classify-entity`, `summarize-entity`, `create-note`, `parse-json`, `execute-code`, `aggregate-values`, `research-entity`) are the majority; the table above is the exception list.

### 6.5 Harvesting slugs yourself

The catalog is client-side; no API serves it. To re-harvest after an Attio update, open a draft workflow's editor, open the block picker, and read the React fibre props:

```js
[...document.querySelectorAll('[role="option"]')].map(el => {
  const fk = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
  let node = el[fk], slug = null;
  for (let i = 0; node && i < 12 && !slug; i++) {
    const p = node.memoizedProps;
    if (p) {
      const s = JSON.stringify(p, (k, v) => typeof v === 'function' ? undefined : v);
      const m = s && s.match(/"(system_block_slug|app_block_id)":"([^"]+)"/);
      if (m) slug = m[2];
    }
    node = node.return;
  }
  return `${slug} | ${el.textContent.trim()}`;
}).join('\n');
```

---

## 7. Writing configs

A block's config is a **typed expression tree**, not a flat key/value map.

### 7.1 Node types

| `type` | Shape |
|---|---|
| `object` | `{"type":"object","entries":{...}}` |
| `array` | `{"type":"array","items":[...]}` |
| `string` / `number` | `{"type":"number","value":5}` |
| `attio-object` | `{"type":"attio-object","entity_definition_id":"..."}` |
| `attio-attribute` | adds `attribute_definition_id` |
| `attio-select` | a specific select-option value |
| `variable` | reference to another block's output (§7.3) |
| `union` | `{"type":"union","nodes":[...]}` |
| `composite-predicate` | `{"operator":"and","operands":[...]}` |
| `binary-predicate` | `{"left":...,"operator":"equals","right":...}` |
| `rich-text` | `{"blocks":[...]}` with inline `variables[]` |

All **[VERIFIED]**.

### 7.2 Config keys are per-block and not guessable

This is the biggest practical trap. Different blocks name the same concept differently:

| Block | Key for the target object |
|---|---|
| `on-record-created` | `object` |
| `find-records` | **`entity`** (plus a required `limit`) |

Setting `object` on `find-records` is silently ignored and the UI reports the input as missing. **[VERIFIED]**

**There is no schema endpoint.** To learn a block's config keys: add it once in the UI, configure it, then `GET .../block-instances/{id}/config` and copy the shape. Do this once per block type and keep your own table.

#### 7.2a The harvested corpus — top-level config keys

`harvest-config-keys.js` automates exactly that read, across every workflow in every workspace the cookie can reach, and indexes the result by `engine:block_type:slug@version`. First run: **35 workflows, 182 blocks, 33 distinct signatures** (29 system, 4 app-provided). Every key below came out of a config **Attio's own UI wrote**, which makes this the strongest evidence class available — stronger than a successful write of your own (see §7.2b). `n` is how many instances were observed.

| Block | Config keys | n |
|---|---|---|
| `on-record-created@v1` | `object` | 3 |
| `on-record-action@v1` | `object` | 4 |
| `on-record-updated@v1` | `object`, `attribute` | 4 |
| `on-attribute-invalidated@v1` | `object`, `attribute` | 19 |
| `on-inbound-webhook@v1`, `on-manual-run@v1`, `on-task-created@v1` | *(no config)* | 5 |
| `guard@v1` | `predicate` | 13 |
| `branch@v1` | `predicate` | 8 |
| `switch@v1` | `cases` | 6 |
| `for-each@v1` | `iterable` | 3 |
| `find-records@v1` | `limit`, `entity`, `filter` | 4 |
| `find-list-entries@v1` | `list`, `limit` | 1 |
| `update-record@v2` | `object`, `configured_attributes`, `record` | 26 |
| `create-record@v2` | `object`, `configured_attributes` | 1 |
| `assert-record@v2` | `object`, `configured_attributes`, `matching_attribute` | 3 |
| `create-list-entry@v2` | `list`, `configured_attributes`, `record` | 5 |
| `update-list-entry@v2` | `list`, `entry`, `configured_attributes` | 1 |
| `create-task@v2` | `assignees`, `content`, `references`, `due_at` | 10 |
| `send-http-request@v1` | `method`, `url`, `headers`, `body`, `content_type` | 5 |
| `parse-json@v1` | `input`, `schema` | 2 |
| `aggregate-values@v2` | `aggregation_type`, `values` | 1 |
| `adjust-timestamp@v2` | `offset` | 1 |
| `round-robin@v2` | `users` | 1 |
| `run-custom-ai-agent@v2` | `instructions`, `model` | 3 |
| `research-entity@v1` | `input`, `questions` | 1 |
| `send-workspace-toast@v1` | `variant`, `target_type`, `duration_seconds`, `targeted_users`, `title`, `description` | 2 |

#### 7.2b `config_state` is not a validator — and your own successful write is not evidence

Writing `{"bogus_key_test":{"type":"number","value":99}}` to a `delay` block reads back `config_state: "complete"`. A `send-http-request` with no `body` also reads `complete`. **`complete` proves only that the write landed and the expression resolves — never that the keys are the ones the block actually reads.** **[VERIFIED]**

This has bitten this project concretely. An earlier revision of this document stated that modern `branch` takes `condition`, "verified by round-trip". The round-trip succeeded; the claim was still wrong. `condition` is the *legacy* name, and the modern block ignores it. It was caught only by harvesting 8 real `branch` blocks, every one of which used `predicate`.

So rank your evidence:

| Class | Trust |
|---|---|
| A config Attio's UI wrote (harvest, or HAR of the editor saving) | **Authoritative** |
| A snapshot node's `schema.inputs` (legacy only, §11.2) | Authoritative *for that engine* |
| Your own write returning `200` / `config_state: complete` | **Not evidence.** Says nothing about key names |
| A name carried over from the other engine, or from a similar block | Guess. Verify it |

#### App-provided blocks

Blocks contributed by installed integrations are in the corpus too, keyed `app:<app_block_id>`. There is no other source for their config keys, and they are needed the moment a client actually runs that tool.

| App block | Kind | Config keys | n |
|---|---|---|---|
| `send-message` (Slack) | step | `channelId`, `message`, `hideWatermark` | 8 |
| `a-note-create` | step | `parent_object`, `parent_record`, `format`, `title`, `content` | 1 |
| `lemlist-activity` | trigger | `eventType` | 1 |
| `add-email-to-sequence` | step | *(none set on the observed instance)* | 1 |

**The config keys are portable; the provider ids are not.** An app block's provider is `{"type":"app","app_id":…,"app_block_id":…,"app_user_connection_membership_id":…}`. Only `app_block_id` is recorded here. `app_id` and `app_user_connection_membership_id` identify a specific installation and a specific user's connection — every observed app block appeared in exactly one workspace, so there is **no evidence** those ids are portable, and the working assumption throughout this API is that uuids are workspace-scoped. Read them off an existing block in the target workspace, or off that workspace's installed app. Naturally, an app block only works where the app is installed at all.

**Caveat: this corpus is modern-engine only.** Legacy blocks are served through the snapshot path in a different shape, so all 38 legacy blocks in the sample harvested as "unknown / no config". Legacy input names come from `legacy-block-schemas.json` instead — and they **differ**: legacy `branch` and `find-records` both take `condition`, where modern `branch` takes `predicate` and modern `find-records` takes `filter`. Do not carry a name across engines.

**`delay` is still unverified.** Zero instances exist in any reachable workspace, so there is nothing to harvest. Build one in the UI and read it back before trusting any guess.

Known shapes, all **[VERIFIED]**:

`find-records` (v1)
```json
{"type":"object","entries":{
  "entity": {"type":"attio-object","entity_definition_id":"<companies-uuid>"},
  "limit":  {"type":"number","value":5}
}}
```

`on-record-created` (v1)
```json
{"type":"object","entries":{
  "object": {"type":"attio-object","entity_definition_id":"<companies-uuid>"}
}}
```

`send-http-request` (v1) — corrected 2026-08-24 from 5 UI-written instances. An earlier version of this section showed only three keys and no header item shape.
```json
{"type":"object","entries":{
  "method":       {"type":"string","value":"POST"},
  "url":          {"type":"string","value":"https://example.com/hook"},
  "content_type": {"type":"string","value":"application/json"},
  "headers": {"type":"array","items":[
    {"type":"object","entries":{
      "name":  {"type":"string","value":"Content-Type"},
      "value": {"type":"string","value":"application/json"}
    }}
  ]},
  "body": {"type":"json-string","json":"{\"text\": \"_\"}","variables":[ /* see below */ ]}
}}
```
Two traps here. A header item's key is **`name`**, not `key`. And `body` is **not a string** — it is a `json-string`, which is a template.

#### 7.2c `json-string` — variables spliced in by character offset

Wherever a config takes templated text, the value is a `json-string` node: literal JSON with a **single `_` character standing in for each interpolation**, plus a parallel array saying where each one goes.

```json
{"type":"json-string",
 "json":"{\"text\": \"_ at _ is interested\"}",
 "variables":[
   {"start_position":10,"length":1,"target_type":"string","variable":{"type":"variable","matchers":[…]}},
   {"start_position":15,"length":1,"target_type":"string","variable":{"type":"variable","matchers":[…]}}
 ]}
```

- `start_position` is a **0-indexed character offset into the `json` string**, pointing at the `_`.
- `length` is `1` — the width of the placeholder, not of the substituted value.
- `target_type` is the primitive the variable is coerced to (`string` observed).

Because the offsets are absolute, **editing the literal text invalidates every variable after the edit point**. Rebuild `json` and `variables` together, or splice carefully. This is the same mechanism as rich text (§7.4), which carries its variables in `blocks[].variables[]` instead. **[VERIFIED]**

**Fastest way to learn an unknown block's keys without the UI:** run `harvest-config-keys.js`, or find an existing workflow that already uses the block and read its config back. Across a few workspaces there is usually one.

### 7.3 Referencing another block's output

```json
{
  "type": "variable",
  "matchers": [{
    "id": "3538eee6-...",
    "block_instance_id": "<upstream block id>",
    "outcome": "done",
    "operations": [{"type":"field","name":"new_value"}]
  }],
  "as": {"type":"union","nodes":[{"type":"number"},{"type":"currency"}]}
}
```

- `block_instance_id` — the upstream block.
- `outcome` — which output branch of it.
- `operations[]` — an access path, applied in order:
  - `{"type":"field","name":"..."}` — plain field access.
  - `{"type":"attribute-definition","entity_definition_id":"...","attribute_definition_id":"..."}` — read a specific Attio attribute off a record in that output.
- `as` — expected type. Absent on some working matchers, so it appears optional.

**[VERIFIED]** by round-tripping a real workflow's variables through the API.


### 7.5 Discovering what a block outputs

`operations[]` in §7.3 is an access path into an upstream block's output. Attio publishes **no schema endpoint** for those outputs, and the picker in the UI is driven by bundled client code. So the practical source of truth is observation: read configs Attio's own UI wrote and index them by producing block.

The table below was harvested that way across 27 workflows in 2 workspaces (163 variable references). It is **observational** — a field missing here means "not observed", not "invalid".

`*` marks a field that holds a record, so the path can continue into an `attribute-definition` hop.

| Block | Type | Outcome | Output fields |
|---|---|---|---|
| `aggregate-values@v2` | step | done | total |
| `app` | trigger | triggered | lead_email, lead_first_name, lead_last_name, campaign_name |
| `assert-record@v2` | step | done | record  * |
| `create-task@v2` | step | done | created_task |
| `execute-code@v1` | step | done | return |
| `find-list-entries@v1` | step | done | entries, match_count |
| `find-records@v1` | step | done | records  *, match_count |
| `for-each@v1` | step | next | item |
| `on-attribute-invalidated@v1` | trigger | done | new_value, entity_instance  *, previous_value |
| `on-record-created@v1` | trigger | done | entity_instance  * |
| `on-record-updated@v1` | trigger | done | entity_instance  *, new_value |
| `on-task-created@v1` | trigger | done | at |
| `research-entity@v1` | step | done | answer_q1, answer_q2, answer_q3, answer_q4 |
| `round-robin@v2` | step | done | selected_user |
| `run-custom-ai-agent@v2` | step | done | response |
| `send-http-request@v1` | step | done | response_body |
| `update-record@v2` | step | done | record  * |

**Two different kinds of identifier appear in a path**, and conflating them is the usual failure:

- **Block-native fields** (`new_value`, `records`, `response_body`) are properties of the block type. Stable across workspaces.
- **Attribute hops** (`{"type":"attribute-definition", ...}`) are workspace-specific UUIDs. `GET /entity-definitions/{eid}/attribute-definitions` returns them, wrapped in `{"value":[...]}`. **[VERIFIED]**

```bash
curl -s "$BASE/entity-definitions/$OBJ/attribute-definitions" -H "Cookie: $ATTIO_COOKIE" \
  | python3 -c 'import sys,json;[print(a["api_slug"],a["attribute_definition_id"],a["type"]) for a in json.load(sys.stdin)["value"]]'
```

**Select option ids ARE on this API — corrected 2026-08-24.** An earlier revision said the opposite after probing eight candidate paths. The path exists:

```
GET /entity-definitions/{def}/attribute-definitions/{attr}/select-options
```

It returns `{accurate_at, values:[…]}`. The plural `values` is what defeated the original probe: unwrapping `.value` gives `undefined`, and an unknown path under `/api/` returns a `200` with SPA HTML rather than a `404`, so "no such route" and "wrong envelope key" look identical. Whenever an endpoint here seems absent, check the envelope before concluding it is. **[VERIFIED 2026-08-24]**

The public API still works for the same ids and remains fine to use: **[VERIFIED against internal-tooling/attio/export_option_mapping]**

```
GET /v2/{objects|lists}/{identifier}/attributes/{attr_slug}/options    # select, multiselect
GET /v2/{objects|lists}/{identifier}/attributes/{attr_slug}/statuses   # status, pipeline
```

Those are what fill `pipeline_stage_id` in an `attio-pipeline` comparison value.

**Presetting variables headlessly is confirmed to work.** A `guard` built entirely over the API, whose predicate referenced a trigger's `new_value`, read back with `config_state: "complete"` and an intact matcher. There is no requirement to touch the UI. The matcher `id` is a client-generated UUID. **[VERIFIED]**

### 7.4 Rich text with inline variables

Message bodies (Slack, etc.) use `rich-text`. Each block carries `plaintext` plus a `variables[]` array positioning each reference by `start_position` and `length` **against the plaintext**. Editing copy without recomputing those offsets corrupts the mapping. **[VERIFIED]**

---

## 8. Recipes

### 8.1 Build a workflow from scratch

```bash
SLUG=your-workspace; BASE="https://app.attio.com/api/common/workspaces/$SLUG"
H=(-H "Cookie: $ATTIO_COOKIE" -H "Origin: https://app.attio.com" -H "Content-Type: application/json")
uuid() { uuidgen | tr 'A-Z' 'a-z'; }

WF=$(uuid)
VER=$(curl -s -X PUT "$BASE/workflows/$WF" "${H[@]}" \
  -d '{"title":"My workflow","is_modern":true}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["draft_workflow_version_id"])')

TRIG=$(uuid)
curl -s -X PUT "$BASE/workflows/$WF/versions/$VER/block-instances/$TRIG" "${H[@]}" -d '{
  "block_type":"trigger",
  "provider":{"type":"system","system_block_slug":"on-record-created","system_block_version":"v1"},
  "description":null,"position":{"x":0,"y":0},
  "config":{"type":"object","entries":{"object":{"type":"attio-object","entity_definition_id":"'"$COMPANIES"'"}}}}'

STEP=$(uuid)
curl -s -X PUT "$BASE/workflows/$WF/versions/$VER/block-instances/$STEP" "${H[@]}" -d '{
  "block_type":"step",
  "provider":{"type":"system","system_block_slug":"find-records","system_block_version":"v1"},
  "description":null,"position":{"x":270,"y":0},
  "config":{"type":"object","entries":{
    "entity":{"type":"attio-object","entity_definition_id":"'"$COMPANIES"'"},
    "limit":{"type":"number","value":5}}}}'

curl -s -X PUT "$BASE/workflows/$WF/versions/$VER/paths/$(uuid)" "${H[@]}" -d '{
  "source":{"workflow_version_block_instance_id":"'"$TRIG"'","outcome":"done"},
  "target":{"workflow_version_block_instance_id":"'"$STEP"'"}}'
```

It stays `draft` with `active_workflow_version_id: null` throughout. It will not run.

### 8.2 Clone an existing workflow

Verified on a live 4-block workflow (attribute-change trigger → switch → two Slack messages); the clone's configs came back **byte-identical** to the source after id normalization. **[VERIFIED]**

1. **Read the source's `active` version**, not the draft — a live workflow's draft may hold unpublished edits that are not what is running.
2. Pull blocks and all configs (`batch-get-config`; remember `[id].value.config.value`).
3. Generate a new UUID per block and **string-replace old ids throughout the entire config JSON**:
   ```js
   const remap = o => {
     let s = JSON.stringify(o);
     for (const [oldId, newId] of Object.entries(idMap)) s = s.split(oldId).join(newId);
     return JSON.parse(s);
   };
   ```
   A top-level walk is not enough — references hide inside switch predicates and `rich-text.blocks[].variables[]`.
4. `PUT` each block, copying `provider`, `description` and `position` verbatim. App providers copy across fine.
5. `PUT` each path with remapped endpoints and the **outcome string unchanged**, so `case_*` values keep matching the switch config.
6. **Verify** by normalizing the clone's ids back and comparing config strings to the source, and by confirming none of the source block ids survive anywhere in the clone.

### 8.3 Publish and roll back

**Publishing is not fully reproducible externally yet** — the `commit` body is unmapped (§5.4). Activation and rollback work once you have an immutable version id:

```bash
# activate an immutable version (id comes from commit, which is unmapped)
curl -s -X POST "$BASE/workflows/$WF/versions/$IMMUTABLE_VER/activate" "${H[@]}" -d '{}'

# roll back — verified working
curl -s -X POST "$BASE/workflows/$WF/versions/$ACTIVE_VER/deactivate" "${H[@]}" -d '{}'
```

Until `commit` is mapped, publish via the Attio UI and use the API for everything else. Building, cloning and modifying drafts are all fully supported.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `403` on any write | Missing/wrong `Origin` | Send `Origin: https://app.attio.com` |
| `401` everywhere | Cookie expired or wrong | Re-capture (§2.3) |
| `401` using an API key | API keys don't work here | Use a session cookie |
| `400 {}` on block create | Missing `config` | Include it, even empty |
| `400 {}` after copying a read response | Id fields in the body | Strip them; they belong in the URL |
| `400 {}` on a config write | Sent the `{state,value}` wrapper | Send the bare node |
| `400 {}` on an otherwise valid block | Wrong `system_block_version` | Versions differ per block; read a real one back |
| `400 {}` on list | Missing `sort`, or body not an array | Both are required |
| `400 "No change provided"` | `PATCH` with only `config` | Send full block fields, or use `PUT .../config` |
| `409` on block create | Block id already exists | `PUT` is create-only; use `PATCH` or `PUT .../config` |
| Created a workflow, can't add blocks | `draft_workflow_version_id` is null | You omitted `is_modern: true` |
| `PUT /versions/{uuid}` → `404` | Versions aren't client-created | Server provisions them |
| `POST /workflows` → `404` | No collection POST | `PUT /workflows/{client-uuid}` |
| Write succeeds, editor shows **"Unsupported block"** | You sent a `system_block_version` that block does not have. **The API accepts any version string without validating it** and returns 200. | Check the version against a block of the same type in a real workflow. There is no endpoint that lists valid versions. |
| Write succeeds, editor shows "Unsupported block", version is right | You used the **catalog** slug instead of the **provider** slug. See §6. | `outbound-webhook` → `send-http-request`, `foreach` → `for-each` |
| `get_workflow` → "no version" on a workflow that plainly exists | It is a **legacy** workflow. Both version ids are null and `/versions` returns `[]`. | Read its snapshot instead. See §11. |
| `200` but body is HTML | Path doesn't exist; SPA fallback | Check `Content-Type` |
| Config set via API, UI says "required" | Wrong config key for that block | Keys are per-block; see §7.2 |
| Publish button does nothing | A block fails UI validation | Fill required inputs; `config_state` alone isn't enough |
| Switch leg silently disconnected | `case_*` outcome ≠ `cases[].id` | Keep them in sync |

---

## 10. Caveats

- **Unofficial and undocumented.** No stability guarantee. Slugs, versions and payload shapes can change without notice.
- **`Origin` on every non-GET.** The most likely thing to break an external client, because browsers set it invisibly and the resulting `403` reads like a permissions problem.
- **Session cookie only**, per-user, unscopeable, 30-day expiry. Not suitable for unattended production automation without a refresh strategy.
- **`400` responses carry no detail.** Body is literally `{}`. Work through §9 in order.
- **Slugs ≠ labels**, and **config keys differ per block**. Both must be read from a real block, never guessed.
- **`PUT` on an existing block is `409`.** Updates need `PATCH` or the `/config` sub-resource.
- **Publishing fires on real data.** Build in draft, verify, and only then activate. Deactivate sets `paused`, it does not return to `draft`.
- **Publishing is out of scope.** `commit` is unmapped, so an external client cannot activate a workflow. This is by design: build the draft via the API, then publish it deliberately in the UI. Deactivation *is* mapped, so you can always turn something off. See §5.4.
- **Deletes cascade** and there is no undo or trash observed.
- **Two workflow engine generations exist**, and the split is real, not cosmetic. `is_modern: false` workflows store their definition in **snapshots**, not versions, and are unreadable through §5. They are common in older workspaces: 8 of 11 workflows in one client workspace were legacy. See §11.
- **Three different slug namespaces**, and mixing them fails silently. See §6.
- **The variable picker in the UI is entirely client-side.** Opening it fires zero network requests (confirmed by proxying the browser). No endpoint returns a block's output fields for modern workflows; the only server-provided schema is on legacy snapshot nodes (§11). The per-block counts the picker shows are also **filtered by the target input's type**, so "no data" means "nothing compatible with this field", never "this block has no outputs".
- **Confirm the workspace slug before any write.** One slug in a URL separates a sandbox from production.

---

## 11. Legacy (pre-modern) workflows

Everything above describes the **modern** engine. Attio also runs an older one, and older workspaces are full of it. These workflows are still live and still firing; they are simply invisible to §5.

**How to recognise one.** On the workflow record: `is_modern: false`, and **both** `draft_workflow_version_id` and `active_workflow_version_id` are `null`. `GET /workflows/{id}/versions` returns `[]`. Any attempt to read blocks through the version endpoints fails.

### 11.1 Where the definition lives

Snapshots, not versions.

| Call | Returns |
|---|---|
| `GET /workflows/{id}/snapshots` | All snapshots. Each has `workflow_snapshot_id`, `parent_workflow_snapshot_id`, `status` (`draft` / `live` / `historic`), `entity_definition_id`, `published`. **[VERIFIED]** |
| `GET /workflows/{id}/snapshots/{sid}` | One snapshot's metadata. No blocks. **[VERIFIED]** |
| `GET /workflows/{id}/snapshots/{sid}/nodes` | **The blocks.** **[VERIFIED]** |
| `GET /workflows/{id}/snapshots/{sid}/edges` | The connections between them. **[VERIFIED]** |

Pick the snapshot whose `status` is `live` to see what is actually running; `draft` is the unpublished edit; `historic` is superseded.

### 11.2 Snapshot nodes carry a real schema

This is the most valuable thing in the legacy API, and it has no modern equivalent.

Each node has:

```json
{
  "workflow_snapshot_node_id": "...",
  "default_description": "Creates or updates a Person",
  "block": { "workflow_block_id": "...", "workflow_block_version_id": "..." },
  "position": { "x": -10, "y": 380 },
  "schema": {
    "last_synced_at": "...",
    "inputs":   [{ "slug": "entity_definition_id", "title": "List", "allowed_data_types": [...] }],
    "outputs":  [{ "slug": "record", "title": "Record" }],
    "outcomes": [...],
    "subgraphs": [...]
  }
}
```

`schema.outputs` is **the only place Attio serves a block's output field names over the API.** For modern workflows that information is resolved entirely in the browser (§10). `block.workflow_block_id` joins exactly to `GET /workflow-blocks`, so the mapping from node to block type is precise rather than inferred.

Harvested output slugs, verified across 11 legacy workflows in three workspaces. **Block names below are CATALOG slugs** (nodes join to the catalog by `workflow_block_id`), so translate via §6.4 before using them in a modern config:

| Block | Outputs |
|---|---|
| `on-record-updated` / `on-attribute-updated` | `record`, `previous_value`, `new_value`, `actor`, `updated_at` |
| `on-record-action` | `record`, `actor`, `triggered_at` |
| `on-entry-updated` | `entry`, `actor`, `updated_at` |
| `on-task-created` | `task`, `actor`, `created_at` |
| `on-interval-activated` | `triggered_at` |
| `find-records` | `records`, `match_count` |
| `create-record` / `assert-record` | `record` |
| `create-entry` | `entry` |
| `create-task` | `task` |
| `outbound-webhook` | `response_status`, `response_body`, `response_ok` |
| `enroll-in-sequence` | `enrolled_successfully` |
| `shift-timestamp` | `value` |
| `branch` | `matched` |

**Do not paste these straight into a modern workflow.** The two engines do not always agree: legacy `on-record-updated` exposes `record`, while the modern block exposes `entity_instance`. Where they do agree (`find-records` → `records`, `match_count` in both) confidence is high. Treat this table as authoritative for legacy and as a strong hint for modern.

### 11.3 Runs

```
GET /workflows/{id}/runs          # ids only; 400 "legacy workflows only" if the workflow is modern
GET /workflow-runs/{run_id}       # status, timings, failure_reason, workflow_snapshot_id
```

The run names the exact snapshot it executed, so a failed run can be traced to the definition that produced it.

### 11.4 Writing

Not attempted. Everything in this section is read-only, and the node/edge write shape is unmapped. Since these workflows are typically live, the safe pattern is: read the legacy definition, rebuild it as a modern workflow, verify, then retire the old one deliberately in the UI.

---

## Appendix — Reference implementation

A working MCP server implementing this API ships alongside this document as `server.js` (zero dependencies, Node 18+). It demonstrates auth and profiles, the `Origin` requirement, the create/update split, name-to-uuid resolution across both APIs, variable wiring, legacy snapshot reading, and cloning with id remapping. It deliberately has no publish tool.

Two harvesters accompany it, both of which regenerate their data against any set of workspaces:

- `harvest-variables.js` — reads every `{"type":"variable"}` node in existing modern workflows and indexes it by the block that produced it, building an observational output catalog.
- `harvest-legacy-schemas.js` — pulls `schema.inputs` / `schema.outputs` off legacy snapshot nodes, which is the only server-provided block schema available (§11.2).

See `attio-workflow-claude-code-guide.md` for setup.
