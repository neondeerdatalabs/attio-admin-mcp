/**
 * Harvest block INPUT/OUTPUT schemas from legacy workflow snapshots.
 *
 * Legacy (pre-modern) workflows store their definition as snapshots, and every
 * snapshot node carries the block's own `schema` with real `inputs` and
 * `outputs` slugs. That is the only place Attio serves this over the API, so
 * legacy workflows are the highest-quality source of block output names.
 *
 * Nodes are keyed to the block catalog by block.workflow_block_id, so the
 * mapping to a slug is exact rather than inferred.
 *
 * Usage: node harvest-legacy-schemas.js [--profile name] > legacy-schemas.json
 */
const { spawn } = require('child_process');
const argv = process.argv.slice(2);
const pi = argv.indexOf('--profile');
const PROFILE = pi !== -1 ? argv[pi + 1] : undefined;

const child = spawn('node', [__dirname + '/server.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const waiters = new Map();
child.stdout.on('data', (c) => {
  buf += c; let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); }
  }
});
let nextId = 1;
const rpc = (method, params) => new Promise((r) => {
  const id = nextId++; waiters.set(id, r);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
async function call(name, args = {}) {
  if (PROFILE) args = { ...args, profile: PROFILE };
  const res = await rpc('tools/call', { name, arguments: args });
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  return JSON.parse(res.result.content[0].text);
}

(async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05' });
  const ws = await call('list_workspaces');
  const slugs = ws.workspaces.map((w) => w.slug);
  console.error(`workspaces: ${slugs.join(', ')}`);

  const out = {};
  let legacySeen = 0;

  for (const slug of slugs) {
    let list, catalog;
    try { list = await call('list_workflows', { workspace_slug: slug }); }
    catch (e) { console.error(`  ${slug}: SKIP (${String(e.message).slice(0, 70)})`); continue; }
    try { catalog = await call('list_blocks', { workspace_slug: slug }); }
    catch { catalog = { blocks: [] }; }
    // exact mapping: catalog id -> slug used in configs
    const idToSlug = {};
    for (const b of catalog.blocks) idToSlug[b.workflow_block_id] = b.block_slug || b.system_block_type;

    let n = 0;
    for (const w of list.workflows || []) {
      let full;
      try { full = await call('get_workflow', { workspace_slug: slug, workflow_id: w.workflow_id }); }
      catch { continue; }
      if (!full.legacy) continue;
      n++; legacySeen++;
      for (const b of full.definition.blocks) {
        const id = b.block && b.block.workflow_block_id;
        const key = idToSlug[id] || `unknown:${String(id).slice(0, 8)}`;
        if (!b.outputs || !b.outputs.length) continue;
        out[key] = out[key] || { outputs: {}, inputs: {}, seen: 0, catalog_id: id };
        out[key].seen++;
        for (const o of b.outputs) {
          // per-record attribute outputs are uuids, not reusable field names
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(o.slug || '')) continue;
          out[key].outputs[o.slug] = { title: o.title || null, data_types: o.data_types || null };
        }
        for (const i of b.inputs || []) {
          if (/^attribute_[0-9a-f]{8}-/.test(i.slug || '')) continue;
          out[key].inputs[i.slug] = { title: i.title || null };
        }
      }
    }
    console.error(`  ${slug}: ${n} legacy workflows`);
  }

  console.error(`\nlegacy workflows read: ${legacySeen}`);
  console.error(`blocks with a server-provided schema: ${Object.keys(out).length}`);
  for (const [k, v] of Object.entries(out))
    console.error(`  ${k.padEnd(28)} outputs=[${Object.keys(v.outputs).join(', ')}]`);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  child.stdin.end(); process.exit(0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
