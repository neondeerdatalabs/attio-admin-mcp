'use strict';
// Offline tests for reports.js (no network). Ported from Erik Wood's
// tests/test_build_dashboard.py, plus bucket checks. Run: node test-reports.js
const assert = require('assert');
const { _test: R } = require('./reports');

const NOW = new Date(Date.UTC(2026, 9, 19, 23, 0)); // 16:00 in Los Angeles
const TZ = 'America/Los_Angeles';
const SRC = { id: 'src', kind: 'objects', slug: 'employment_history' };
const dateB = { attr: async (s, slug) => ({ id: `attr-${slug}`, slug, type: 'date', targets: [] }) };
const cbB = { attr: async (s, slug) => ({ id: 'attr-cb', slug, type: 'checkbox', targets: [] }) };
const compiled = async (...fs) => ({ filters: await Promise.all(fs.map((f) => R.compileFilter(f, SRC, dateB, TZ, NOW, new Map()))) });
const savedBlock = (attrId, value) => ({
  entity_filter_block_id: 'b1', parent_entity_filter_block_id: null, block_type: 'filter', filter_mode: 'must',
  filter_path: [{ entity_definition_id: 'src', attribute_definition_id: attrId }],
  constraints: [{ field: 'value', operator: 'gt', value, value_type: 'dynamic' },
    { field: 'active_until', operator: 'empty', value: 'null', value_type: 'static' }],
});

let pass = 0; let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); } catch (e) { fail++; console.log(`  FAIL  ${name} — ${e.message}`); }
}

(async () => {
  await t('UI-captured relative presets have labels', () => {
    const captured = { 'P0Y0M0DT0H0M0S': 'Today', '-P0Y0M1DT0H0M0S': 'Yesterday', 'P0Y0M1DT0H0M0S': 'Tomorrow',
      '-P0Y0M7DT0H0M0S': 'One week ago', 'P0Y0M7DT0H0M0S': 'One week from now', '-P0Y1M0DT0H0M0S': 'One month ago',
      'P0Y1M0DT0H0M0S': 'One month from now', '-P0Y0M365DT0H0M0S': '365 days ago', 'P0Y0M30DT0H0M0S': '30 days from now' };
    for (const [v, l] of Object.entries(captured)) assert.strictEqual(R.relativeLabel(v), l, v);
  });
  await t('year durations are rejected (UI shows "Unsupported relative date")', async () => {
    assert.strictEqual(R.relativeLabel('-P1Y0M0DT0H0M0S'), null);
    assert.strictEqual(R.relativeLabel('-P0Y12M0DT0H0M0S'), null);
    await assert.rejects(compiled({ attr: 'start_date', op: 'after_relative', value: '-P1Y0M0DT0H0M0S' }), R.BuildError);
  });
  await t('days_ago compiles to the UI form and a local cutoff', async () => {
    const f = (await compiled({ attr: 'start_date', op: 'after_relative', days_ago: 365 })).filters[0];
    assert.deepStrictEqual(f.leaf.constraints[0], { field: 'value', operator: 'gt', value: '-P0Y0M365DT0H0M0S', value_type: 'dynamic' });
    assert.strictEqual(f.clause.constraints[0].value, '2025-10-19');
    const f2 = (await compiled({ attr: 'start_date', op: 'after_relative', value: '-P0Y0M365DT0H0M0S' })).filters[0];
    assert.deepStrictEqual(f2.leaf, f.leaf);
  });
  await t('resolveRelative signs and months', () => {
    assert.strictEqual(R.resolveRelative('-P0Y1M0DT0H0M0S', TZ, NOW), '2026-09-19');
    assert.strictEqual(R.resolveRelative('P0Y0M30DT0H0M0S', TZ, NOW), '2026-11-18');
    assert.strictEqual(R.resolveRelative('P0Y0M0DT0H0M0S', TZ, NOW), '2026-10-19');
  });
  await t('bad saved encoding is flagged even though it round-trips', async () => {
    const chk = R.checkSavedFilter([savedBlock('attr-end_date', '-P1Y0M0DT0H0M0S')], await compiled({ attr: 'end_date', op: 'after_relative', days_ago: 365 }));
    assert.strictEqual(chk.match, false);
    assert.deepStrictEqual(chk.unsupported_saved.map((x) => x.value), ['-P1Y0M0DT0H0M0S']);
  });
  await t('good saved encoding passes', async () => {
    const chk = R.checkSavedFilter([savedBlock('attr-end_date', '-P0Y0M365DT0H0M0S')], await compiled({ attr: 'end_date', op: 'after_relative', days_ago: 365 }));
    assert.strictEqual(chk.match, true);
    assert.strictEqual(chk.saved[0].ui_label, '365 days ago');
  });
  await t('checkbox "is false" is must-not eq true', async () => {
    const f = await R.compileFilter({ attr: 'suppressed', op: 'is_false' }, SRC, cbB, TZ, NOW, new Map());
    assert.strictEqual(f.clause.mode, 'must-not');
    assert.deepStrictEqual(f.clause.constraints[0], { field: 'value', operator: 'eq', value: true });
    assert.strictEqual(f.leaf.constraints[0].value, 'true');
    assert.ok(f.pred([]) && f.pred([false]) && !f.pred([true]));
  });
  await t('checkbox "is true" is must eq true', async () => {
    const f = await R.compileFilter({ attr: 'suppressed', op: 'is_true' }, SRC, cbB, TZ, NOW, new Map());
    assert.strictEqual(f.clause.mode, 'must');
    assert.ok(f.pred([true]) && !f.pred([]));
  });
  await t('buckets: quarter, month, year, ISO week (Monday)', () => {
    assert.strictEqual(R.bucket('2026-11-06', 'quarter'), '2026-10-01');
    assert.strictEqual(R.bucket('2026-11-06', 'month'), '2026-11-01');
    assert.strictEqual(R.bucket('2026-11-06', 'year'), '2026-01-01');
    assert.strictEqual(R.bucket('2026-11-06', 'week'), '2026-11-02');
    assert.strictEqual(R.bucket('2026-11-02', 'week'), '2026-11-02');
  });
  await t('timestamps bucket on the LOCAL date', () => {
    assert.strictEqual(R.localDate(new Date('2026-11-07T03:00:00Z'), TZ), '2026-11-06');
  });
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
