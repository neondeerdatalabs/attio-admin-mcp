'use strict';
// Offline tests for workflow_guide and the reference data folded into the
// block tools. Talks to server.js over stdio; no workspace calls.
// Run: node test-workflow-context.js
const assert = require('assert');
const { spawn } = require('child_process');

const p = spawn('node', [__dirname + '/server.js']);
let buf = '';
const waiting = new Map();
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const w = waiting.get(m.id);
    if (w) { waiting.delete(m.id); w(m); }
  }
});
let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name, args) {
  const m = await rpc('tools/call', { name, arguments: args });
  if (m.error) throw new Error(m.error.message);
  return JSON.parse(m.result.content[0].text);
}

let pass = 0; let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); } catch (e) { fail++; console.log(`  FAIL  ${name} — ${e.message}`); }
}

(async () => {
  await t('initialize carries the workflow build rules', async () => {
    const m = await rpc('initialize', {});
    assert.match(m.result.instructions, /preflight/);
    assert.match(m.result.instructions, /workflow_guide/);
  });
  await t('tools/list includes workflow_guide', async () => {
    const m = await rpc('tools/list', {});
    assert.ok(m.result.tools.some((x) => x.name === 'workflow_guide'));
  });
  await t('index: rules, 5 recipes, system and app blocks', async () => {
    const r = await call('workflow_guide', {});
    assert.ok(r.rules.length >= 8);
    assert.strictEqual(r.recipes.length, 5);
    assert.ok(r.system_blocks.length >= 25, `system ${r.system_blocks.length}`);
    assert.ok(r.neon_deer_app_blocks.length >= 30, `app ${r.neon_deer_app_blocks.length}`);
  });
  await t('block by slug: aggregate-values has evidence, gaps and an inlined example', async () => {
    const r = await call('workflow_guide', { block: 'aggregate-values@v2' });
    assert.strictEqual(r.capability, 'workflow.block.aggregate-values');
    assert.strictEqual(r.evidence, 'runtime-verified');
    assert.ok(r.gaps.length);
    assert.ok(r.examples.some((e) => e.config), 'no inlined config');
    assert.deepStrictEqual(r.recipes, ['find-aggregate-update']);
  });
  await t('block by app id: j-subflow-run maps to Call a subflow', async () => {
    const r = await call('workflow_guide', { block: 'j-subflow-run' });
    assert.strictEqual(r.capability, 'workflow.app.neondeer.step.call-subflow');
  });
  await t('recipe returns mcp_steps naming real tools', async () => {
    const r = await call('workflow_guide', { recipe: 'find-aggregate-update' });
    const tools = (await rpc('tools/list', {})).result.tools.map((x) => x.name);
    const named = r.mcp_steps.join(' ').match(/\b[a-z]+_[a-z_]+\b/g).filter((w) => tools.includes(w));
    assert.ok(named.includes('add_block') && named.includes('connect_blocks') && named.includes('get_workflow'));
    assert.strictEqual(r.blocks.length, 4);
  });
  await t('search ranks the obvious block first', async () => {
    assert.strictEqual((await call('workflow_guide', { query: 'loop records' })).capabilities[0].capability, 'workflow.block.for-each');
    assert.strictEqual((await call('workflow_guide', { query: 'aggregate average' })).capabilities[0].capability, 'workflow.block.aggregate-values');
  });
  await t('guide returns full text', async () => {
    const r = await call('workflow_guide', { guide: 'variables' });
    assert.match(r.text, /done\.total/);
  });
  await t('unknown block is an error that says untested, not invalid', async () => {
    await assert.rejects(call('workflow_guide', { block: 'nope' }), /untested here, not invalid/);
  });
  await t('describe_app_block carries a reference', async () => {
    const r = await call('describe_app_block', { app_block_id: 'c-lookup-row-find' });
    assert.strictEqual(r.reference.capability, 'workflow.app.neondeer.step.find-lookup-table-row');
  });
  await t('list_block_outputs adds reference outputs', async () => {
    const r = await call('list_block_outputs', { block_slug: 'formula' });
    assert.ok(r.reference_outputs['done.result']);
  });
  await t('every recipe capability resolves', async () => {
    for (const id of ['find-aggregate-update', 'http-parse-code', 'retry-with-live-workflow', 'neon-deer-territory-routing', 'neon-deer-subflow']) {
      const r = await call('workflow_guide', { recipe: id });
      assert.ok(r.blocks.every((b) => b.title), `${id}: ${JSON.stringify(r.blocks.filter((b) => !b.title))}`);
      assert.ok(r.mcp_steps.length, `${id} has no mcp_steps`);
    }
  });
  console.log(`\n  ${pass} passed, ${fail} failed`);
  p.kill();
  process.exit(fail ? 1 : 0);
})();
