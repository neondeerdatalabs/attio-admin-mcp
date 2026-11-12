'use strict';
// Offline tests for runs.js against a fake workspace. No network. Run: node test-runs.js
const assert = require('assert');
const { makeRunTools } = require('./runs');

const W = 'wf1'; const V1 = 'v1'; const V2 = 'v2';
const mkRun = (n, status, ver) => ({
  workflow_version_id: ver, workflow_version_run_id: `r${n}`, sequence_number: n, status, filterable_status: status,
  created_at: new Date(Date.UTC(2026, 10, n)).toISOString(), completed_at: null, failed_at: null, retried_from: null,
  sort_key: `${String(n).padStart(4, '0')}_${ver}_r${n}`,
});
// 1203 runs so paging (500 per page) crosses two boundaries.
const RUNS = Array.from({ length: 1203 }, (_, i) => mkRun(1203 - i, i % 3 === 0 ? 'failed' : 'completed', i < 600 ? V2 : V1));
const exec = (id, block, status, extra = {}) => ({
  workflow_version_run_frame_block_execution_id: id, workflow_version_block_instance_id: block, status, outcome: status === 'completed' ? 'done' : null,
  failure_reason: status === 'failed' ? 'block-execute-responded-with-error' : null, error_message: status === 'failed' ? 'Missing required key "formKey" at formKey' : null,
  waiting_reason: null, did_continue_on_error: false, attempts: 1, execution_cost: null, has_outcome_data: status === 'completed',
  started_executing_at: extra.at || '2026-11-01T00:00:00Z', completed_at: null, failed_at: null, ...extra,
});
const EXECS = {
  fRoot: [exec('e1', 'trig', 'completed', { at: '1' }), exec('e2', 'parse', 'failed', { at: '2' })],
  fRetry: [exec('e3', 'parse', 'failed', { at: '3' })],
};
const calls = [];
async function api(p, { method = 'GET', body } = {}) {
  calls.push({ p, method, body });
  if (p === `/workflows/${W}`) return { workflow_id: W, title: null, ai_title: 'AI name', status: 'live', active_workflow_version_id: V2, draft_workflow_version_id: 'd' };
  if (p === '/workflows/legacy') return { workflow_id: 'legacy', title: 'Old', draft_workflow_version_id: null, active_workflow_version_id: null };
  if (p === `/workflows/${W}/runs/latest`) return { latest_run: { sort_key: RUNS[0].sort_key } };
  if (p === `/workflows/${W}/runs/query`) {
    assert.ok(body.sort_key_cursor, 'cursor required');
    let i = RUNS.findIndex((r) => r.sort_key === body.sort_key_cursor.sort_key);
    if (!body.sort_key_cursor.inclusive) i++;
    return { value: RUNS.slice(i, i + body.limit) };
  }
  if (p === `/workflows/${W}/statistics`) return { last_7_days_runs: 2, last_7_days_completed_runs: 1, last_7_days_failed_runs: 1 };
  if (p === '/workflows/batch-run-counts') return { [W]: { state: 'complete', value: { value: 1203 } } };
  let m = /\/versions\/([^/]+)\/block-instances$/.exec(p);
  if (m) return { value: [{ workflow_version_block_instance_id: 'trig', block_type: 'trigger', provider: { system_block_slug: 'on-record-created' } }, { workflow_version_block_instance_id: 'parse', block_type: 'step', provider: { system_block_slug: 'parse-json' } }] };
  if (/\/frames$/.test(p)) return { value: [{ workflow_version_run_frame_id: 'fRoot', type: 'root', status: 'failed' }, { workflow_version_run_frame_id: 'fRetry', type: 'retry', status: 'failed', parent_workflow_version_run_frame_id: 'fRoot' }] };
  if (/retry-pointers$/.test(p)) return { retried_to: [] };
  m = /\/frames\/([^/]+)\/block-executions$/.exec(p);
  if (m) return { value: EXECS[m[1]] };
  if (/outcome-data$/.test(p)) return { runtime_value: { __type: 'object', entries: { record: { __type: 'attio-entity-reference', entity_definition_id: 'o', entity_instance_id: 'i' }, n: { __type: 'number', value: 2 }, s: { __type: 'string', value: 'x' } } } };
  if (/\/retry$/.test(p)) return { workflow_version_run: { status: 'executing' }, retry_workflow_version_run_frame: { workflow_version_run_frame_id: body.retry_workflow_version_run_frame_id } };
  throw new Error(`unexpected ${method} ${p}`);
}
const tools = makeRunTools({ api, unwrap: (r) => (r && r.value !== undefined ? r.value : r), ctxFrom: () => ({ slug: 't' }), scoped: (props, req) => ({ properties: props, required: req }) });

let pass = 0; let fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log(`  PASS  ${name}`); } catch (e) { fail++; console.log(`  FAIL  ${name} — ${e.message}`); } }

(async () => {
  await t('list pages through every run with no duplicates', async () => {
    const r = await tools.list_workflow_runs.run({ workflow_id: W, limit: 5000 });
    assert.strictEqual(r.returned, 1203);
    assert.strictEqual(new Set(r.runs.map((x) => x.run_id)).size, 1203);
    assert.strictEqual(r.runs[0].number, 1203);
    assert.strictEqual(r.total_runs, 1203);
    assert.strictEqual(r.title, 'AI name');
  });
  await t('list filters status client-side and respects limit', async () => {
    const r = await tools.list_workflow_runs.run({ workflow_id: W, status: 'failed', limit: 3 });
    assert.strictEqual(r.returned, 3);
    assert.ok(r.runs.every((x) => x.status === 'failed'));
  });
  await t('list stops at since', async () => {
    const r = await tools.list_workflow_runs.run({ workflow_id: W, since: RUNS[9].created_at, limit: 5000 });
    assert.strictEqual(r.returned, 10);
  });
  await t('legacy workflow is refused with a pointer', async () => {
    await assert.rejects(tools.list_workflow_runs.run({ workflow_id: 'legacy' }), /legacy/);
  });
  await t('get reads the run on its own version, labels blocks, flattens outputs', async () => {
    calls.length = 0;
    const r = await tools.get_workflow_run.run({ workflow_id: W, run_id: 'r5', include_outputs: true });
    assert.ok(calls.some((c) => c.p.includes(`/versions/${V1}/runs/r5/frames`)), 'used the run\'s own version');
    assert.deepStrictEqual(r.steps.map((s) => [s.frame, s.block, s.status]), [['root', 'on-record-created', 'completed'], ['root', 'parse-json', 'failed'], ['retry', 'parse-json', 'failed']]);
    assert.deepStrictEqual(r.steps[0].output, { record: { type: 'attio-entity-reference', entity_definition_id: 'o', entity_instance_id: 'i' }, n: 2, s: 'x' });
    assert.strictEqual(r.steps[1].error, 'Missing required key "formKey" at formKey');
    assert.strictEqual(r.failed_steps, 2);
  });
  await t('get without outputs fetches no outcome-data', async () => {
    calls.length = 0;
    await tools.get_workflow_run.run({ workflow_id: W });
    assert.ok(!calls.some((c) => /outcome-data/.test(c.p)));
  });
  await t('retry previews by default and writes nothing', async () => {
    calls.length = 0;
    const r = await tools.retry_workflow_run.run({ workflow_id: W, run_id: 'r1' });
    assert.strictEqual(r.retried, false);
    assert.strictEqual(r.retry.execution_id, 'e3', 'targets the newest execution of the failed block');
    assert.ok(!calls.some((c) => c.method !== 'GET' && /retry$/.test(c.p)));
  });
  await t('retry with confirm posts fresh ids to the failed execution', async () => {
    calls.length = 0;
    const r = await tools.retry_workflow_run.run({ workflow_id: W, run_id: 'r1', confirm: true });
    const post = calls.find((c) => /\/retry$/.test(c.p));
    assert.ok(post.p.endsWith('/frames/fRetry/block-executions/e3/retry'));
    assert.match(post.body.retry_workflow_version_run_frame_id, /^[0-9a-f-]{36}$/);
    assert.notStrictEqual(post.body.retry_workflow_version_run_frame_id, post.body.retry_workflow_version_run_frame_block_execution_id);
    assert.strictEqual(r.retried, true);
    assert.strictEqual(r.run_status, 'executing');
  });
  await t('retry refuses a non-failed execution', async () => {
    await assert.rejects(tools.retry_workflow_run.run({ workflow_id: W, run_id: 'r1', execution_id: 'e1', confirm: true }), /completed, not failed/);
  });
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
