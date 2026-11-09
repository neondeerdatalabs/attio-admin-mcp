'use strict';
/**
 * Reports and dashboards for attio-admin-mcp.
 *
 * Ported from Erik Wood's build_dashboard.py (Neon Deer attio toolkit, 2026-11-06
 * snapshot), which was proven live on a client workspace: 4 dashboards, 36 reports,
 * every preview matched an independent recount. Behaviour is kept 1:1 except that
 * the --repair-filters mode is not ported.
 *
 * Pipeline per report:
 *   compile spec -> POST reporting/dataset (Attio's own read-only preview)
 *               -> recount the same thing through the PUBLIC API ("oracle")
 *               -> compare group by group
 * create_dashboard with live:true then saves ONLY reports whose preview matched
 * (or that carry an explicit accept_difference note), and reads every write back.
 *
 * Safety, as in the original:
 *   - create-only. Nothing is PATCHed or deleted.
 *   - writes are allowed only on IDs minted by this run, or recorded in this
 *     spec's ledger, and only on five known create routes.
 *   - before any write, the public key AND the session cookie must both resolve
 *     to the target workspace.
 *   - every create is appended to a ledger immediately, so a partial run resumes
 *     without duplicates.
 *
 * Grouping/filter field names per attribute type are the original's: select,
 * status, record-reference, actor-reference and date were read back from
 * UI-made reports; checkbox/number/text grouping are UNTESTED guesses, which is
 * exactly why nothing is saved unless the preview matches the recount.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const APP = 'https://app.attio.com';
const ACTIVE = { field: 'active_until', operator: 'empty', value: 'null' };
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LEDGER_DIR = path.join(os.homedir(), '.attio-admin-ledgers');

const GROUP_FIELD = {
  select: 'select_option_id', status: 'pipeline_stage_id',
  'record-reference': 'qualified_target_entity_instance_id',
  'actor-reference': 'qualified_referenced_actor_id',
  date: 'value', timestamp: 'value', checkbox: 'value', number: 'value', text: 'value',
};
const FILTER_FIELD = { select: 'select_option_id', status: 'pipeline_stage_id' };

class BuildError extends Error {}

// ------------------------------------------------------------------ dates
// Relative-date values the report filter UI can express and label. Anything else
// saves and evaluates fine but the UI shows "Unsupported relative date" and
// cannot edit it, so only these shapes are allowed (captured 2026-10-19).
const RELATIVE_PRESETS = {
  'P0Y0M0DT0H0M0S': 'Today',
  'P0Y0M1DT0H0M0S': 'Tomorrow',
  '-P0Y0M1DT0H0M0S': 'Yesterday',
  '-P0Y0M7DT0H0M0S': 'One week ago',
  'P0Y0M7DT0H0M0S': 'One week from now',
  '-P0Y1M0DT0H0M0S': 'One month ago',
  'P0Y1M0DT0H0M0S': 'One month from now',
};
const DAYS_FORM = /^(-?)P0Y0M(\d+)DT0H0M0S$/;

function relativeLabel(value) {
  if (Object.prototype.hasOwnProperty.call(RELATIVE_PRESETS, value)) return RELATIVE_PRESETS[value];
  const m = DAYS_FORM.exec(value || '');
  if (m) return `${m[2]} days ${m[1] ? 'ago' : 'from now'}`;
  return null;
}

function relativeValue(f) {
  let value;
  if ('days_ago' in f || 'days_from_now' in f) {
    const n = parseInt('days_ago' in f ? f.days_ago : f.days_from_now, 10);
    if (!(n >= 0)) throw new BuildError('days_ago/days_from_now must be >= 0');
    value = `${'days_ago' in f ? '-' : ''}P0Y0M${n}DT0H0M0S`;
  } else {
    value = f.value;
  }
  if (relativeLabel(value) === null) {
    throw new BuildError(`relative date ${JSON.stringify(value)} is not a UI-supported encoding (the Attio UI ` +
      `would show "Unsupported relative date"); use days_ago, e.g. 365 for "last 12 months", or one of ` +
      `${Object.keys(RELATIVE_PRESETS).sort().join(', ')}`);
  }
  return value;
}

/** YYYY-MM-DD of `date` in time zone `tz`. */
function localDate(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date);
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const ymd = (y, m, d) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Local calendar date the UI resolves a dynamic duration to (offset applied to today in `tz`). */
function resolveRelative(value, tz, now) {
  const m = /^(-?)P(\d+)Y(\d+)M(\d+)DT0H0M0S$/.exec(value);
  if (!m) throw new BuildError(`unsupported relative duration ${value}`);
  const sign = m[1] ? -1 : 1;
  const [yy, mo, dd] = [m[2], m[3], m[4]].map((x) => sign * parseInt(x, 10));
  const [ly, lm, ld] = localDate(now, tz).split('-').map(Number);
  let month = lm + mo;
  const year = ly + yy + Math.floor((month - 1) / 12);
  month = ((month - 1) % 12 + 12) % 12 + 1;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return addDays(ymd(year, month, Math.min(ld, dim)), dd);
}

function bucket(iso, resolution) {
  const [y, m] = iso.split('-').map(Number);
  if (resolution === 'quarter') return ymd(y, 3 * Math.floor((m - 1) / 3) + 1, 1);
  if (resolution === 'month') return ymd(y, m, 1);
  if (resolution === 'year') return ymd(y, 1, 1);
  if (resolution === 'week') {
    const [yy, mm, dd] = iso.split('-').map(Number);
    const wd = (new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay() + 6) % 7; // Monday = 0
    return addDays(iso, -wd);
  }
  return iso;
}

// ------------------------------------------------------------ transport
function makeTransport({ ctx, key, raw, ROOT }) {
  const t = {
    slug: ctx.slug, wid: null, verified: false, minted: new Set(), writes: [], ctx,
    redact(s) { let x = String(s); for (const sec of [key, ctx.cookie]) if (sec) x = x.split(sec).join('[REDACTED]'); return x; },

    async pub(method, p, body) {
      if (method !== 'GET' && !/\/(records|entries)\/query$/.test(p)) throw new BuildError('public transport is read-only');
      const res = await fetch(`https://api.attio.com${p}`, {
        method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      if (!res.ok) throw new BuildError(`public ${method} ${p} -> ${res.status}: ${t.redact(text.slice(0, 400))}`);
      return JSON.parse(text);
    },

    /** Internal call returning [status, data] instead of throwing, like the original. */
    async internal(method, url, body) {
      try {
        const data = await raw(url, { method, body, cookie: ctx.cookie });
        return [200, data];
      } catch (e) {
        const m = /HTTP (\d{3})/.exec(e.message);
        return [m ? Number(m[1]) : 0, { error: t.redact(e.message.slice(0, 600)) }];
      }
    },

    async read(p, body) {
      const okPosts = ['/reporting/dataset', '/reports/batch-get-reports'];
      if (body !== undefined && !okPosts.some((s) => p.endsWith(s))) throw new BuildError('not a known read route');
      if (!t.verified) throw new BuildError('verify workspace first');
      const url = p.startsWith('/reporting/') ? `${ROOT}${p}` : `${ROOT}/workspaces/${t.slug}${p}`;
      return t.internal(body !== undefined ? 'POST' : 'GET', url, body);
    },

    /** Create-only writes on freshly minted (or ledger-owned) IDs. */
    async write(method, p, body) {
      const allowed = [
        ['PUT', new RegExp(`^/reporting-dashboards/(${UUID})$`)],
        ['PUT', new RegExp(`^/reporting-dashboards/(${UUID})/cells/(${UUID})$`)],
        ['PUT', new RegExp(`^/reports/(${UUID})$`)],
        ['POST', new RegExp(`^/entity-definitions/${UUID}/entity-filters/(${UUID})$`)],
      ];
      let ok = false;
      for (const [m, re] of allowed) {
        const hit = re.exec(p);
        if (m === method && hit) {
          if (!hit.slice(1).every((g) => t.minted.has(g))) throw new BuildError(`refusing write on an ID not minted/owned by this run: ${p}`);
          ok = true; break;
        }
      }
      if (!ok) throw new BuildError(`write route not allowed: ${method} ${p}`);
      if (!t.verified) throw new BuildError('verify workspace first');
      const r = await t.internal(method, `${ROOT}/workspaces/${t.slug}${p}`, body);
      t.writes.push({ method, path: p, status: r[0] });
      return r;
    },

    async verify() {
      const me = await t.pub('GET', '/v2/self');
      if (me.workspace_slug !== t.slug) {
        throw new BuildError(`the API key belongs to "${me.workspace_slug}", not "${t.slug}". Pass api_key, or save ` +
          `the right key to ~/.attio-apikey-${t.slug}.`);
      }
      t.wid = me.workspace_id;
      const objs = (await t.pub('GET', '/v2/objects')).data;
      const probe = objs[0].id.object_id;
      const [st, d] = await t.internal('GET', `${ROOT}/workspaces/${t.slug}/entity-definitions/${probe}`);
      const dv = d && d.value !== undefined ? d.value : d;
      if (st !== 200 || (dv && dv.workspace_id) !== t.wid) {
        throw new BuildError(`session cookie does not resolve to ${t.slug} (status ${st})`);
      }
      t.verified = true;
      return { workspace_slug: t.slug, workspace_id: t.wid, public_key: 'ok', session_cookie: 'ok' };
    },
  };
  return t;
}

// ------------------------------------------------------------- bindings
async function makeBindings(t) {
  const objects = {}; const lists = {};
  for (const o of (await t.pub('GET', '/v2/objects')).data) objects[o.api_slug] = o;
  for (const l of (await t.pub('GET', '/v2/lists')).data) lists[l.api_slug] = l;
  const attrsCache = new Map(); const optsCache = new Map();
  const b = {
    t, objects, lists,
    source(src) {
      if (src.object) {
        const o = objects[src.object];
        if (!o) throw new BuildError(`no object "${src.object}". Available: ${Object.keys(objects).join(', ')}`);
        return { kind: 'objects', slug: src.object, id: o.id.object_id };
      }
      const l = lists[src.list];
      if (!l) throw new BuildError(`no list "${src.list}". Available: ${Object.keys(lists).join(', ')}`);
      return { kind: 'lists', slug: src.list, id: l.id.list_id };
    },
    async attr(source, slug) {
      const k = `${source.kind}/${source.slug}`;
      if (!attrsCache.has(k)) {
        const data = (await t.pub('GET', `/v2/${source.kind}/${source.slug}/attributes`)).data;
        attrsCache.set(k, Object.fromEntries(data.filter((a) => !a.is_archived).map((a) => [a.api_slug, a])));
      }
      const a = attrsCache.get(k)[slug];
      if (!a) throw new BuildError(`attribute ${slug} not found on ${source.slug} (no new fields are created)`);
      let target = (((a.config || {}).record_reference || {}).allowed_object_ids) || [];
      if (!target.length && a.relationship) target = [a.relationship.id.object_id];
      return { slug, id: a.id.attribute_id, type: a.type, multi: a.is_multiselect, title: a.title, targets: target };
    },
    async listEntriesAttr(objectId) {
      const [st, data] = await t.read(`/entity-definitions/${objectId}/attribute-definitions`);
      const rows = st === 200 ? (data.value !== undefined ? data.value : data) : [];
      const hit = (rows || []).find((r) => r.api_slug === 'list_entries');
      if (!hit) throw new BuildError(`list_entries attribute not found on ${objectId} (status ${st})`);
      return hit.attribute_definition_id;
    },
    async optionId(source, attr, title) {
      const k = `${source.kind}/${source.slug}/${attr.slug}`;
      if (!optsCache.has(k)) {
        const ep = attr.type === 'select' ? 'options' : 'statuses';
        const idk = ep === 'options' ? 'option_id' : 'status_id';
        const data = (await t.pub('GET', `/v2/${source.kind}/${source.slug}/attributes/${attr.slug}/${ep}`)).data;
        optsCache.set(k, Object.fromEntries(data.filter((o) => !o.is_archived).map((o) => [o.title, o.id[idk]])));
      }
      const opts = optsCache.get(k);
      if (!(title in opts)) throw new BuildError(`option ${JSON.stringify(title)} not found on ${attr.slug}. Options: ${Object.keys(opts).join(', ')}`);
      return opts[title];
    },
  };
  return b;
}

// --------------------------------------------------------------- oracle
async function pull(t, cache, source, prefilter) {
  const k = `${source.kind}/${source.slug}/${JSON.stringify(prefilter || null)}`;
  if (cache.has(k)) return cache.get(k);
  const url = `/v2/${source.kind}/${source.slug}/${source.kind === 'objects' ? 'records/query' : 'entries/query'}`;
  const rows = []; let offset = 0;
  for (;;) {
    const body = { limit: 500, offset };
    if (prefilter) body.filter = prefilter;
    const data = (await t.pub('POST', url, body)).data;
    rows.push(...data);
    if (data.length < 500) { cache.set(k, rows); return rows; }
    offset += 500;
  }
}

function valuesOf(row, a, tz) {
  let vals = ((row.values || row.entry_values || {})[a.slug]) || [];
  if (a.slug === 'created_at' && !vals.length && row.created_at) vals = [{ value: row.created_at }];
  return vals.map((v) => {
    switch (a.type) {
      case 'select': return v.option.id.option_id;
      case 'status': return v.status.id.status_id;
      case 'record-reference': return v.target_record_id;
      case 'date': return String(v.value).slice(0, 10);
      case 'timestamp': return localDate(new Date(v.value), tz);
      case 'checkbox': return Boolean(v.value);
      case 'actor-reference': return v.referenced_actor_id;
      default: return v.value;
    }
  });
}

async function groupedValues(t, cache, row, a, tz) {
  let rows = [row];
  for (const [ref, target] of a.hops || []) {
    const recs = new Map((await pull(t, cache, target)).map((x) => [x.id.record_id, x]));
    rows = rows.flatMap((r0) => valuesOf(r0, ref, tz).filter((i) => recs.has(i)).map((i) => recs.get(i)));
  }
  const out = [];
  for (const r0 of rows) for (const v of valuesOf(r0, a, tz)) if (!out.includes(v)) out.push(v);
  return out;
}

const K = (g, s) => JSON.stringify([g === undefined ? null : g, s === undefined ? null : s]);

// --------------------------------------------------------------- compile
async function compileFilter(f, source, b, tz, now, cache) {
  const a = await b.attr(source, f.attr);
  let p = [{ entity_definition_id: source.id, attribute_definition_id: a.id }];
  const op = f.op;
  let cons; let mode; let pred;
  if (op === 'is' || op === 'is_not') {
    if (!FILTER_FIELD[a.type]) throw new BuildError(`op ${op} only supported for select/status here, not ${a.type}`);
    const vid = await b.optionId(source, a, f.value);
    cons = [{ field: FILTER_FIELD[a.type], operator: 'eq', value: vid }];
    mode = op === 'is' ? 'must' : 'must-not';
    const neg = op === 'is_not';
    pred = (vals) => vals.includes(vid) !== neg;
  } else if (op === 'empty' || op === 'not_empty') {
    cons = []; mode = op === 'empty' ? 'must-not' : 'must';
    const e = op === 'empty';
    pred = (vals) => (vals.length === 0) === e;
  } else if (op === 'after_relative' || op === 'before_relative') {
    if (!['date', 'timestamp'].includes(a.type)) throw new BuildError('relative date filters need a date/timestamp attribute');
    const saved = relativeValue(f);
    const cutoff = resolveRelative(saved, tz, now);
    const operator = op === 'after_relative' ? 'gt' : 'lt';
    cons = [{ field: 'value', operator, value: cutoff, _saved_value: saved, _dynamic: true }];
    mode = 'must';
    pred = (vals) => vals.some((v) => (operator === 'gt' ? v > cutoff : v < cutoff));
  } else if (op === 'after' || op === 'before') {
    if (!['date', 'timestamp'].includes(a.type)) throw new BuildError('date filters need a date/timestamp attribute');
    const cutoff = String(f.value).slice(0, 10);
    const operator = op === 'after' ? 'gt' : 'lt';
    cons = [{ field: 'value', operator, value: cutoff }];
    mode = 'must';
    pred = (vals) => vals.some((v) => (operator === 'gt' ? v > cutoff : v < cutoff));
  } else if (op === 'in_list' || op === 'not_in_list') {
    // Related record is on a list (UI-captured 2026-10-19: Company > List entries contains <list>).
    if (a.type !== 'record-reference' || a.targets.length !== 1) throw new BuildError('in_list needs a single-target record-reference attribute');
    const target = a.targets[0];
    const lst = b.lists[f.value];
    if (!lst) throw new BuildError(`no list "${f.value}"`);
    p = p.concat([{ entity_definition_id: target, attribute_definition_id: await b.listEntriesAttr(target) }]);
    cons = [{ field: 'target_entity_definition_id', operator: 'eq', value: lst.id.list_id }];
    mode = op === 'in_list' ? 'must' : 'must-not';
    const members = new Set((await pull(b.t, cache, { kind: 'lists', slug: f.value })).map((e) => e.parent_record_id));
    const neg = op === 'not_in_list';
    pred = (vals) => vals.some((v) => members.has(v)) !== neg;
  } else if (op === 'is_true' || op === 'is_false') {
    if (a.type !== 'checkbox') throw new BuildError('is_true/is_false need a checkbox attribute');
    const want = op === 'is_true';
    // The dataset rejects `eq false` (400 "Invalid value type"); "is false" is sent as
    // must-not eq true, which also counts never-set checkboxes.
    cons = [{ field: 'value', operator: 'eq', value: true }];
    mode = want ? 'must' : 'must-not';
    pred = (vals) => (vals.length ? vals.includes(want) : want === false);
  } else {
    throw new BuildError(`unsupported filter op ${op}`);
  }
  const strip = (c) => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('_')));
  const dsCons = cons.map(strip).concat([{ ...ACTIVE }]);
  const savedCons = cons.map((c) => {
    let value = c._dynamic ? c._saved_value : c.value;
    if (typeof value === 'boolean') value = value ? 'true' : 'false';
    return { field: c.field, operator: c.operator, value, value_type: c._dynamic ? 'dynamic' : 'static' };
  }).concat([{ ...ACTIVE, value_type: 'static' }]);
  return {
    clause: { path: p, mode, constraints: dsCons },
    leaf: { filter_mode: mode, filter_path: p, constraints: savedCons },
    attr: a, pred,
  };
}

async function groupingHops(g, source, b) {
  const steps = []; const hops = []; let cur = source;
  const byId = Object.fromEntries(Object.entries(b.objects).map(([slug, o]) => [o.id.object_id, slug]));
  for (const slug of g.via || []) {
    const ref = await b.attr(cur, slug);
    if (ref.type !== 'record-reference' || ref.targets.length !== 1 || !byId[ref.targets[0]]) {
      throw new BuildError(`via ${slug} needs a single-target record-reference to an object`);
    }
    steps.push({ entity_definition_id: cur.id, attribute_definition_id: ref.id });
    cur = { kind: 'objects', slug: byId[ref.targets[0]], id: ref.targets[0] };
    hops.push([ref, cur]);
  }
  return { steps, final: cur, hops };
}

async function compileGrouping(g, source, b, savedPrimary) {
  const { steps, final, hops } = await groupingHops(g, source, b);
  const a = { ...(await b.attr(final, g.attr)), hops };
  if (!GROUP_FIELD[a.type]) throw new BuildError(`grouping on ${a.type} (${a.slug}) is not supported by this builder yet`);
  const field = GROUP_FIELD[a.type];
  const p = steps.concat([{ entity_definition_id: final.id, attribute_definition_id: a.id }]);
  const includeNull = g.include_empty !== undefined ? g.include_empty : true;
  const ds = { path: p, field, include_null_group: includeNull, selected_values: null };
  const saved = { attribute_path: p, field, selected_values: null, null_group_visible: includeNull };
  if (savedPrimary) {
    ds.time_domain = null;
    Object.assign(saved, { empty_groups_visible: false, selected_pipeline_stage_ids: [] });
  }
  return { a, ds, saved };
}

async function compileReport(r, b, tz, now, cache) {
  const source = b.source(r.source || {});
  const filters = [];
  for (const f of r.filters || []) filters.push(await compileFilter(f, source, b, tz, now, cache));
  const clauses = filters.map((f) => f.clause);
  const dsFilter = !clauses.length ? null : clauses.length === 1 ? clauses[0] : { and: clauses };
  const resolution = r.resolution || 'month';
  const rtype = r.type || 'insights';
  const out = { source, filters, type: rtype };
  let dataset; let saved;
  if (rtype === 'insights') {
    let prim = null; let sec = null; let savedPrim = null; let savedSec = null; let timeCfg = null;
    if (r.group) {
      const g = await compileGrouping(r.group, source, b, true);
      prim = g.ds; savedPrim = g.saved; out.group_attr = g.a;
      if (['date', 'timestamp'].includes(g.a.type)) timeCfg = { time_resolution: resolution, tz, start_date: null, end_date: null };
    }
    if (r.segment) {
      const g = await compileGrouping(r.segment, source, b, false);
      sec = g.ds; savedSec = g.saved; out.segment_attr = g.a;
      if (['date', 'timestamp'].includes(g.a.type)) timeCfg = { time_resolution: resolution, tz, start_date: null, end_date: null };
    }
    dataset = { type: 'pivot', filter: dsFilter, time_config: timeCfg,
      metric: { type: 'record-count', time_domain: null }, primary_grouping: prim, secondary_grouping: sec };
    saved = { entity_definition_id: source.id, entity_filter_id: null, title: r.title, description: r.description || null,
      report_type: 'insights', visualisation_type: r.visualisation || 'bar',
      primary_grouping: savedPrim, secondary_grouping: savedSec,
      primary_metric: { attribute_path: null, field: null, aggregation: 'count' },
      single_metric_decimal_places: null, map_display_type: null, map_fit_bounds: null,
      target_value: r.target !== undefined ? r.target : null, axis_label_visible: true, zeros_visible: true,
      bar_segments_stacked: r.stacked !== undefined ? r.stacked : true, sort_preference: r.sort || null,
      time_config: { resolution, duration: r.duration || null, comparison: null } };
  } else if (rtype === 'stage-changed') {
    const a = await b.attr(source, r.status_attr);
    if (a.type !== 'status') throw new BuildError('stage-changed needs a status attribute');
    let stageIds = null;
    if (r.stages) { stageIds = []; for (const s of r.stages) stageIds.push(await b.optionId(source, a, s)); }
    const p = [{ entity_definition_id: source.id, attribute_definition_id: a.id }];
    out.group_attr = a; out.stage_ids = stageIds;
    dataset = { type: 'pivot', filter: dsFilter,
      time_config: { time_resolution: resolution, tz, start_date: null, end_date: null },
      metric: { type: 'record-count', time_domain: null },
      primary_grouping: { path: p, field: 'pipeline_stage_id', time_domain: 'discrete', selected_values: stageIds, include_null_group: false },
      secondary_grouping: null };
    saved = { entity_definition_id: source.id, entity_filter_id: null, title: r.title, description: r.description || null,
      report_type: 'stage-changed', visualisation_type: r.visualisation || 'bar',
      primary_metric: { attribute_path: null, field: null, aggregation: 'count' },
      status_attribute_path: p, selected_stage_ids: stageIds,
      target_value: null, axis_label_visible: true, bar_segments_stacked: true,
      time_config: { resolution, duration: null, comparison: null } };
  } else {
    throw new BuildError(`unsupported report type ${rtype} (supported: insights, stage-changed)`);
  }
  out.dataset = dataset; out.saved = saved;
  return out;
}

function savedFilterBody(compiled, filterId, wid) {
  const leaves = compiled.filters.map((f) => f.leaf);
  if (!leaves.length) return null;
  const now = new Date().toISOString();
  const ent = compiled.source.id;
  const block = (parent, sort, kw) => ({ workspace_id: wid, entity_definition_id: ent, entity_filter_id: filterId,
    entity_filter_block_id: crypto.randomUUID(), parent_entity_filter_block_id: parent, sort_order: sort,
    created_at: now, accurate_at: now, ...kw });
  const blocks = []; let parent = null;
  if (leaves.length > 1) {
    const root = block(null, 'h0000', { block_type: 'group', group_mode: 'and' });
    blocks.push(root); parent = root.entity_filter_block_id;
  }
  leaves.forEach((leaf, i) => {
    blocks.push(block(parent, `h${pad(i + 1, 4)}`, { block_type: 'filter', filter_mode: leaf.filter_mode,
      filter_path: leaf.filter_path.map((x) => ({ ...x, workspace_id: wid })), constraints: leaf.constraints }));
  });
  return { parent_type: 'entity-report', blocks };
}

async function oracle(t, cache, compiled, r, tz) {
  const rows = await pull(t, cache, compiled.source, r.oracle_prefilter);
  const keep = rows.filter((row) => compiled.filters.every((f) => f.pred(valuesOf(row, f.attr, tz))));
  if (compiled.type === 'stage-changed') return { counts: null, pulled: rows.length, kept: keep.length };
  const res = r.resolution || 'month';
  const counts = new Map();
  const ga = compiled.group_attr; const sa = compiled.segment_attr;
  for (const row of keep) {
    let gk = [null];
    if (ga) {
      let gv = await groupedValues(t, cache, row, ga, tz);
      if (['date', 'timestamp'].includes(ga.type)) gv = gv.map((v) => bucket(v, res));
      gk = gv.length ? gv : ((r.group.include_empty !== undefined ? r.group.include_empty : true) ? [null] : []);
    }
    let sk = [null];
    if (sa) {
      let sv = await groupedValues(t, cache, row, sa, tz);
      if (['date', 'timestamp'].includes(sa.type)) sv = sv.map((v) => bucket(v, res));
      sk = sv.length ? sv : ((r.segment.include_empty !== undefined ? r.segment.include_empty : true) ? [null] : []);
    }
    for (const g of gk) for (const s of sk) counts.set(K(g, s), (counts.get(K(g, s)) || 0) + 1);
  }
  return { counts, pulled: rows.length, kept: keep.length };
}

function normaliseDataset(result, compiled, tz) {
  const counts = new Map();
  const ga = compiled.group_attr; const sa = compiled.segment_attr;
  const fixTime = (v, a) => (v && a && ['date', 'timestamp', 'status'].includes(a.type) && typeof v === 'string' && v.includes('T')
    ? localDate(new Date(v), tz) : v);
  const fixRef = (v, a) => (typeof v === 'string' && a && ['record-reference', 'actor-reference'].includes(a.type) && v.includes(':')
    ? v.split(':').pop() : v);
  for (const row of result || []) {
    if (row.length === 1) { counts.set(K(null, null), (counts.get(K(null, null)) || 0) + row[0]); continue; }
    let g = row[0]; const n = row[1]; let s = row.length > 2 ? row[2] : null;
    g = fixRef(fixTime(g, ga), ga);
    if (sa && sa.type !== 'status') s = fixTime(s, sa);
    s = fixRef(s, sa);
    counts.set(K(g, s), (counts.get(K(g, s)) || 0) + n);
  }
  return counts;
}

function compare(ds, or) {
  const keys = new Set([...ds.keys(), ...or.keys()]);
  const diffs = {};
  for (const k of [...keys].sort()) {
    const a = ds.get(k) || 0; const c = or.get(k) || 0;
    if (a !== c && Object.keys(diffs).length < 25) diffs[JSON.parse(k).join('|')] = { dataset: a, oracle: c };
  }
  const sum = (m) => [...m.values()].reduce((x, y) => x + y, 0);
  return { match: !Object.keys(diffs).length, dataset_total: sum(ds), oracle_total: sum(or), groups: keys.size, differences: diffs };
}

// ----------------------------------------------------------------- ledger
function makeLedger(file, specId) {
  const rows = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
  return {
    file, rows,
    find(kind, key) { return rows.find((r) => r.spec === specId && r.kind === kind && r.key === key && r.status === 'created') || null; },
    append(row) {
      const full = { ...row, spec: specId, at: new Date().toISOString().slice(0, 19) + 'Z' };
      rows.push(full);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(full) + '\n');
      return full;
    },
  };
}

// --------------------------------------------------------- saved filters
function dynamicDateConstraints(blocks) {
  const out = [];
  for (const blk of blocks) for (const c of blk.constraints || []) {
    if (c.value_type === 'dynamic' && c.field === 'value') {
      out.push({ attribute_definition_id: blk.filter_path[blk.filter_path.length - 1].attribute_definition_id, operator: c.operator, value: c.value });
    }
  }
  return out.sort((x, y) => (x.attribute_definition_id + x.operator).localeCompare(y.attribute_definition_id + y.operator));
}

/** Saved relative-date values must match the spec AND be a UI-supported encoding. */
function checkSavedFilter(savedBlocks, compiled) {
  const saved = dynamicDateConstraints(savedBlocks);
  const expected = dynamicDateConstraints(compiled.filters.map((f) => f.leaf));
  for (const x of saved.concat(expected)) x.ui_label = relativeLabel(x.value);
  const unsupported = saved.filter((x) => x.ui_label === null);
  return { match: JSON.stringify(saved) === JSON.stringify(expected) && !unsupported.length, saved, expected, unsupported_saved: unsupported };
}

function stripMeta(v) {
  if (Array.isArray(v)) return v.map(stripMeta);
  if (v && typeof v === 'object') {
    if ('attribute_definition_id' in v) return { entity_definition_id: v.entity_definition_id, attribute_definition_id: v.attribute_definition_id };
    return Object.fromEntries(Object.entries(v).filter(([k]) => !['workspace_id', 'accurate_at', 'created_at', 'created_by'].includes(k))
      .map(([k, x]) => [k, stripMeta(x)]));
  }
  return v;
}

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x));

// ------------------------------------------------------------------ run
/**
 * Run a spec. Dry run unless live. Returns the full per-report result plus a summary.
 */
async function runSpec({ spec, ctx, key, raw, ROOT, live, only, ledgerPath }) {
  if (!spec || !Array.isArray(spec.dashboards)) throw new BuildError('spec needs a dashboards array');
  if (spec.workspace && spec.workspace.slug && spec.workspace.slug !== ctx.slug) {
    throw new BuildError(`spec is for workspace "${spec.workspace.slug}" but this call targets "${ctx.slug}"`);
  }
  const specId = spec.spec_id || 'adhoc';
  const ledger = makeLedger(ledgerPath || path.join(LEDGER_DIR, ctx.slug, `${specId}.jsonl`), specId);
  const tz = spec.timezone || 'America/Los_Angeles';
  const now = new Date();
  const t = makeTransport({ ctx, key, raw, ROOT });
  const identity = await t.verify();
  if (spec.workspace && spec.workspace.id && spec.workspace.id !== t.wid) {
    throw new BuildError(`spec workspace id ${spec.workspace.id} does not match ${ctx.slug} (${t.wid})`);
  }
  const b = await makeBindings(t);
  const cache = new Map();
  const out = { mode: live ? 'live' : 'dry-run', identity, ledger: ledger.file, evaluated_at: now.toISOString(), timezone: tz, dashboards: [] };
  const [onlyD, onlyR] = (only || '').split('/');

  for (const d of spec.dashboards) {
    if (onlyD && d.key !== onlyD) continue;
    const dashOut = { key: d.key, title: d.title, reports: [] };
    out.dashboards.push(dashOut);
    const dashRow = ledger.find('dashboard', d.key);
    let dashId = dashRow ? dashRow.id : null;
    for (const [idx, r] of (d.reports || []).entries()) {
      if (onlyR && r.key !== onlyR) continue;
      const ro = { key: r.key, title: r.title };
      dashOut.reports.push(ro);
      if (r.skip) { ro.skipped = r.skip; continue; }
      let c;
      try { c = await compileReport(r, b, tz, now, cache); } catch (e) {
        if (e instanceof BuildError) { ro.compile_error = e.message; continue; } throw e;
      }
      const [st, data] = await t.read(`/reporting/workspaces/${t.slug}/entity-definitions/${c.source.id}/reporting/dataset`, c.dataset);
      ro.dataset_status = st;
      if (st !== 200) { ro.dataset_error = t.redact(JSON.stringify(data).slice(0, 600)); ro.dataset_request = c.dataset; continue; }
      const dsv = data && data.value !== undefined && !Array.isArray(data) && data.result === undefined ? data.value : data;
      const ds = normaliseDataset(dsv.result, c, tz);
      if (c.type === 'stage-changed') {
        ro.dataset_rows = [...ds.entries()].map(([k, v]) => [JSON.parse(k)[0], v]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
        // Status history needs one public call per record, so the recount is pinned in the spec.
        const exp = (r.external_oracle || {}).expected_rows;
        ro.check = { match: exp !== undefined ? canon(ro.dataset_rows) === canon(exp) : null,
          external_oracle: r.external_oracle || null, dataset_total: [...ds.values()].reduce((x, y) => x + y, 0),
          oracle_total: exp !== undefined ? exp.reduce((x, y) => x + y[1], 0) : null };
      } else {
        const o = await oracle(t, cache, c, r, tz);
        ro.oracle_rows_pulled = o.pulled; ro.oracle_rows_matching_filters = o.kept;
        ro.check = compare(ds, o.counts);
        ro.dataset_summary = [...ds.entries()].map(([k, v]) => [...JSON.parse(k), v])
          .sort((x, y) => (String(x[0]) + String(x[1])).localeCompare(String(y[0]) + String(y[1]))).slice(0, 60);
        const dur = r.duration || {};
        if (dur.type === 'x_to_date') {
          // The UI trims an x_to_date range client-side; the dataset call stays unwindowed.
          const cur = bucket(localDate(now, tz), dur.value);
          const sumCur = (m) => [...m.entries()].filter(([k]) => JSON.parse(k)[0] === cur).reduce((x, [, v]) => x + v, 0);
          ro.current_period = { period_start: cur, dataset: sumCur(ds), oracle: sumCur(o.counts) };
        }
      }
      const ok = ro.check.match === true || Boolean(r.accept_difference);
      if (r.accept_difference) ro.accepted_difference_note = r.accept_difference;
      const done = ledger.find('report', `${d.key}/${r.key}`);
      if (done) {
        ro.already_created = { id: done.id, filter_id: done.filter_id, cell_id: done.cell_id };
        if (done.filter_id && c.filters.length) {
          const [fs2, fb] = await t.read(`/entity-definitions/${c.source.id}/entity-filters/${done.filter_id}/entity-filter-blocks`);
          ro.saved_filter_check = fs2 === 200 ? checkSavedFilter((fb && fb.value) || [], c) : { match: false, status: fs2 };
        }
        continue;
      }
      if (!live) { ro.would_create = ok; continue; }
      if (!ok) {
        ro.not_created = ro.check.match === null ? 'no oracle result pinned in the spec' : 'preview did not match the oracle';
        continue;
      }
      // ---- live create, dashboard first (once)
      if (!dashId) {
        dashId = crypto.randomUUID();
        t.minted.add(dashId);
        const [dst, dresp] = await t.write('PUT', `/reporting-dashboards/${dashId}`, { title: d.title, description: d.description || '' });
        if (dst !== 200) { ro.error = `dashboard create ${dst}: ${t.redact(JSON.stringify(dresp).slice(0, 400))}`; dashId = null; break; }
        ledger.append({ kind: 'dashboard', key: d.key, id: dashId, title: d.title, status: 'created', url: `${APP}/${t.slug}/reports/dashboard/${dashId}` });
      }
      t.minted.add(dashId);
      const body = JSON.parse(JSON.stringify(c.saved));
      let filterId = null; let fbody = null;
      if (c.filters.length) {
        filterId = crypto.randomUUID();
        t.minted.add(filterId);
        fbody = savedFilterBody(c, filterId, t.wid);
        const [fst, fresp] = await t.write('POST', `/entity-definitions/${c.source.id}/entity-filters/${filterId}`, fbody);
        if (fst !== 200) { ro.error = `filter create ${fst}: ${t.redact(JSON.stringify(fresp).slice(0, 400))}`; ro.filter_request = fbody; continue; }
        ledger.append({ kind: 'filter', key: `${d.key}/${r.key}`, id: filterId, title: r.title, status: 'created', entity_definition_id: c.source.id });
        body.entity_filter_id = filterId;
      }
      const reportId = crypto.randomUUID();
      t.minted.add(reportId);
      const [rst, rresp] = await t.write('PUT', `/reports/${reportId}`, body);
      if (rst !== 200) { ro.error = `report create ${rst}: ${t.redact(JSON.stringify(rresp).slice(0, 400))}`; ro.report_request = body; continue; }
      const cellId = crypto.randomUUID();
      t.minted.add(cellId);
      const cell = { width: r.width || 12, sort_order: r.sort_order || `m${pad(idx, 3)}`, entity_report_id: reportId };
      const [cst, cresp] = await t.write('PUT', `/reporting-dashboards/${dashId}/cells/${cellId}`, cell);
      ledger.append({ kind: 'report', key: `${d.key}/${r.key}`, id: reportId, filter_id: filterId,
        cell_id: cst === 200 ? cellId : null, dashboard_id: dashId, title: r.title, status: 'created',
        url: cst === 200 ? `${APP}/${t.slug}/reports/dashboard/${dashId}/cell/${cellId}` : null });
      if (cst !== 200) { ro.error = `cell create ${cst}: ${t.redact(JSON.stringify(cresp).slice(0, 400))}`; continue; }
      // ---- readback
      const [rs, rbRaw] = await t.read(`/reports/${reportId}`);
      const rb = rbRaw && rbRaw.value !== undefined ? rbRaw.value : rbRaw;
      const want = stripMeta(body);
      const mism = {};
      if (rs === 200) for (const k of Object.keys(want)) {
        const got = stripMeta(rb[k]);
        if (canon(got) !== canon(want[k])) mism[k] = { sent: want[k], read: got };
      }
      ro.readback = { report_status: rs, report_mismatches: mism };
      if (filterId) {
        const [fs3, fb3] = await t.read(`/entity-definitions/${c.source.id}/entity-filters/${filterId}/entity-filter-blocks`);
        const pick = (x) => canon(stripMeta({ block_type: x.block_type, group_mode: x.group_mode, filter_mode: x.filter_mode, filter_path: x.filter_path, constraints: x.constraints }));
        const sent = fbody.blocks.map(pick).sort();
        const read = fs3 === 200 ? ((fb3 && fb3.value) || []).map(pick).sort() : [];
        Object.assign(ro.readback, { filter_status: fs3, filter_blocks_match: canon(sent) === canon(read) });
      }
      const [cs, cb] = await t.read(`/reporting-dashboards/${dashId}/cells`);
      ro.readback.cell_linked = cs === 200 && ((cb && cb.value) || []).some((x) => x.reporting_dashboard_cell_id === cellId && x.entity_report_id === reportId);
      ro.created = { report_id: reportId, filter_id: filterId, cell_id: cellId, url: `${APP}/${t.slug}/reports/dashboard/${dashId}/cell/${cellId}` };
    }
    if (dashId) { dashOut.dashboard_id = dashId; dashOut.url = `${APP}/${t.slug}/reports/dashboard/${dashId}`; }
  }
  out.writes = t.writes;
  out.summary = out.dashboards.flatMap((d) => d.reports.map((x) => ({
    report: `${d.key}/${x.key}`, match: (x.check || {}).match, ds_total: (x.check || {}).dataset_total,
    oracle_total: (x.check || {}).oracle_total, created: Boolean(x.created), would_create: x.would_create,
    saved_filter_ok: (x.saved_filter_check || {}).match,
    issue: x.compile_error || x.dataset_error || x.error || x.skipped || x.not_created ||
      ((x.saved_filter_check || {}).match === false ? 'saved filter differs from spec or uses an encoding the UI cannot show' : null),
  })));
  return out;
}

// ---------------------------------------------------------------- tools
function makeReportTools({ api, raw, unwrap, ctxFrom, scoped, apiKeyFor, ROOT }) {
  const keyFor = (ctx, args) => {
    if (args.api_key) return args.api_key;
    const ws = path.join(os.homedir(), `.attio-apikey-${ctx.slug}`);
    if (fs.existsSync(ws)) return fs.readFileSync(ws, 'utf8').trim();
    const k = apiKeyFor(ctx.profile);
    if (!k) throw new Error(`Reports need a public API key for "${ctx.slug}" (the recount check reads records through it). ` +
      `Save one to ~/.attio-apikey-${ctx.slug}, or pass api_key.`);
    return k;
  };
  const loadSpec = (args) => {
    if (args.spec) return typeof args.spec === 'string' ? JSON.parse(args.spec) : args.spec;
    if (args.spec_path) return JSON.parse(fs.readFileSync(args.spec_path.replace(/^~/, os.homedir()), 'utf8'));
    throw new Error('Pass spec (object) or spec_path (a JSON file).');
  };
  const wrap = (fn) => async (args) => {
    try { return await fn(args); } catch (e) {
      if (e instanceof BuildError) throw new Error(`report builder: ${e.message}`);
      throw e;
    }
  };

  const SPEC_DOC =
    'Spec: {spec_id, timezone?, workspace?:{slug,id}, dashboards:[{key, title, description?, reports:[report]}]}. ' +
    'Report: {key, title, description?, type:"insights"|"stage-changed", source:{object}|{list}, ' +
    'group?:{attr, via?:[ref slugs], include_empty?}, segment?:{same}, resolution?:"day"|"week"|"month"|"quarter"|"year", ' +
    'visualisation?:"bar"|"line"|"pie"|..., duration?, target?, stacked?, sort?, width?, ' +
    'filters?:[{attr, op, value?|days_ago?|days_from_now?}], accept_difference?, oracle_prefilter?}. ' +
    'Filter ops: is, is_not (select/status by option TITLE), empty, not_empty, after, before (YYYY-MM-DD), ' +
    'after_relative, before_relative (days_ago N, or a UI preset), in_list, not_in_list (single-target ' +
    'record-reference; value = list slug), is_true, is_false (checkbox). stage-changed takes status_attr, ' +
    'stages?, and external_oracle.expected_rows to be creatable.';

  return {
    list_dashboards: {
      description: 'List the workspace\'s report dashboards (id, title, url).',
      inputSchema: scoped({}),
      async run(args) {
        const ctx = ctxFrom(args);
        const rows = unwrap(await api('/reporting-dashboards', { ctx })) || [];
        return {
          count: rows.length,
          dashboards: rows.map((d) => ({
            dashboard_id: d.reporting_dashboard_id || d.id, title: d.title, description: d.description || null,
            url: `${APP}/${ctx.slug}/reports/dashboard/${d.reporting_dashboard_id || d.id}`,
          })),
        };
      },
    },

    get_dashboard: {
      description: 'Read one dashboard: its cells in order and each cell\'s report (title, type, source, grouping, filter id).',
      inputSchema: scoped({ dashboard_id: { type: 'string' } }, ['dashboard_id']),
      async run(args) {
        const ctx = ctxFrom(args);
        const dash = unwrap(await api(`/reporting-dashboards/${args.dashboard_id}`, { ctx }));
        const cells = (unwrap(await api(`/reporting-dashboards/${args.dashboard_id}/cells`, { ctx })) || [])
          .sort((a, b) => String(a.sort_order).localeCompare(String(b.sort_order)));
        const reports = [];
        for (const c of cells) {
          let r = null;
          if (c.entity_report_id) r = unwrap(await api(`/reports/${c.entity_report_id}`, { ctx }).catch(() => null));
          reports.push({
            cell_id: c.reporting_dashboard_cell_id, width: c.width, sort_order: c.sort_order,
            report_id: c.entity_report_id || null,
            ...(r ? { title: r.title, report_type: r.report_type, visualisation: r.visualisation_type,
              entity_definition_id: r.entity_definition_id, entity_filter_id: r.entity_filter_id,
              primary_grouping: r.primary_grouping || null, secondary_grouping: r.secondary_grouping || null,
              time_config: r.time_config || null } : {}),
          });
        }
        return { dashboard_id: args.dashboard_id, title: dash && dash.title, url: `${APP}/${ctx.slug}/reports/dashboard/${args.dashboard_id}`, cells: reports };
      },
    },

    preview_report: {
      description:
        'READ-ONLY. Compile one report from a spec, run Attio\'s own dataset preview, and recount the same ' +
        'thing independently through the public API. Returns both, group by group, and whether they match. ' +
        'Use this to design a report before create_dashboard. Needs the cookie AND a public API key for the ' +
        'workspace (~/.attio-apikey-<workspace_slug>, or api_key). ' + SPEC_DOC,
      inputSchema: scoped({
        report: { type: 'object', description: 'One report spec (see description).' },
        timezone: { type: 'string', description: 'IANA zone for dates and buckets. Default America/Los_Angeles.' },
        api_key: { type: 'string', description: 'Public API key for this workspace, if not saved.' },
      }, ['report']),
      run: wrap(async (args) => {
        const ctx = ctxFrom(args);
        const r = { key: 'preview', ...args.report };
        const spec = { spec_id: `preview-${crypto.randomUUID()}`, timezone: args.timezone,
          dashboards: [{ key: 'preview', title: 'preview', reports: [r] }] };
        const tmpLedger = path.join(os.tmpdir(), `attio-preview-${crypto.randomUUID()}.jsonl`);
        const res = await runSpec({ spec, ctx, key: keyFor(ctx, args), raw, ROOT, live: false, ledgerPath: tmpLedger });
        const ro = res.dashboards[0].reports[0];
        delete ro.would_create;
        return { identity: res.identity, timezone: res.timezone, ...ro };
      }),
    },

    create_dashboard: {
      description:
        'Build dashboards of reports from a spec. DRY RUN BY DEFAULT: compiles every report, previews it, and ' +
        'recounts it through the public API. With live:true it creates the dashboard, filters, reports and ' +
        'cells, but ONLY for reports whose preview matched the recount (or that carry accept_difference), ' +
        'then reads every write back. Create-only: never edits or deletes anything, and refuses to write to ' +
        'an id it did not mint. Every create goes to a ledger (~/.attio-admin-ledgers/<workspace>/<spec_id>.jsonl), ' +
        'so re-running a spec resumes without duplicates. Needs the cookie AND a public API key for the ' +
        'workspace (~/.attio-apikey-<workspace_slug>, or api_key). ' + SPEC_DOC,
      inputSchema: scoped({
        spec: { type: 'object', description: 'The spec (see description).' },
        spec_path: { type: 'string', description: 'Or a path to a spec JSON file.' },
        live: { type: 'boolean', description: 'Actually create. Default false (dry run).' },
        only: { type: 'string', description: 'Limit to DASH_KEY or DASH_KEY/REPORT_KEY.' },
        api_key: { type: 'string', description: 'Public API key for this workspace, if not saved.' },
      }),
      run: wrap(async (args) => {
        const ctx = ctxFrom(args);
        return runSpec({ spec: loadSpec(args), ctx, key: keyFor(ctx, args), raw, ROOT, live: args.live === true, only: args.only });
      }),
    },
  };
}

module.exports = {
  makeReportTools,
  // exported for offline tests
  _test: { relativeLabel, relativeValue, resolveRelative, bucket, compileFilter, checkSavedFilter, BuildError, localDate },
};
