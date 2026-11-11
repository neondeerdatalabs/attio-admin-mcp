# Formula attribute capture (test workspace, 2026-11-11)

UI demo by Nick, recorded in Playwright. Deals object `fa0bf682-…`.

## Create
`PUT /entity-definitions/{object}/attribute-definitions/{new uuid}` (client mints the id, like views).

```json
{"title":"ZZ-SELFTEST weighted","description":"","type":"number",
 "number_configuration":{"default_groups":"default","default_decimal_places":null},
 "sort_order":"…","is_historic":false,"is_required":false,"is_unique":false,"is_multiselect":false,
 "formula_configuration":{
   "formula_attribute_snapshot_id":"<new uuid>",
   "plaintext":"_*0.5",
   "annotations":[{"type":"entity-variable","start_position":0,"length":1,
     "path":[{"entity_definition_id":"<deals>","attribute_definition_id":"<deal value>"}],
     "field":"raw_value","fallback_value":null}],
   "output_type_override":null}}
```

- `plaintext` holds the formula with each reference replaced by a placeholder; each annotation covers `start_position`/`length` in that string. Saved formulas use `_` (length 1). AI output uses `$1`, `$2` (length 2).
- `type` = the detected output type (`number`, `text`, …). `number_configuration` sent for number output.
- Annotation kinds seen:
  - `entity-variable`: `path` (list of {entity_definition_id, attribute_definition_id}), `field` (`raw_value` for currency Deal value, `value` for a date, `pipeline_stage_id` for a status), `fallback_value`.
  - `pipeline-stage`: `entity_definition_id`, `attribute_definition_id`, `pipeline_stage_id`.
- Status example: `if(timeSpentIn(_, _, "days") > 14, "Stale", "Active")`: first `_` is the stage attribute (entity-variable, field pipeline_stage_id), second `_` is one specific stage (pipeline-stage). The AI "fix" swapped the typed `current` for a specific stage.

## Read back
`GET …/attribute-definitions/{id}` returns `formula_configuration: {active_snapshot_id, active_snapshot_created_at, disabled_by}`. No plaintext. The UI made no snapshot read during the demo: read endpoint NOT yet captured.

## AI composer (Attio's own)
`PUT /entity-definitions/{object}/formula-generation-requests/{new uuid}` body
`{"type":"generate"|"fix","prompt":…,"selection_start_from":null,"selection_start_to":null,"input_formula_draft":null|{plaintext,annotations}}`,
then poll `GET` same path until `status:"completed"`; result in `output_plaintext` + `output_annotations` (+ `refusal_message`).

## Not yet captured
Edit of an existing formula, read of a saved formula, non-null `output_type_override` (e.g. currency), relationship path (`{Associated company > …}`), the literal `current` keyword, select-option references.

## Second demo + probes (same day)
- Read: `GET …/attribute-definitions/{id}/formula-attribute-snapshots/{active_snapshot_id}` → `formula_plaintext`, `formula_annotations`, `output_type_override`, `grammar_version` ("0.0.1").
- Edit: `PATCH …/attribute-definitions/{id}` with `title, is_multiselect, description, type, <type>_configuration, default_value, formula_configuration{new snapshot id, plaintext, annotations, output_type_override}`. Currency edit sent `output_type_override:"currency"` and `currency_configuration {default_currency_code:"USD", default_display_type:"code", default_decimal_places:"two-decimals", default_groups:"default"}`.
- Path: `{Associated company > Name}` = one entity-variable whose `path` has two hops (deals.associated_company, companies.name), field `value`.
- Current stage: the stage attribute as a second entity-variable (`timeSpentIn(_, _, …)` both on Deal stage). Confirmed by Neon Deer "Stage Age" and a client formula; a `pipeline-stage` annotation means one fixed stage.
- Probes: syntax error → 400 FORMULA_HAS_ERRORS; misplaced annotation → same; unknown function → 400 FORMULA_TYPECHECK_FAILED; text formula saved as number → 200 but every record `last_execution_status:"error"`; currency referenced with field null → per-record errors.
- Values: `POST …/attribute-definitions/{id}/values {entity_instance_ids:[…]}` → per record `{state, value:{values:[…], entity_annotation:{formula:{last_execution_status}}}}`.
- Record ids: `POST /api/common/particle/workspaces/{ws}/entity-definitions/{obj}/entity-instances/mrl {filter:null, sorts:[], initialRange:{start, size}}` (filter `{and:[]}` returns zero).
- Harvest of 12 saved formulas (tools/harvest-formulas.js): output types number/currency/date/checkbox/text; select-option annotation `{type, entity_definition_id, attribute_definition_id, select_option_id}`.
