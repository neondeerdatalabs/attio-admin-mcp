'use strict';
// Offline tests for formulas.js: readable syntax -> stored plaintext/annotations
// and back, against a fake workspace. No network. Run: node test-formulas.js
const assert = require('assert');
const { makeFormulaTools } = require('./formulas');

const D = 'deals-id'; const C = 'companies-id';
const ATTRS = {
  [D]: [
    { attribute_definition_id: 'dv', api_slug: 'value', title: 'Deal value', type: 'currency' },
    { attribute_definition_id: 'st', api_slug: 'stage', title: 'Deal stage', type: 'pipeline' },
    { attribute_definition_id: 'ac', api_slug: 'associated_company', title: 'Associated company', type: 'entity-reference',
      relationship: { related_entity_definition_id: C } },
    { attribute_definition_id: 'cd', api_slug: 'close_date', title: 'Close date', type: 'date' },
    { attribute_definition_id: 'ts', api_slug: 'created_at', title: 'Created at', type: 'timestamp' },
    { attribute_definition_id: 'ph', api_slug: 'phone', title: 'Phone', type: 'phone-number' },
    { attribute_definition_id: 'f1', api_slug: 'stage_age', title: 'Stage Age', type: 'number',
      formula_configuration: { active_snapshot_id: 'snap1', disabled_by: null } },
  ],
  [C]: [
    { attribute_definition_id: 'nm', api_slug: 'name', title: 'Name', type: 'text' },
    { attribute_definition_id: 'in', api_slug: 'industry', title: 'Industry', type: 'select' },
  ],
};
const STAGES = [{ pipeline_stage_id: 's-won', title: 'Closed won' }, { pipeline_stage_id: 's-neg', title: 'Negotiation' }];
const OPTIONS = [{ select_option_id: 'o-saas', title: 'SaaS' }];
const SNAP = {
  formula_plaintext: 'timeSpentIn(_, _, "hours")/24', grammar_version: '0.0.1', output_type_override: null,
  formula_annotations: [
    { type: 'entity-variable', start_position: 12, length: 1, path: [{ entity_definition_id: D, attribute_definition_id: 'st' }], field: 'pipeline_stage_id', fallback_value: null },
    { type: 'entity-variable', start_position: 15, length: 1, path: [{ entity_definition_id: D, attribute_definition_id: 'st' }], field: 'pipeline_stage_id', fallback_value: null },
  ],
};
const writes = [];
async function api(p, { method = 'GET', body } = {}) {
  if (method !== 'GET') { writes.push({ p, method, body }); return {}; }
  if (p === '/entity-definitions') return [{ entity_definition_id: D, api_slug: 'deals' }, { entity_definition_id: C, api_slug: 'companies' }];
  let m = /^\/entity-definitions\/([^/]+)\/attribute-definitions$/.exec(p);
  if (m) return { value: ATTRS[m[1]] };
  if (/pipeline-stages$/.test(p)) return { values: STAGES };
  if (/select-options$/.test(p)) return { values: OPTIONS };
  if (/formula-attribute-snapshots\/snap1$/.test(p)) return SNAP;
  m = /^\/entity-definitions\/([^/]+)\/attribute-definitions\/([^/]+)$/.exec(p);
  if (m) return ATTRS[m[1]].find((a) => a.attribute_definition_id === m[2]);
  throw new Error(`unexpected GET ${p}`);
}
const tools = makeFormulaTools({
  api, raw: async () => { throw new Error('raw not expected'); }, unwrap: (r) => (r && r.value !== undefined ? r.value : r),
  ctxFrom: () => ({ slug: 'test', cookie: 'x' }), scoped: (props, req) => ({ type: 'object', properties: props, required: req }), ROOT: '',
});
const dry = (formula, output_type = 'number') => tools.create_formula_attribute.run({ object: 'deals', title: 'T', formula, output_type, dry_run: true });

let pass = 0; let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); } catch (e) { fail++; console.log(`  FAIL  ${name} — ${e.message}`); }
}

(async () => {
  await t('get_formula renders the stored current-stage pattern', async () => {
    const r = await tools.get_formula.run({ object: 'deals', attribute: 'Stage Age', check_records: 0 });
    assert.strictEqual(r.formula, 'timeSpentIn({Deal stage}, {Deal stage}, "hours")/24');
  });
  await t('compile: current stage is two entity-variables on the stage attribute', async () => {
    const r = await dry('timeSpentIn({Deal stage}, {Deal stage}, "hours")/24');
    assert.strictEqual(r.compiled.plaintext, SNAP.formula_plaintext);
    assert.deepStrictEqual(r.compiled.annotations.map((a) => [a.start_position, a.type, a.field]), [[12, 'entity-variable', 'pipeline_stage_id'], [15, 'entity-variable', 'pipeline_stage_id']]);
  });
  await t('compile: currency reads raw_value, date reads value, timestamp reads null', async () => {
    const r = await dry('dateDiff({Close date}, {Created at}, "days") + {Deal value}');
    assert.deepStrictEqual(r.compiled.annotations.map((a) => a.field), ['value', null, 'raw_value']);
  });
  await t('compile: relationship path has one hop per object', async () => {
    const r = await dry('{Associated company > Name}', 'text');
    assert.deepStrictEqual(r.compiled.annotations[0].path, [{ entity_definition_id: D, attribute_definition_id: 'ac' }, { entity_definition_id: C, attribute_definition_id: 'nm' }]);
    assert.strictEqual(r.compiled.annotations[0].field, 'value');
  });
  await t('compile: stage and select options become pipeline-stage / select-option', async () => {
    const r = await dry('and(hasBeenIn({Deal stage}, {Deal stage: Negotiation}), {Associated company > Industry} == {Associated company > Industry: SaaS})', 'checkbox');
    const kinds = r.compiled.annotations.map((a) => a.type);
    assert.deepStrictEqual(kinds, ['entity-variable', 'pipeline-stage', 'entity-variable', 'select-option']);
    assert.strictEqual(r.compiled.annotations[1].pipeline_stage_id, 's-neg');
    assert.strictEqual(r.compiled.annotations[3].select_option_id, 'o-saas');
    assert.strictEqual(r.compiled.annotations[3].entity_definition_id, C);
    assert.strictEqual(r.compiled.annotations[2].field, 'select_option_id');
  });
  await t('compile: braces inside strings are left alone; render round-trips', async () => {
    const f = 'if({Deal value} > 10, "a {b} \\"c\\"", "d")';
    const r = await dry(f, 'text');
    assert.strictEqual(r.compiled.plaintext, 'if(_ > 10, "a {b} \\"c\\"", "d")');
    assert.strictEqual(r.compiled.rendered, f);
  });
  await t('compile: api_slug works as a reference', async () => {
    assert.strictEqual((await dry('{value} * 2')).compiled.annotations[0].path[0].attribute_definition_id, 'dv');
  });
  await t('compile: unknown attribute, unknown option and option on a non-option attribute are refused', async () => {
    await assert.rejects(dry('{Nope}'), /No attribute "Nope"/);
    await assert.rejects(dry('{Deal stage: Lost}'), /no option "Lost"\. Options: Closed won, Negotiation/);
    await assert.rejects(dry('{Deal value: X}'), /only status and select/);
    await assert.rejects(dry('{Deal value > Name}'), /not a record reference/);
    await assert.rejects(dry('{Deal value'), /Unclosed/);
  });
  await t('compile: unobserved field type warns instead of guessing', async () => {
    const r = await dry('{Phone}', 'text');
    assert.strictEqual(r.compiled.annotations[0].field, null);
    assert.match(r.warnings[0], /never been observed/);
  });
  await t('body: currency sets the override and currency_configuration; text sets neither', async () => {
    const c = await dry('{Deal value} * 0.5', 'currency');
    assert.strictEqual(c.body.formula_configuration.output_type_override, 'currency');
    assert.strictEqual(c.body.currency_configuration.default_currency_code, 'USD');
    const tx = await dry('"x"', 'text');
    assert.strictEqual(tx.body.formula_configuration.output_type_override, null);
    assert.ok(!tx.body.currency_configuration && !tx.body.number_configuration);
    await assert.rejects(dry('1', 'rating'), /output_type must be one of/);
  });
  await t('duplicate title is refused before any write', async () => {
    await assert.rejects(tools.create_formula_attribute.run({ object: 'deals', title: 'stage age', formula: '1', output_type: 'number' }), /already has an attribute/);
    assert.strictEqual(writes.length, 0);
  });
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
