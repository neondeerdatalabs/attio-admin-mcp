# Reports and dashboards

Four tools: `list_dashboards`, `get_dashboard`, `preview_report`, `create_dashboard`. The builder is a port of Erik Wood's `build_dashboard.py` (Neon Deer attio toolkit), which was proven on a live client workspace: 4 dashboards, 36 reports, every preview matched an independent recount. Port verified 2026-11-06 in neon-deer-data-labs: 7 report shapes previewed and matched, one 2-report dashboard created live, every write read back, re-run made 0 writes.

## How a report is checked

1. The spec is compiled into Attio's dataset query and its saved-report body.
2. `POST /api/common/reporting/workspaces/{ws}/entity-definitions/{source}/reporting/dataset` returns Attio's own numbers (read-only).
3. The same records are pulled through the public API (`/v2/{objects|lists}/.../query`), filtered and bucketed locally.
4. The two are compared group by group. `create_dashboard` with `live: true` saves a report only if they match, or if the report carries an explicit `accept_difference` note.

Both credentials must resolve to the target workspace before anything is written: the public key's `/v2/self`, and the cookie's read of an object.

## Writes (create-only)

| Route | Creates |
|---|---|
| `PUT /reporting-dashboards/{new id}` | dashboard (once per spec dashboard) |
| `POST /entity-definitions/{source}/entity-filters/{new id}` | saved filter |
| `PUT /reports/{new id}` | report |
| `PUT /reporting-dashboards/{dash}/cells/{new id}` | dashboard cell |

Writes are refused on any ID this run did not mint. Every create is appended to `~/.attio-admin-ledgers/<workspace>/<spec_id>.jsonl` immediately; re-running a spec skips what the ledger already holds, and checks those reports' saved relative-date filters still match the spec. There is no delete: remove test dashboards in the Attio UI.

## Spec

```json
{
  "spec_id": "client-reporting-v1",
  "timezone": "America/Chicago",
  "dashboards": [
    {
      "key": "pipeline", "title": "Pipeline", "description": "optional",
      "reports": [
        { "key": "by_stage", "title": "Deals by stage", "source": {"object": "deals"},
          "group": {"attr": "stage"}, "width": 6 },
        { "key": "monthly", "title": "Deals created per month, open, last 12 months",
          "source": {"object": "deals"}, "group": {"attr": "created_at"}, "resolution": "month",
          "segment": {"attr": "stage"},
          "filters": [ {"attr": "stage", "op": "is_not", "value": "Lost"},
                       {"attr": "created_at", "op": "after_relative", "days_ago": 365} ] }
      ]
    }
  ]
}
```

- `type`: `insights` (default) or `stage-changed`. Funnel, historical-values and time-in-stage reports are researched but not built.
- `source`: `{"object": slug}` or `{"list": slug}`.
- `group` / `segment`: `{attr, via?, include_empty?}`. `via` follows single-target record references, e.g. group People by their company's industry.
- `resolution`: `day`, `week`, `month`, `quarter`, `year` (date/timestamp grouping).
- Filter ops: `is` / `is_not` (select or status, by option **title**), `empty` / `not_empty`, `after` / `before` (`YYYY-MM-DD`), `after_relative` / `before_relative` (`days_ago` / `days_from_now`, or a UI preset), `in_list` / `not_in_list` (single-target record reference; `value` = list slug), `is_true` / `is_false` (checkbox).
- `stage-changed` reports take `status_attr` and optional `stages`; their recount needs status history per record, so they are created only when `external_oracle.expected_rows` is pinned in the spec, or with `accept_difference`.

## Limits worth knowing

- **Relative dates must be a shape the UI can label.** A duration like `-P1Y0M0DT0H0M0S` saves and evaluates, but the UI shows "Unsupported relative date" and cannot edit it, so it is refused at compile. Use `days_ago: 365`.
- **"Is false" on a checkbox** is sent as must-not "is true", which also counts never-set checkboxes; the dataset rejects `eq false`.
- Grouping on checkbox, number and text uses field names that are untested guesses. That is exactly why nothing is saved unless the preview matches the recount.
- Not ported: the original's `--repair-filters` mode.
