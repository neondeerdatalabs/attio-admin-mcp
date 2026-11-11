# Formula attributes

Attio's public API can't create, read or edit formula attributes. These four tools do it through the internal API, with shapes captured from the Attio UI and from 12 saved formulas (see `docs/captures/formula-attributes-2026-11-11.md`). Formula attributes need a Pro, Enterprise or Ultra plan.

| Tool | What it does |
|---|---|
| `get_formula` | Reads a formula in readable form, plus the raw stored shape, and samples computed values on records |
| `create_formula_attribute` | Creates one. `dry_run` compiles and resolves every reference without writing |
| `update_formula` | Changes the formula, output type, title or description. A new output type clears existing values |
| `generate_formula` | Asks Attio's own formula AI to write or fix a formula from a prompt. Writes nothing |

## Readable syntax

| You write | Meaning |
|---|---|
| `{Deal value}` | Attribute on this object, by title or api_slug |
| `{Associated company > Name}` | Follow a record reference to another object |
| `{Deal stage: Negotiation}` | One specific stage or select option, by title |
| `timeSpentIn({Deal stage}, {Deal stage}, "days")` | The **current** stage: the status attribute itself, twice |

Everything else is Attio's formula language: `if`, `and`, `or`, `??`/`ifNull`, `dateDiff`, `dateAdd`, `today`, `now`, `timeSpentIn`, `valueSetAt`, `hasBeenIn`, `previousValue`, `count`, `sum`, `round`, `text`, `number`, `currency` and so on. Braces inside a "string" are left alone.

## How it is stored

`plaintext` holds the formula with each reference replaced by `_`. Each annotation binds one `_` by `start_position`/`length`:

- `entity-variable`: an attribute `path` (one hop per object) and the `field` it reads. Field by attribute type: status `pipeline_stage_id`, select `select_option_id`, currency `raw_value`, text/number/date `value`, timestamp `null`. Other types haven't been observed; the tool uses `null` and warns.
- `pipeline-stage` / `select-option`: one specific stage or option id.

Create is `PUT attribute-definitions/{new id}` with `formula_configuration {formula_attribute_snapshot_id, plaintext, annotations, output_type_override}`. Edit is `PATCH` with a new snapshot id. Read is `GET …/formula-attribute-snapshots/{active_snapshot_id}`. Archive is `PATCH {is_archived: true}`.

## Checks

- Attio rejects syntax errors (`FORMULA_HAS_ERRORS`) and unknown functions or bad arguments (`FORMULA_TYPECHECK_FAILED`) on save. The tools translate those into plain errors.
- Attio does **not** check the output type. A text formula saved as number saves fine and errors on every record. So create and update sample up to 10 records afterwards (`check_records`) and report `errored`.
- Every save is read back and compared (`readback_matches`).

## Limits

- Output types written: number, currency, text, date, checkbox (the ones seen in saved formulas).
- Number decimal places and currency display options use Attio's defaults.
- Objects only; list-entry formulas aren't covered.
- Formulas reference other formulas up to three deep (an Attio limit).
