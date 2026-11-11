'use strict';
// Formula attributes on the internal API. The public API cannot create or edit
// them. Shapes captured from the Attio UI on 2026-11-11 (docs/captures/
// formula-attributes-2026-11-11.md) and from 12 saved formulas across workspaces.
//
// Storage: the formula is plaintext with every reference replaced by "_", plus
// annotations that bind each "_" (by start_position/length) to either
//   entity-variable  an attribute path, read through a type-specific field
//   pipeline-stage   one specific status stage
//   select-option    one specific select option
// "The current stage" is the status attribute itself as an entity-variable,
// e.g. timeSpentIn(_, _, "days") with both "_" bound to Deal stage.
//
// The tools take a readable form instead:
//   {Deal value}                     attribute on this object (title or api_slug)
//   {Associated company > Name}      path through record-reference attributes
//   {Deal stage: Negotiation}        one stage / select option, by title
// and render saved formulas back into that form.

const { randomUUID } = require('crypto');

// Which value field an entity-variable reads, by the referenced attribute's
// type. Observed in saved formulas; "null" is what Attio stores for timestamps.
const FIELD_BY_TYPE = {
  pipeline: 'pipeline_stage_id',
  select: 'select_option_id',
  currency: 'raw_value',
  text: 'value',
  number: 'value',
  date: 'value',
  timestamp: null,
};

const OUTPUT_TYPES = ['number', 'currency', 'text', 'date', 'checkbox'];

function makeFormulaTools({ api, raw, unwrap, ctxFrom, scoped, ROOT }) {
  const list = (r) => { const v = unwrap(r); return Array.isArray(v) ? v : (v && v.values) || []; };

  // ------------------------------------------------------------ lookups
  async function resolveObject(ref, ctx) {
    const defs = list(await api('/entity-definitions', { ctx }));
    const hit = defs.find((d) => d.entity_definition_id === ref || d.api_slug === ref);
    if (!hit) {
      throw new Error(`No object "${ref}" in ${ctx.slug}. Objects: ${defs.filter((d) => !d.is_archived).map((d) => d.api_slug).join(', ')}`);
    }
    return hit;
  }

  function makeCache(ctx) {
    const attrs = new Map();
    const opts = new Map();
    return {
      async attrs(eid) {
        if (!attrs.has(eid)) attrs.set(eid, list(await api(`/entity-definitions/${eid}/attribute-definitions`, { ctx })));
        return attrs.get(eid);
      },
      async options(eid, attr) {
        const key = `${eid}/${attr.attribute_definition_id}`;
        if (!opts.has(key)) {
          const sub = attr.type === 'pipeline' ? 'pipeline-stages' : 'select-options';
          opts.set(key, list(await api(`/entity-definitions/${eid}/attribute-definitions/${attr.attribute_definition_id}/${sub}`, { ctx })));
        }
        return opts.get(key);
      },
    };
  }

  async function findAttr(cache, eid, name) {
    const all = (await cache.attrs(eid)).filter((a) => !a.is_archived);
    const n = name.trim().toLowerCase();
    const hits = all.filter((a) => a.title.toLowerCase() === n);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`"${name}" matches ${hits.length} attributes by title; use the api_slug: ${hits.map((a) => a.api_slug).join(', ')}`);
    const bySlug = all.find((a) => a.api_slug === name.trim() || a.attribute_definition_id === name.trim());
    if (bySlug) return bySlug;
    throw new Error(`No attribute "${name}" on this object. Attributes: ${all.map((a) => a.title).join(', ')}`);
  }

  /** Object a record-reference attribute points at. */
  function targetOf(attr) {
    if (attr.relationship && attr.relationship.related_entity_definition_id) return attr.relationship.related_entity_definition_id;
    const allowed = (attr.entity_reference_configuration || {}).allowed_entity_definitions || [];
    if (allowed.length === 1) return allowed[0];
    if (!allowed.length) throw new Error(`"${attr.title}" is ${attr.type}, not a record reference, so a path cannot continue through it.`);
    throw new Error(`"${attr.title}" can point at ${allowed.length} objects; a formula path through it is ambiguous.`);
  }

  // ------------------------------------------------- readable -> stored
  /** Turn one {…} reference into an annotation (without position). */
  async function compileRef(text, eid, cache, warnings) {
    const hops = text.split('>').map((s) => s.trim());
    let last = hops.pop();
    let option = null;
    const colon = last.indexOf(':');
    if (colon >= 0) { option = last.slice(colon + 1).trim(); last = last.slice(0, colon).trim(); }
    const path = [];
    let cur = eid;
    for (const h of hops) {
      const a = await findAttr(cache, cur, h);
      path.push({ entity_definition_id: cur, attribute_definition_id: a.attribute_definition_id });
      cur = targetOf(a);
    }
    const attr = await findAttr(cache, cur, last);
    if (option !== null) {
      if (attr.type !== 'pipeline' && attr.type !== 'select') {
        throw new Error(`{${text}}: "${attr.title}" is ${attr.type}; only status and select attributes take ": option".`);
      }
      const opts = (await cache.options(cur, attr)).filter((o) => !o.is_archived);
      const hit = opts.find((o) => o.title.toLowerCase() === option.toLowerCase());
      if (!hit) throw new Error(`{${text}}: no option "${option}". Options: ${opts.map((o) => o.title).join(', ')}`);
      return attr.type === 'pipeline'
        ? { type: 'pipeline-stage', entity_definition_id: cur, attribute_definition_id: attr.attribute_definition_id, pipeline_stage_id: hit.pipeline_stage_id }
        : { type: 'select-option', entity_definition_id: cur, attribute_definition_id: attr.attribute_definition_id, select_option_id: hit.select_option_id };
    }
    path.push({ entity_definition_id: cur, attribute_definition_id: attr.attribute_definition_id });
    let field = FIELD_BY_TYPE[attr.type];
    if (field === undefined) {
      field = null;
      warnings.push(`{${text}} is a ${attr.type} attribute; its stored field has never been observed, so null was used. Check the record results.`);
    }
    return { type: 'entity-variable', path, field, fallback_value: null };
  }

  /** Readable formula -> { plaintext, annotations }. Braces inside "strings" are left alone. */
  async function compileFormula(formula, eid, cache) {
    let out = '';
    const annotations = [];
    const warnings = [];
    let inStr = false;
    for (let i = 0; i < formula.length; i++) {
      const ch = formula[i];
      if (inStr) {
        out += ch;
        if (ch === '\\') { out += formula[++i] || ''; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; out += ch; continue; }
      if (ch === '{') {
        const end = formula.indexOf('}', i);
        if (end < 0) throw new Error(`Unclosed "{" at position ${i}.`);
        const ann = await compileRef(formula.slice(i + 1, end), eid, cache, warnings);
        annotations.push({ ...ann, start_position: out.length, length: 1 });
        out += '_';
        i = end;
        continue;
      }
      if (ch === '}') throw new Error(`Stray "}" at position ${i}.`);
      out += ch;
    }
    if (inStr) throw new Error('Unclosed string literal.');
    return { plaintext: out, annotations, warnings };
  }

  // ------------------------------------------------- stored -> readable
  async function renderFormula(plaintext, annotations, cache) {
    const title = async (eid, id) => ((await cache.attrs(eid)).find((a) => a.attribute_definition_id === id) || { title: id }).title;
    const parts = [];
    for (const an of annotations || []) {
      let txt;
      if (an.type === 'entity-variable') {
        const names = [];
        for (const p of an.path || []) names.push(await title(p.entity_definition_id, p.attribute_definition_id));
        txt = `{${names.join(' > ')}}`;
      } else if (an.type === 'pipeline-stage' || an.type === 'select-option') {
        const attr = (await cache.attrs(an.entity_definition_id)).find((a) => a.attribute_definition_id === an.attribute_definition_id);
        const optId = an.pipeline_stage_id || an.select_option_id;
        let opt = optId;
        if (attr) {
          const o = (await cache.options(an.entity_definition_id, attr)).find((x) => (x.pipeline_stage_id || x.select_option_id) === optId);
          if (o) opt = o.title;
        }
        txt = `{${attr ? attr.title : an.attribute_definition_id}: ${opt}}`;
      } else {
        txt = `{?${an.type}}`;
      }
      parts.push({ start: an.start_position, length: an.length, txt });
    }
    let s = plaintext;
    for (const p of parts.sort((a, b) => b.start - a.start)) s = s.slice(0, p.start) + p.txt + s.slice(p.start + p.length);
    return s;
  }

  // ---------------------------------------------------- attribute body
  function outputConfig(outputType, args) {
    if (!OUTPUT_TYPES.includes(outputType)) {
      throw new Error(`output_type must be one of ${OUTPUT_TYPES.join(', ')} (the formula output types seen in saved formulas).`);
    }
    if (outputType === 'number') return { number_configuration: { default_groups: 'default', default_decimal_places: null } };
    if (outputType === 'currency') {
      return { currency_configuration: { default_currency_code: (args.currency_code || 'USD').toUpperCase(),
        default_display_type: 'code', default_decimal_places: 'two-decimals', default_groups: 'default' } };
    }
    return {};
  }
  // The UI sets the override when the output is currency (a math formula is
  // detected as number). Other types were saved with null.
  const overrideFor = (t) => (t === 'currency' ? 'currency' : null);

  // ------------------------------------------------- runtime verification
  /**
   * Attio validates syntax and functions on save but NOT the output type: a
   * text formula saved as number saves fine and errors on every record. So
   * read the computed values for a sample of records.
   */
  async function checkRecords(eid, attrId, n, ctx) {
    if (!n) return null;
    const res = await raw(`${ROOT}/particle/workspaces/${ctx.slug}/entity-definitions/${eid}/entity-instances/mrl`, {
      method: 'POST', cookie: ctx.cookie, body: { filter: null, sorts: [], initialRange: { start: 0, size: n } },
    });
    const ids = (res && res.entity_instance_ids_chunk) || [];
    if (!ids.length) return { records_checked: 0, note: 'Object has no records to check.' };
    let summary;
    for (let attempt = 0; attempt < 10; attempt++) {
      const vals = await api(`/entity-definitions/${eid}/attribute-definitions/${attrId}/values`, { method: 'POST', ctx, body: { entity_instance_ids: ids } });
      const s = { records_checked: ids.length, with_value: 0, empty: 0, errored: 0, pending: 0, samples: [] };
      for (const id of ids) {
        const v = vals[id] && vals[id].value;
        const status = v && v.entity_annotation && v.entity_annotation.formula ? v.entity_annotation.formula.last_execution_status : null;
        const first = v && v.values && v.values[0];
        if (status === 'error') s.errored++;
        else if (first) { s.with_value++; if (s.samples.length < 3) s.samples.push(first.value); }
        else if (status && status !== 'complete') s.pending++;
        else s.empty++;
      }
      summary = s;
      if (!s.pending) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (summary.errored) {
      summary.warning = `${summary.errored} of ${summary.records_checked} records errored. Usually output_type does not match what ` +
        'the formula returns (e.g. text saved as number), or a reference reads the wrong field. Fix with update_formula.';
    }
    return summary;
  }

  async function readSnapshot(eid, attr, ctx) {
    const snap = attr.formula_configuration && attr.formula_configuration.active_snapshot_id;
    if (!snap) return null;
    return api(`/entity-definitions/${eid}/attribute-definitions/${attr.attribute_definition_id}/formula-attribute-snapshots/${snap}`, { ctx });
  }

  // Key order differs between what we send and what Attio returns: compare canonically.
  const canon = (v) => (Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  const sameStored = (s, plaintext, annotations) => {
    const norm = (a) => JSON.stringify(canon([...(a || [])].sort((p, q) => p.start_position - q.start_position)));
    return !!s && s.formula_plaintext === plaintext && norm(s.formula_annotations) === norm(annotations);
  };

  /** Attio's formula 400s carry a code but no position: translate them. */
  async function saveFormula(path, method, body, ctx) {
    try {
      return await api(path, { method, ctx, body });
    } catch (e) {
      const code = (/"code":"(FORMULA_[A-Z_]+)"/.exec(e.message) || [])[1];
      if (!code) throw e;
      const why = code === 'FORMULA_HAS_ERRORS'
        ? 'a syntax error (unbalanced brackets, missing argument, stray operator) or a reference in the wrong place'
        : code === 'FORMULA_TYPECHECK_FAILED'
          ? 'an unknown function, wrong argument count, or an argument of the wrong type (e.g. a select passed where a status is needed)'
          : 'see the code';
      throw new Error(`Attio rejected the formula (${code}): ${why}. Nothing was saved. Compiled plaintext: ${body.formula_configuration.plaintext}`);
    }
  }

  const refHelp = 'Readable syntax: {Attribute} for an attribute on this object (title or api_slug); ' +
    '{Relationship > Attribute} to follow a record reference; {Status or select: Option title} for one specific ' +
    'stage/option. The CURRENT stage is the status attribute itself, e.g. timeSpentIn({Deal stage}, {Deal stage}, "days"). ' +
    'Functions and operators: Attio formula language (if, and, or, ifNull/??, dateDiff, dateAdd, today, now, timeSpentIn, ' +
    'valueSetAt, hasBeenIn, previousValue, count, sum, round, text, number, currency, …). Strings use double quotes.';

  // ----------------------------------------------------------------- tools
  return {
    get_formula: {
      description:
        'Read a formula attribute: its formula in readable form ({Attribute}, {A > B}, {Stage: Option}), the raw stored ' +
        'plaintext and annotations, output type, and optionally how it computes on a sample of records (errors included). ' +
        'The public API cannot read formulas.',
      inputSchema: scoped({
        object: { type: 'string', description: 'Object api_slug or entity_definition_id.' },
        attribute: { type: 'string', description: 'Attribute title, api_slug or id.' },
        check_records: { type: 'number', description: 'Records to sample for computed values. Default 10; 0 to skip.' },
      }, ['object', 'attribute']),
      async run(args) {
        const ctx = ctxFrom(args);
        const obj = await resolveObject(args.object, ctx);
        const cache = makeCache(ctx);
        const attr = await findAttr(cache, obj.entity_definition_id, args.attribute);
        const snap = await readSnapshot(obj.entity_definition_id, attr, ctx);
        if (!snap) throw new Error(`"${attr.title}" is a ${attr.type} attribute, not a formula.`);
        return {
          workspace: ctx.slug, object: obj.api_slug, attribute: attr.title, api_slug: attr.api_slug,
          attribute_definition_id: attr.attribute_definition_id, output_type: attr.type,
          output_type_override: snap.output_type_override,
          formula: await renderFormula(snap.formula_plaintext, snap.formula_annotations, cache),
          stored: { plaintext: snap.formula_plaintext, annotations: snap.formula_annotations, grammar_version: snap.grammar_version },
          disabled_by: attr.formula_configuration.disabled_by,
          records: await checkRecords(obj.entity_definition_id, attr.attribute_definition_id, args.check_records ?? 10, ctx),
        };
      },
    },

    create_formula_attribute: {
      description:
        'Create a formula attribute on an object (not possible on the public API). Attio rejects syntax errors and ' +
        'unknown functions, but it accepts a wrong output_type and then errors on every record, so this tool reads back ' +
        'the saved formula AND samples computed values; check records.errored. dry_run compiles and resolves every ' +
        'reference without writing. ' + refHelp,
      inputSchema: scoped({
        object: { type: 'string', description: 'Object api_slug or entity_definition_id.' },
        title: { type: 'string' },
        formula: { type: 'string', description: 'Readable formula, e.g. if({Deal value} > 10000, "Large", "Small").' },
        output_type: { type: 'string', enum: OUTPUT_TYPES, description: 'What the formula returns. Must match, or every record errors.' },
        currency_code: { type: 'string', description: 'For output_type currency. Default USD. Formulas relabel, never convert.' },
        description: { type: 'string' },
        dry_run: { type: 'boolean', description: 'Compile and resolve only. Default false.' },
        check_records: { type: 'number', description: 'Records to sample after saving. Default 10.' },
      }, ['object', 'title', 'formula', 'output_type']),
      async run(args) {
        const ctx = ctxFrom(args);
        const obj = await resolveObject(args.object, ctx);
        const eid = obj.entity_definition_id;
        const cache = makeCache(ctx);
        const existing = (await cache.attrs(eid)).filter((a) => !a.is_archived);
        if (existing.some((a) => a.title.toLowerCase() === args.title.toLowerCase())) {
          throw new Error(`"${obj.api_slug}" already has an attribute titled "${args.title}". Use update_formula to change it.`);
        }
        const { plaintext, annotations, warnings } = await compileFormula(args.formula, eid, cache);
        const attrId = randomUUID();
        const maxSort = existing.map((a) => a.sort_order || '').sort().pop() || 'm';
        const body = {
          title: args.title, description: args.description || '', type: args.output_type,
          ...outputConfig(args.output_type, args),
          sort_order: `${maxSort}m`, is_historic: false, is_required: false, is_unique: false, is_multiselect: false,
          formula_configuration: { formula_attribute_snapshot_id: randomUUID(), plaintext, annotations, output_type_override: overrideFor(args.output_type) },
        };
        const compiled = { plaintext, annotations, rendered: await renderFormula(plaintext, annotations, cache) };
        if (args.dry_run) return { dry_run: true, workspace: ctx.slug, object: obj.api_slug, compiled, warnings, body };
        await saveFormula(`/entity-definitions/${eid}/attribute-definitions/${attrId}`, 'PUT', body, ctx);
        const saved = await api(`/entity-definitions/${eid}/attribute-definitions/${attrId}`, { ctx });
        const snap = await readSnapshot(eid, saved, ctx);
        return {
          workspace: ctx.slug, object: obj.api_slug, attribute_definition_id: attrId, api_slug: saved.api_slug,
          title: saved.title, output_type: saved.type,
          readback_matches: sameStored(snap, plaintext, annotations),
          formula: compiled.rendered, warnings,
          records: await checkRecords(eid, attrId, args.check_records ?? 10, ctx),
        };
      },
    },

    update_formula: {
      description:
        'Change a formula attribute: its formula, output type, title or description. Saves a new formula snapshot and ' +
        'reads it back, then samples computed values. Changing the output type CLEARS existing values (Attio recalculates). ' +
        refHelp,
      inputSchema: scoped({
        object: { type: 'string' },
        attribute: { type: 'string', description: 'Attribute title, api_slug or id.' },
        formula: { type: 'string', description: 'New readable formula. Omit to keep the current one.' },
        output_type: { type: 'string', enum: OUTPUT_TYPES, description: 'Omit to keep the current one.' },
        currency_code: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        dry_run: { type: 'boolean' },
        check_records: { type: 'number', description: 'Default 10.' },
      }, ['object', 'attribute']),
      async run(args) {
        const ctx = ctxFrom(args);
        const obj = await resolveObject(args.object, ctx);
        const eid = obj.entity_definition_id;
        const cache = makeCache(ctx);
        const attr = await findAttr(cache, eid, args.attribute);
        const snap = await readSnapshot(eid, attr, ctx);
        if (!snap) throw new Error(`"${attr.title}" is a ${attr.type} attribute, not a formula.`);
        const before = await renderFormula(snap.formula_plaintext, snap.formula_annotations, cache);
        let plaintext = snap.formula_plaintext;
        let annotations = snap.formula_annotations;
        let warnings = [];
        if (args.formula) ({ plaintext, annotations, warnings } = await compileFormula(args.formula, eid, cache));
        const outputType = args.output_type || attr.type;
        if (!args.output_type && !OUTPUT_TYPES.includes(outputType)) {
          throw new Error(`Current output type "${outputType}" is not one this tool writes; pass output_type.`);
        }
        const body = {
          title: args.title || attr.title, is_multiselect: false,
          description: args.description !== undefined ? args.description : attr.description || '',
          type: outputType,
          ...(outputType === attr.type && attr.currency_configuration && !args.currency_code
            ? { currency_configuration: attr.currency_configuration }
            : outputType === attr.type && attr.number_configuration
              ? { number_configuration: attr.number_configuration }
              : outputConfig(outputType, args)),
          default_value: null,
          formula_configuration: { formula_attribute_snapshot_id: randomUUID(), plaintext, annotations, output_type_override: overrideFor(outputType) },
        };
        const after = await renderFormula(plaintext, annotations, cache);
        const typeChange = outputType !== attr.type;
        if (args.dry_run) return { dry_run: true, before, after, output_type: { from: attr.type, to: outputType }, warnings, body };
        await saveFormula(`/entity-definitions/${eid}/attribute-definitions/${attr.attribute_definition_id}`, 'PATCH', body, ctx);
        const saved = await api(`/entity-definitions/${eid}/attribute-definitions/${attr.attribute_definition_id}`, { ctx });
        const snap2 = await readSnapshot(eid, saved, ctx);
        return {
          workspace: ctx.slug, object: obj.api_slug, attribute: saved.title, before, after,
          output_type: { from: attr.type, to: saved.type },
          ...(typeChange ? { note: 'Output type changed: previous values were cleared and are being recalculated.' } : {}),
          readback_matches: sameStored(snap2, plaintext, annotations), warnings,
          records: await checkRecords(eid, attr.attribute_definition_id, args.check_records ?? 10, ctx),
        };
      },
    },

    generate_formula: {
      description:
        'Ask Attio\'s own formula AI (the composer in the formula editor) to write a formula from a plain-English prompt, ' +
        'or to fix a broken formula. Returns it in readable form, ready for create_formula_attribute. Writes nothing to ' +
        'the schema. Attio says the composer uses no workspace credits.',
      inputSchema: scoped({
        object: { type: 'string' },
        prompt: { type: 'string', description: 'e.g. "days this deal has been in its current stage".' },
        fix_formula: { type: 'string', description: 'Readable formula to repair instead of generating (prompt optional).' },
      }, ['object']),
      async run(args) {
        if (!args.prompt && !args.fix_formula) throw new Error('Pass prompt, or fix_formula.');
        const ctx = ctxFrom(args);
        const obj = await resolveObject(args.object, ctx);
        const eid = obj.entity_definition_id;
        const cache = makeCache(ctx);
        let draft = null;
        if (args.fix_formula) {
          const c = await compileFormula(args.fix_formula, eid, cache);
          draft = { plaintext: c.plaintext, annotations: c.annotations };
        }
        const id = randomUUID();
        const path = `/entity-definitions/${eid}/formula-generation-requests/${id}`;
        await api(path, { method: 'PUT', ctx, body: {
          type: draft ? 'fix' : 'generate', prompt: args.prompt || null,
          selection_start_from: null, selection_start_to: null, input_formula_draft: draft,
        } });
        let r;
        for (let i = 0; i < 45; i++) {
          await new Promise((res) => setTimeout(res, 2000));
          r = await api(path, { ctx });
          // Seen: generating -> completed. Stop on anything that is not still working.
          if (r.status && !['pending', 'generating', 'in-progress', 'running', 'queued'].includes(r.status)) break;
        }
        if (!r || r.status !== 'completed') {
          return { status: r ? r.status : 'unknown', refusal: r && r.refusal_message, note: 'Generation did not complete.' };
        }
        return {
          status: r.status,
          formula: await renderFormula(r.output_plaintext, r.output_annotations, cache),
          refusal: r.refusal_message || null,
          stored: { plaintext: r.output_plaintext, annotations: r.output_annotations },
          next: 'Check the formula, pick an output_type that matches what it returns, then create_formula_attribute.',
        };
      },
    },
  };
}

module.exports = { makeFormulaTools, _test: { FIELD_BY_TYPE, OUTPUT_TYPES } };
