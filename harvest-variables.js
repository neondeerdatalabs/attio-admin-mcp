/**
 * Harvest every `variable` node from every workflow in every reachable
 * workspace, and index them by the UPSTREAM block that produced them.
 *
 * Output: a corpus of "block slug X, outcome Y, exposes operations path Z",
 * built entirely from configs Attio's own UI wrote. Nothing here is guessed.
 *
 * Usage: node harvest-variables.js [--profile name] > variable-corpus.json
 */
const { spawn } = require('child_process');
const fs = require('fs');

const argv = process.argv.slice(2);
const profileIdx = argv.indexOf('--profile');
const PROFILE = profileIdx !== -1 ? argv[profileIdx + 1] : undefined;

const child = spawn('node', [__dirname + '/server.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const waiters = new Map();
child.stdout.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name, args = {}) {
  if (PROFILE) args = { ...args, profile: PROFILE };
  const res = await rpc('tools/call', { name, arguments: args });
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  return JSON.parse(res.result.content[0].text);
}

/** Walk any config AST and yield every {type:"variable"} node found. */
function findVariables(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => findVariables(n, out)); return out; }
  if (node.type === 'variable' && Array.isArray(node.matchers)) out.push(node);
  for (const v of Object.values(node)) findVariables(v, out);
  return out;
}

/** Render an operations[] path as a readable dotted string. */
function pathOf(ops) {
  return (ops || []).map((o) => {
    if (o.type === 'field') return o.name;
    if (o.type === 'attribute-definition') return `{attribute:${o.attribute_definition_id}}`;
    return `{${o.type}}`;
  }).join('.');
}

(async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05' });

  const ws = await call('list_workspaces');
  const slugs = (ws.workspaces || ws || []).map((w) => w.slug || w).filter(Boolean);
  console.error(`workspaces: ${slugs.join(', ')}`);

  // upstream block signature -> observed usages
  const corpus = {};
  let wfSeen = 0, varSeen = 0;

  for (const slug of slugs) {
    let list;
    try { list = await call('list_workflows', { workspace_slug: slug }); }
    catch (e) { console.error(`  ${slug}: SKIP (${e.message})`); continue; }

    const wfs = list.workflows || [];
    console.error(`  ${slug}: ${wfs.length} workflows`);

    for (const w of wfs) {
      let full;
      try { full = await call('get_workflow', { workspace_slug: slug, workflow_id: w.workflow_id }); }
      catch (e) { console.error(`    UNREADABLE ${w.title || w.workflow_id}: ${String(e.message).slice(0, 110)}`); continue; }
      wfSeen++;

      const blocks = full.definition?.blocks || [];
      // block_instance_id -> descriptive slug, so variables can name their source
      const byId = {};
      for (const b of blocks) {
        const p = b.provider || {};
        byId[b.block_id] = {
          slug: p.system_block_slug || p.app_block_slug || p.type || 'unknown',
          version: p.system_block_version || p.app_block_version || null,
          block_type: b.block_type,
        };
      }

      for (const b of blocks) {
        for (const v of findVariables(b.config)) {
          for (const m of v.matchers || []) {
            const src = byId[m.block_instance_id];
            if (!src) continue; // reference to a block not in this version
            varSeen++;
            const key = `${src.block_type}:${src.slug}${src.version ? '@' + src.version : ''}`;
            corpus[key] = corpus[key] || { block_type: src.block_type, slug: src.slug, version: src.version, outcomes: {}, paths: {} };
            const oc = m.outcome || '(none)';
            corpus[key].outcomes[oc] = (corpus[key].outcomes[oc] || 0) + 1;
            const p = pathOf(m.operations) || '(root)';
            corpus[key].paths[p] = corpus[key].paths[p] || { count: 0, outcome: oc, as: v.as ? v.as.type : null, example_workspace: slug, example_workflow: full.title };
            corpus[key].paths[p].count++;
          }
        }
      }
    }
  }

  console.error(`\nscanned ${wfSeen} workflows, found ${varSeen} variable references`);
  console.error(`distinct producing blocks: ${Object.keys(corpus).length}`);
  process.stdout.write(JSON.stringify(corpus, null, 2) + '\n');
  child.stdin.end();
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
