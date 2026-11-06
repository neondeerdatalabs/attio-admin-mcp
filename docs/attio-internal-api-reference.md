# Attio Internal API — Views (and the non-Workflow surface)

A companion to `attio-workflow-api-reference.md`. Same host, same cookie, same `Origin` rule — a different set of resources.

Attio's **public** API can *read* views but cannot create or modify them. This document covers the internal API that the Views UI itself talks to.

Reverse-engineered from HAR captures by **Erik Ash** (2026-08-18) and independently re-verified against live workspaces on 2026-08-24 and 2026-09-03. One of his conclusions was wrongly overturned on the first pass and restored on the second — see [Lists](#5-lists). His original kit is Python; the tools described here are the Node reference implementation in `server.js`.

**Verification legend** matches the workflow reference: **[VERIFIED]** executed live and confirmed · **[OBSERVED]** seen in captured traffic · **[INFERRED]** reasoned, unproven.

> **Unofficial and undocumented.** Attio can change it without notice. Cookie-is-you: every write shows up as your user.

---

## 1. The naming that hides it

Nothing here is called what the UI calls it.

| UI concept | Internal API term |
|---|---|
| object *or list* | `entity-definition` |
| view | `entity-view` |
| view's column | `entity-view-attribute` |
| view's sort | `entity-view-sort` |
| filter | `entity-filter` + `entity-filter-block` |
| attribute | `attribute-definition` |

## 2. Auth and conventions

Identical to the workflow API — see its §2 and §3 in full. The short version:

- **Base:** `https://app.attio.com/api/common/workspaces/{slug}` — slug, not uuid.
- **Read:** the session cookie alone.
- **Write:** cookie **plus `Origin: https://app.attio.com`**. Without it, every non-GET returns `403`.
- **The client mints uuids.** New views, columns and filter blocks are `PUT` to a URL containing an id you generated. There is no POST-to-collection.
- **A `200` with an HTML body means the route does not exist** (SPA fallback). Check `Content-Type`.

> A `DELETE` needs `Origin` too. This is easy to get wrong in a quick script, because a body-less request is where you are least likely to think about headers — a probe written during this work silently left a view behind for exactly that reason. **[VERIFIED]**

## 3. Verified endpoints

### Read

```
GET /entity-definitions
GET /entity-definitions/{def}
GET /entity-definitions/{def}/attribute-definitions
GET /entity-definitions/{def}/entity-views
GET /entity-definitions/{def}/entity-views/{view}
GET /entity-definitions/{def}/entity-views/{view}/entity-view-attributes
GET /entity-definitions/{def}/entity-views/{view}/entity-view-sorts
GET /entity-definitions/{def}/entity-filters/{filter}/entity-filter-blocks
```

All **[VERIFIED]**.

### Create a view — `200`

```
PUT /entity-definitions/{def}/entity-views/{NEW_view_uuid}
{ "entity_filter_id": "{NEW_filter_uuid}",
  "title": "...", "type": "table",
  "sort_order": "m0000",
  "kanban_aggregation": null, "kanban_pivot_path": null,
  "kanban_attribute_label_display_mode": null,
  "kanban_is_no_status_visible": null, "kanban_is_time_in_status_visible": null }
```

**An empty filter container is fine.** `entity_filter_id` is just a uuid the view points at; you do not have to create any filter blocks for the view to work. Filters are additive afterwards. **[VERIFIED]**

### Create a kanban (board) view, `200` **[VERIFIED 2026-11-06]**

Same `PUT`, with `type: "kanban"` and the `kanban_*` fields set. Shapes captured from three UI-built deal boards, then confirmed by PUT and read-back on `deals` (pivot `stage` and `merge_status`) and on a custom object (`invoices.payment_status`).

```
{ "entity_filter_id": "{NEW_filter_uuid}", "title": "...", "type": "kanban", "sort_order": "m0000",
  "kanban_pivot_path": [{ "entity_definition_id": "{def}", "attribute_definition_id": "{status_attr}" }],
  "kanban_attribute_label_display_mode": "icon",
  "kanban_is_no_status_visible": true, "kanban_is_time_in_status_visible": true,
  "kanban_aggregation": null }
```

- **Pivot is a STATUS attribute** (internal type `pipeline`). Deal stage is one, so deals are not a special case. Attio does **not** enforce this: a pivot on a `select` attribute returns 200. `create_view` refuses it.
- `kanban_pivot_path: null` appears on some UI-built deal boards (probably meaning the default stage). `create_view` always writes an explicit pivot.
- **`kanban_aggregation` is dropped by `PUT`** (stored as null even with a captured shape). `PATCH` on the view stores it. Attio validates `type` (`count_not_empty` and `sum` accepted, a bogus value returns 400) but stores any `field` string, so only `{path:[record_id], field:"value", type:"count_not_empty"}` is a captured shape. Not exposed by `create_view` until each aggregation is captured from the UI.
- `kanban_attribute_label_display_mode`: only `"icon"` observed. Attio accepts any string here, so do not invent others.

### Kanban column visibility, `200` **[VERIFIED 2026-11-06]**

Which stage columns a board shows is **not a filter** (a filter hides cards; every stage column still renders). It is a per-board, per-stage record set from the board's settings menu. Captured from the UI's board settings menu on a client workspace, replayed headless in a second workspace.

```
POST  /entity-definitions/{def}/entity-views/{view}/kanban-stage-characteristic
      { "pipeline_leaf_attribute": { "entity_definition_id": "{def}", "attribute_definition_id": "{status_attr}" } }
  ->  [ { pipeline_stage_id, is_visible, aggregation, ... }, ... ]   // the READ; GET returns SPA HTML

PATCH /entity-definitions/{def}/entity-views/{view}/kanban-stage-characteristic
      { "pipeline_leaf_attribute": {...}, "pipeline_stage_id": "{stage}", "is_visible": false, "aggregation": null }
  ->  the upserted record. Works for hide and for re-show (is_visible: true).
```

- A stage with no record is visible. Only touched stages come back from the POST read.
- `aggregation` here is the per-column calculation ("Add calculation" under a column). `set_kanban_columns` carries any existing value through untouched; its shape is not captured.
- Tools: `set_kanban_columns` (show / hide / unhide), `create_view` `visible_stages`, `get_view` returns `visible_stages` / `hidden_stages`.

### Add a column — `200`, one `PUT` per column

```
PUT .../entity-views/{view}/entity-view-attributes/{NEW_uuid}
{ "path": [ {"entity_definition_id":"{def}", "attribute_definition_id":"{attr}"} ],
  "field": null, "sort_order": "m0001" }
```

**`path` is a list of hops, and more than one hop reads a field off a *linked* record.** A 2-hop column was verified live: `companies.team` → `people.email_addresses`, i.e. show the email of the linked person on the company row. Each hop names the entity it starts from. **[VERIFIED]**

### Delete a view — `204`, then `GET` → `404`

```
DELETE /entity-definitions/{def}/entity-views/{view}
```

**[VERIFIED]**

### Filters — full replace

```
PUT /entity-definitions/{def}/entity-filters/{filter}/entity-filter-blocks
[ {"block_type":"group","group_mode":"and","parent_entity_filter_block_id":null,
   "entity_filter_block_id":"{uuid}","sort_order":"m0000"},
  {"block_type":"filter","parent_entity_filter_block_id":"{group uuid}",
   "entity_filter_block_id":"{uuid}","sort_order":"m0001",
   "filter_mode":"must",                       // must | must-not
   "filter_path":[ {"attribute_definition_id":"{attr}","entity_definition_id":"{def}"} ],
   "constraints":[ ... ] } ]
```

The body is an **array forming a tree**: one root group, then one block per condition. It is a **full replace** — send every filter you want kept; an empty array clears them. **[VERIFIED]**

## 4. Constraint fields are keyed to the attribute TYPE

This is the part that punishes guessing, and the reason Erik's kit carries the rule in capitals: **field names are keyed to the attribute type and are not derivable from each other.** `actor` uses `referenced_actor_id`; `select` uses `select_option_id`. Neither is evidence for the other. Two failed round-trips established this.

| kind | attribute type | constraint field(s) | status |
|---|---|---|---|
| `actor` | actor-reference (Owner, PM…) | `referenced_actor_id` + `referenced_actor_type` | **[VERIFIED 2026-08-18]** |
| `select` | select / status | `select_option_id` | **[VERIFIED 2026-08-18]** |
| `generic` | scalar text/number | `value` | **UNVERIFIED** |

Every constraint set also carries a row-versioning constraint that must always be appended:

```json
{"field":"active_until","operator":"empty","value":"null","value_type":"static"}
```

For `actor`, the value `"current-member"` with `value_type: "dynamic"` produces a per-viewer "my records" filter; any other value is a static workspace-member id.

`op: "is_not"` maps to `filter_mode: "must-not"`, not to a different operator.

> **`generic` is stored successfully and is still unverified.** Writing it returns `200` and reads back intact — which proves the write landed, not that Attio filters on it the way you meant. This is the same trap as `config_state: "complete"` on workflows (workflow reference §7.2b). Before relying on `generic`, build that filter once in the UI and compare with `get_view`.

**To add a type** (record-reference, date, number, currency, checkbox…): build one real filter of it in the Attio UI, read it back with `get_view`, and add an entry to `CONSTRAINT_KINDS` in `server.js` **with the date**. The tools refuse an unknown kind rather than falling back to `generic`, precisely so a wrong filter cannot be written silently.

## 5. Lists

**Lists are entity-definitions.** A list id drops into the endpoints above where an object id goes, and `entity_definition_id === list_id`. Their `entity_type` is `collection-entry`. **[VERIFIED]**

Two things follow that are not obvious:

1. **Lists are not returned by `GET /entity-definitions`.** That endpoint lists objects only. A list is reachable by id but not discoverable there — use internal `GET /collections` (cookie only, below), or the public `/v2/lists`, or `preflight`.
2. **A list carries a `parent_record` attribute (type `entity-reference`) that the public API does not expose at all.** Confirmed by diffing internal `attribute-definitions` against public `/v2/lists/{id}/attributes`: `parent_record` is present internally and absent publicly. It is the first hop of any column that shows parent-record data on a list view. **[VERIFIED]**

### Discovering lists — `GET /collections`

Because `/entity-definitions` omits them, lists need their own route:

```
GET /collections
{ "accurate_at": "…", "values": [ {"id":"…","name":"Duplicate People","is_public":false, …} ] }
```

`values`, plural, like the options envelope. The `id` here is the **list_id and the entity_definition_id** — one id, both roles. This works on the **cookie alone**, so a list id no longer requires the public API or an API key. **[VERIFIED 2026-09-03]**

### View creation on a list DOES work

An earlier revision of this document recorded list view creation as broken, on the strength of a `404 "The requested Entity Definition could not be found"` seen on 2026-08-24, and `create_view` was made to refuse `collection-entry` targets outright.

**That is wrong.** Re-tested end to end on 2026-09-03 against a list created for the purpose:

| Operation on a list | Result |
|---|---|
| `GET .../entity-views` | `200` **[VERIFIED]** |
| `GET .../attribute-definitions` | `200` **[VERIFIED]** |
| `PUT .../entity-views/{new_id}` (create) | **`200`** **[VERIFIED 2026-09-03]** |
| `PUT .../entity-views/{view}/entity-view-attributes/{id}` (column) | `200`, including the multi-hop `parent_record` form **[VERIFIED 2026-09-03]** |
| `PUT .../entity-filters/{filter}/entity-filter-blocks` | `200` **[VERIFIED 2026-09-03]** |

Create, add a `parent_record → companies.name` column, apply an actor filter, read the whole thing back: every step `200`, and `get_view` returns the view with its column path and filter blocks intact. The guard in `create_view` has been removed.

What the original `404` was is not established. It is not a standing limit on lists, so do not design around it; if it reappears, capture the failing request rather than reinstating a blanket refusal.

### Creating and deleting lists

Lists straddle the two APIs, in opposite directions:

- **Create: public API only.** `POST /v2/lists` with `{"data":{name, api_slug, parent_object, workspace_access, workspace_member_access}}`. There is no internal create route, so this is the one write in this server that needs an API key. **`api_slug` must be snake_case** — kebab-case returns a validation error.
- **Delete: internal API only.** There is no `DELETE /v2/lists/{id}` on the public API at all (`404 "Could not find endpoint"`).

```
DELETE /collections/{list_id}      -> 200, list and its views/attributes/entries gone
DELETE /entity-definitions/{list_id} -> 400 "The Entry Entity Definition cannot be deleted"
```

**Verify deletion against `/collections/{id}`, not `/entity-definitions/{id}`.** Deleting a list leaves its *entry* entity-definition behind, so the entity route keeps returning `200` for a list that is genuinely gone — the public API 404s it and it disappears from `/collections`. That lingering definition is also what the `400` above is complaining about. Checking the wrong route reports a successful delete as a failure. **[VERIFIED 2026-09-03]**

## 6. Select and status options

### Option ids ARE on the internal API

The workflow reference previously recorded that select/status option ids are **not** available internally, after eight candidate paths were probed and none appeared to exist. That was wrong, and the reason is worth knowing:

```
GET /entity-definitions/{def}/attribute-definitions/{attr}/select-options
{ "accurate_at": "...", "values": [ ... ] }
```

The envelope key is **`values`**, plural. Everything else in this API uses `{value: [...]}`, singular. Code that unwraps `.value` gets `undefined` here, which is indistinguishable from "this route does not exist" — especially when the SPA also answers unknown paths with a `200`. **[VERIFIED 2026-08-24]**

This matters practically: `list_select_options` works on the **session cookie alone**, while `preflight` needs an API key to get the same ids off the public API.

Each option:

```json
{"select_option_id":"…","title":"Retainer","color":"pastel_blue",
 "sort_order":"ccock","is_archived":false,
 "workspace_id":"…","entity_definition_id":"…","attribute_definition_id":"…"}
```

### Colour and order — one PATCH per field

The public API cannot set an option's colour at all. The internal one can, and colour is a **named palette value, not hex**:

```
PATCH /entity-definitions/{def}/attribute-definitions/{attr}/select-options/{option_id}
  {"color": "pastel_blue"}      // recolour
  {"sort_order": "m0000"}       // reorder
```

Both verified `200`. They are separate single-field PATCHes; the UI fires them in a batch on Save, which is why nothing happens until you hit Save there. **[VERIFIED 2026-08-24]**

**Attio validates the palette itself.** An unknown colour name returns `400` and stores nothing — unlike `config_state` on workflows, this API really does check. That makes the palette enumerable, and it has now been enumerated rather than observed: every name below was PATCHed successfully, and `pink`, `cyan`, `indigo`, `lime`, `gold`, `black`, `white`, `navy` and `olive` were all rejected. **[VERIFIED 2026-09-03]**

```
red  orange  yellow  green  light-green  teal
blue  purple  violet  brown  magenta  grey
```

Twelve names, and **the same twelve serve both namespaces** — only the prefix changes (`pastel_` for select, `block_` for status, see below). Because the set is now closed, `set_select_options` rejects an unknown name client-side instead of warning and sending it: the only thing that could follow is an empty `400`. It also accepts a bare `"red"` and applies the right prefix for you.

### Status attributes are a SECOND namespace — `pipeline-stages`

A status attribute reports type **`pipeline`** on the internal API, and its options are **not** at `select-options`. That route returns a real, specific error for them:

```
GET …/attribute-definitions/{status_attr}/select-options
  -> 400 {"message":"Select options cannot be retrieved for non-select attributes"}
```

This is the trap that made status colours look impossible for two weeks. The `400` reads as a flat refusal rather than a wrong-route, and the obvious alternative guesses (`statuses`, `status-options`, `options`) all fall through to the SPA, which answers unknown paths with an **HTML `200`**. A miss and a wrong guess are indistinguishable. The real route is:

```
GET   /entity-definitions/{def}/attribute-definitions/{attr}/pipeline-stages
PATCH /entity-definitions/{def}/attribute-definitions/{attr}/pipeline-stages/{stage_id}
  {"color": "block_red"}     // recolour
  {"sort_order": "m0000"}    // reorder
```

Both `200`. **[VERIFIED 2026-09-03]**

| | select | status |
|---|---|---|
| internal `type` | `select` | `pipeline` |
| route segment | `select-options` | `pipeline-stages` |
| id field | `select_option_id` | `pipeline_stage_id` |
| colour prefix | `pastel_` | `block_` |

The wrong prefix is rejected with an **empty `400`** (`pastel_red` on a status attribute stores nothing), so `set_select_options` checks the namespace before sending and says which one the attribute wants. Everything else — the `values` envelope, one-PATCH-per-field, the reordering behaviour — is identical across both.

**Neither colour nor order is reachable from the public API for either type.** Public `/options` and `/statuses` return ids and titles only, with no colour and no order field, so this route is the only programmatic way to set them.

**Adding an option is a two-API operation.** Creation is public-API (`POST …/options` or `POST …/statuses`, under `/v2/objects/{id}/…` or `/v2/lists/{id}/…`), and it **silently ignores a `color` field** — the option is created with a **random** palette colour (`pastel_*` for select, `block_*` for status, repeats possible). Until at least 2026-09-03 it was always `pastel_grey`/`block_grey`; random as of 2026-11-06 **[VERIFIED 2026-11-06, both kinds, 8 options x 2 runs each]**. Create it there, then PATCH the colour here. `add_select_options` does both halves in one call, validating every colour before it creates anything so a typo cannot leave half the options created and uncoloured. **[VERIFIED 2026-09-03]**

Reordering assigns fresh keys to **every** option, so the result is a total order: the ones you name first, in the order given, then the rest in their existing order. Note that this rewrites the stored `sort_order` strings even for options you did not mention — the visible order is preserved, the keys are not.

## 7. Record-page layouts

A record page is **one tree of elements**, saved by a full-replace POST. There is no per-element endpoint.

```
GET  /entity-definitions/{def}/custom-layouts   -> {accurate_at, custom_layouts:[...]}
GET  /custom-layouts/{id}                       -> {..., elements:[...]}
POST /custom-layouts/{id}   {"elements":[ ...THE ENTIRE TREE... ]}
```

Layout `type` is `record-page` (the detail page) or `custom-form` (Quick Add). **[VERIFIED 2026-08-24]**

> **A third envelope.** `custom-layouts` wraps its list as `{custom_layouts:[…]}`. With `{value:[…]}` and `{values:[…]}` (§6), this API now has three known envelope conventions and no rule connecting them. Read the keys; never assume.

### Full replace means omission is deletion

Everything is read-modify-write. Anything absent from `elements` is deleted — there is no archive flag in the save path, even though elements carry an `archived_at` field.

What makes this safe to build on: **an identity write round-trips byte-identical.** POST back exactly what you read and all 25 elements come back unchanged, field for field. **[VERIFIED 2026-08-24]** So a tool that reads, edits, and writes loses nothing it did not intend to.

### Element shapes — the accepted key set is exact

Elements are linked by `parent_element_id` and ordered by `sort_order` among siblings.

A **section**:
```json
{"element_id":"<new uuid>","type":"details","title":"Deal Health","slug":null,
 "parent_element_id":"<the group holding sections>","sort_order":"m0000",
 "archived_at":null,"is_locked":false,"is_system_element":false}
```

A **field**, which adds `path` and `field`:
```json
{"element_id":"<new uuid>","type":"detail-value","title":null,"slug":null,
 "parent_element_id":"<container>","sort_order":"m0001",
 "archived_at":null,"is_locked":false,"is_system_element":false,
 "path":[{"entity_definition_id":"…","attribute_definition_id":"…"}],"field":null}
```

**That key set is not advisory, and the failure modes are opaque in both directions:** **[VERIFIED 2026-08-24]**

| Body | Result |
|---|---|
| Section carrying `path:null, field:null` | **`400` with an empty body** |
| Element missing `slug` / `archived_at` / `is_locked` / `is_system_element` | **`500` Internal Server Error** |
| Correct key set, with or without `workspace_id`/`custom_layout_id`/`created_at` | `200` |
| No `element_id` (hoping the server mints one) | `400` |

So a section must **omit** `path`/`field` entirely rather than null them, the client must mint `element_id`, and the server-managed fields are optional on write. Copying the key set off a sibling element of the same type is the reliable way to get this right.

**A child's type is keyed to its CONTAINER, not to the field:**

| Container | Child type |
|---|---|
| `details` | `detail-value` |
| `email-tab` | `email-tab-value` |
| `relationship-tab` | `relationship-tab-value` |

Fixed tabs (`overview-tab`, `activity-tab`, `email-tab`, `call-tab`, `note-tab`, `file-tab`, `task-tab`) take no config and are one per page. `group`s and `*-action` elements are system structure — pass them through untouched.

### Gotcha: archived attributes save and never render

A field element pointing at an `is_archived: true` attribute returns `200` and then simply never appears on the page. Check `is_archived` first. `edit_layout` skips archived attributes with a loud warning rather than writing an invisible field, and `get_layout` flags any existing element that references one.

### Tools

| Tool | Purpose |
|---|---|
| `list_layouts` | An object's layouts, with `custom_layout_id` and type |
| `get_layout` | The tree, attribute uuids resolved to slugs; `raw:true` adds the untouched array |
| `edit_layout` | `add_sections` / `add_fields` / `remove`, read-modify-write, with `dry_run` |
| `set_layout` | Escape hatch: replace the whole tree yourself |

`edit_layout` removes descendants along with their parent, because omission is deletion and orphans would otherwise linger. Both write tools refuse to drop `is_system_element` / `is_locked` elements, and `set_layout` refuses an empty array.

## 8. `sort_order`

Attio uses fractional-index strings (`wpit6`, `h1gzf`, `kkk`). Any lexically-ordered string works for fresh views and appends; `sortKey(i)` emits `m0000`, `m0001`, … Reordering an existing column is a `PATCH` with a new `sort_order`. **[VERIFIED]**

## 9. Tools

| Tool | Endpoint |
|---|---|
| `list_lists` | `GET /collections` — every list, cookie only, no API key |
| `create_list` | `POST /v2/lists` — **public API, needs an API key**. snake_case slug |
| `delete_list` | `DELETE /collections/{id}`, verified against `/collections/{id}`. Refuses objects |
| `list_views` | `GET .../entity-views` |
| `get_view` | view + columns + sorts + filter blocks, attribute uuids resolved to slugs |
| `create_view` | `PUT .../entity-views/{id}`, plus columns and filters in the same call. Works on lists |
| `add_view_column` | `PUT .../entity-view-attributes/{id}`, multi-hop aware |
| `set_view_filters` | `PUT .../entity-filter-blocks` (full replace) |
| `delete_view` | `DELETE .../entity-views/{view}`, verifies it is gone |
| `add_select_options` | Creates on the **public API**, then PATCHes colour here. **Needs an API key** |
| `list_select_options` | `GET .../select-options` or `.../pipeline-stages` — ids, titles, colours, order. Cookie only |
| `set_select_options` | `PATCH` per option, for colour and/or order. Select and status both |
| `list_layouts` / `get_layout` | Record-page layouts, as a resolved tree |
| `edit_layout` / `set_layout` | Full-replace edits, read-modify-write, with a dry run |

`object` accepts an object `api_slug` or any entity-definition uuid, so the same tools address objects and lists. The option tools pick their route from the attribute's type, and return `option_id` as a namespace-neutral alias alongside the native `select_option_id` / `pipeline_stage_id`.

**`get_view` is the ground truth for filter shapes.** When you need a constraint type that is not in the table above, build it once in the UI and read it back — do not extrapolate from a type that looks similar.

---

## Still open

0. ~~Status filter shape~~ **Captured 2026-11-06**: `field: "pipeline_stage_id"`, kind `status` in `set_view_filters`.
1. Constraint shapes for the remaining attribute types (record-reference, date, number, currency, checkbox). Capture each.
2. **Filtering a view on a `pipeline` (status) attribute.** `select_option_id` is refused for these ("not valid for this attribute type"); `pipeline_stage_id` is the likely constraint field, by analogy with the `attio-pipeline` value node, but it is **unverified**. Build one in the UI and `get_view` it before adding a `pipeline` kind to `set_view_filters`.
3. `entity-view-sorts` write shape. `GET` is verified; the `PUT` body has not been captured.
4. Kanban card aggregations (sum/avg on currency or number). Only `count_not_empty` has been captured; set one in the UI and read it back before exposing it.
5. Layout element **reordering and retitling** — possible today only through `set_layout` by hand. `custom-form` (Quick Add) layouts are readable but untested for writes.
6. `relationship-tab` creation. The shape is documented from capture but has not been exercised here.
7. Whether the `404` once seen on list view creation (§5) can be reproduced at all. Not a standing limit; cause unknown.

Closed since the last revision: list view creation (§5, works), the full colour palette (§6, twelve names, enumerated), and whether status attributes share the `select-options` route (§6, they do not — `pipeline-stages`).
