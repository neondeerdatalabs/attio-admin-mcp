/**
 * Harvest the CONFIG KEY NAMES of every block in every reachable workspace,
 * split by engine (modern vs legacy). Everything here was written by Attio's
 * own UI, so it is the authoritative answer to "what is this block's input
 * actually called" — the question `config_state: complete` cannot answer.
 *
 * Output carries block names, counts and value types — never workspace slugs or
 * workflow titles. The corpus is committed, and naming a client's workflows in it
 * would leak them to anyone with repo access. To chase down a concrete example,
 * re-run locally and grep the workspace yourself.
 *
 * App-provided blocks (Slack, lemlist, …) ARE included, because their config keys
 * are unobtainable anywhere else and matter the moment a client runs that tool.
 * Their installation-specific provider ids are not recorded — see _app_note.
 *
 * Usage: node harvest-config-keys.js [--profile name] > config-keys.json
 */
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const pIdx = argv.indexOf('--profile');
const PROFILE = pIdx !== -1 ? argv[pIdx + 1] : undefined;

const child = spawn('node', [__dirname + '/server.js'], { stdio: ['pipe', 'pipe', 'inherit'] });

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

/** Unwrap either a bare {type,entries} node or a {state,value} wrapper. */
function entriesOf(config) {
  if (!config || typeof config !== 'object') return null;
  const node = config.value && config.value.entries ? config.value : config;
  return node && node.entries && typeof node.entries === 'object' ? node.entries : null;
}

(async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05' });

  const ws = await call('list_workspaces');
  const slugs = (ws.workspaces || ws || []).map((w) => w.slug || w).filter(Boolean);
  console.error(`workspaces: ${slugs.join(', ')}`);

  const corpus = {};
  let wfSeen = 0, blockSeen = 0, unreadable = 0, appSeen = 0;

  for (const slug of slugs) {
    let list;
    try { list = await call('list_workflows', { workspace_slug: slug }); }
    catch (e) { console.error(`  ${slug}: SKIP (${e.message})`); continue; }

    const wfs = list.workflows || [];
    console.error(`  ${slug}: ${wfs.length} workflows`);

    for (const w of wfs) {
      let full;
      try { full = await call('get_workflow', { workspace_slug: slug, workflow_id: w.workflow_id }); }
      catch (e) { unreadable++; console.error(`    UNREADABLE ${w.title || w.workflow_id}: ${String(e.message).slice(0, 100)}`); continue; }
      wfSeen++;

      // engine: modern workflows carry versions; legacy ones are read from a snapshot
      const meta = full.workflow || full;
      const engine = (meta.is_modern === false || full.source === 'snapshot' || full.engine === 'legacy')
        ? 'legacy' : 'modern';

      for (const b of full.definition?.blocks || []) {
        const p = b.provider || {};
        blockSeen++;

        // App-provided blocks ARE included, keyed by app_block_id. Knowing that
        // "send-message" takes channelId/message matters the moment a client runs
        // Slack, and there is no other source for it. What is NOT recorded is
        // provider.app_id or provider.app_user_connection_membership_id: those are
        // installation-specific, unverified as portable across workspaces, and must
        // be read from the target workspace's own installed app. See app_note below.
        const isApp = p.type === 'app' || (!p.system_block_slug && p.app_block_id);
        if (isApp) appSeen++;

        const slugName = p.system_block_slug || p.app_block_id || p.type || 'unknown';
        const ver = p.system_block_version || null;
        const key = `${engine}:${b.block_type}:${isApp ? 'app:' : ''}${slugName}${ver ? '@' + ver : ''}`;

        corpus[key] = corpus[key] || {
          engine, block_type: b.block_type, slug: slugName, version: ver,
          provider: isApp ? 'app' : 'system',
          seen: 0, config_keys: {}, empty_configs: 0,
        };
        const rec = corpus[key];
        rec.seen++;

        const entries = entriesOf(b.config);
        if (!entries || !Object.keys(entries).length) { rec.empty_configs++; continue; }

        for (const [k, v] of Object.entries(entries)) {
          rec.config_keys[k] = rec.config_keys[k] || { count: 0, value_types: {} };
          const ck = rec.config_keys[k];
          ck.count++;
          const vt = (v && v.type) || typeof v;
          ck.value_types[vt] = (ck.value_types[vt] || 0) + 1;
        }
      }
    }
  }

  console.error(`\nscanned ${wfSeen} workflows (${unreadable} unreadable), ${blockSeen} blocks`);
  console.error(`app-provided blocks included: ${appSeen}`);
  console.error(`distinct block signatures: ${Object.keys(corpus).length}`);

  const out = {
    _note: 'Top-level config keys per block, harvested from configs Attio\'s own UI wrote. ' +
           'Counts and value types only: no workspace slugs and no workflow titles. ' +
           'Modern engine only; legacy blocks arrive via the snapshot path in a different shape.',
    _app_note: 'Entries with provider "app" come from installed integrations and only apply to a ' +
               'workspace that has that app installed. Their config keys are portable; their ' +
               'provider ids are NOT. app_id and app_user_connection_membership_id are deliberately ' +
               'not recorded here - read them from the target workspace\'s own installation.',
    _scanned: { workflows: wfSeen, blocks: blockSeen, app_blocks: appSeen, unreadable: unreadable },
    blocks: corpus,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  child.stdin.end();
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
