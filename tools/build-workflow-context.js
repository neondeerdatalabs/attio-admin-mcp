#!/usr/bin/env node
'use strict';
// Builds workflow-context.json from Erik Wood's attio toolkit (catalog, recipes,
// guides). Run when his library changes:
//   node tools/build-workflow-context.js ~/dev/erik-attio-toolkit-2026-11-06/attio [--public]
//
// What it keeps per capability: provider, inputs, outputs, claims (statement,
// evidence level, scope, date, limitations), gaps, constraints, and the example
// config inlined from his evidence file (the JSON pointer target only).
// Evidence file PATHS are dropped: they point into his repo, not this one.

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(SRC, 'catalog', 'capabilities'))) {
  console.error('usage: node tools/build-workflow-context.js <path to toolkit attio/ folder>');
  process.exit(1);
}
const OUT = path.join(__dirname, '..', 'workflow-context.json');
const MAX_EXAMPLE_BYTES = 12000; // keep the file small; bigger examples become a note

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readText = (p) => fs.readFileSync(p, 'utf8');

/** RFC 6901 pointer lookup. */
function pointer(doc, ptr) {
  if (!ptr || ptr === '/') return doc;
  return ptr.split('/').slice(1).reduce((o, raw) => {
    if (o == null) return undefined;
    const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    return o[k];
  }, doc);
}

/** Markdown link [text](relative/path) -> text, since the paths only exist in his repo. */
const unlink = (md) => md.replace(/\[([^\]]+)\]\((?!https?:)[^)]+\)/g, '$1');

// ------------------------------------------------------------ capabilities
const WANT = /^(workflow\.|variables\.workflow|filters\.)/;
const capabilities = {};
for (const f of fs.readdirSync(path.join(SRC, 'catalog', 'capabilities')).sort()) {
  if (!f.endsWith('.json') || !WANT.test(f)) continue;
  const d = readJson(path.join(SRC, 'catalog', 'capabilities', f));
  const examples = [];
  for (const e of d.examples || []) {
    const ev = e.evidence || {};
    let config;
    let note;
    if (ev.path && fs.existsSync(path.join(SRC, ev.path))) {
      try {
        const val = pointer(readJson(path.join(SRC, ev.path)), ev.pointer);
        const s = JSON.stringify(val);
        if (val === undefined) note = 'pointer target missing in source';
        else if (s.length > MAX_EXAMPLE_BYTES) note = `example omitted (${s.length} bytes); see Erik's toolkit ${ev.path}`;
        else config = val;
      } catch (err) { note = `unreadable: ${err.message}`; }
    } else if (ev.path) note = 'evidence file not in the toolkit export';
    examples.push({ title: e.title, reuse: e.reuse || null, ...(config !== undefined ? { config } : {}), ...(note ? { note } : {}) });
  }
  capabilities[d.id] = {
    id: d.id,
    title: d.title,
    summary: d.summary,
    keywords: d.keywords || [],
    providers: d.providers || [],
    inputs: d.inputs || {},
    outputs: d.outputs || {},
    claims: (d.claims || []).map((c) => ({
      statement: c.statement, evidence_level: c.status, scope: c.scope || null,
      verified_on: c.verified_on || null, limitations: c.limitations || [],
    })),
    gaps: d.gaps || [],
    constraints: d.constraints || [],
    examples,
  };
}

// ------------------------------------------------------- known-gaps sections
// known-gaps.md is one "## <capability title>" section per capability.
const knownGaps = {};
{
  const md = readText(path.join(SRC, 'guides', 'known-gaps.md'));
  const parts = md.split(/^## /m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    knownGaps[p.slice(0, nl).trim()] = unlink(p.slice(nl + 1).trim());
  }
}
for (const c of Object.values(capabilities)) {
  if (knownGaps[c.title]) c.known_gaps = knownGaps[c.title];
}

// ----------------------------------------------- block slug -> capability id
// System blocks: providers[].slug. Neon Deer app blocks: matched to this repo's
// app-blocks.json ids by title ("Neon Deer Call a subflow" -> "Call a subflow").
const bySlug = {};
for (const c of Object.values(capabilities)) {
  for (const p of c.providers) if (p.type === 'system' && p.slug) bySlug[p.slug] = c.id;
}
const appBlocks = (() => { try { return require('../app-blocks.json'); } catch { return { apps: {} }; } })();
const byAppBlock = {};
const norm = (s) => String(s || '').toLowerCase().replace(/^neon deer\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const appTitles = {};
for (const [appSlug, app] of Object.entries(appBlocks.apps || {})) {
  for (const [id, b] of Object.entries(app.blocks || {})) appTitles[`${b.type}:${norm(b.title)}`] = `${appSlug}/${id}`;
}
const unmatchedApp = [];
for (const c of Object.values(capabilities)) {
  const m = /^workflow\.app\.neondeer\.(step|trigger)\./.exec(c.id);
  if (!m) continue;
  const hit = appTitles[`${m[1]}:${norm(c.title)}`];
  if (hit) byAppBlock[hit] = c.id; else unmatchedApp.push(c.id);
}

// ------------------------------------------------------------------ recipes
// mcp_steps: which attio-admin tools carry out each recipe step. Written here,
// not by Erik; review when tools change.
const MCP_STEPS = {
  'find-aggregate-update': [
    'preflight: resolve the object, the numeric/currency attribute and the target attribute ids.',
    'create_workflow (record-updated or record-command trigger), then add_block guard, find-records, aggregate-values, update-record.',
    'list_block_outputs find-records: records feed aggregate-values.values via an attribute-definition operation; list_available_variables shows the exact matcher.',
    'set_block_config aggregate-values.aggregation_type: one of sum, mean, min, max ("average" saves but fails at runtime).',
    'set_block_config update-record: map done.total into the numeric/currency attribute.',
    'connect_blocks with outcome "done" between find, aggregate and update; guard also uses "done".',
    'get_workflow to read the whole graph back. The human activates it in the UI.',
  ],
  'http-parse-code': [
    'create_workflow, add_block send-http-request, parse-json, execute-code.',
    'set_block_config send-http-request (method, url, headers). Do not put secrets in Code inputs: evaluated inputs are logged.',
    'set_block_config parse-json.input from done.response_body, with a schema.',
    'execute-code inputs use the name/value/type wrapper; copy the shape from workflow_guide example, not a bare matcher.',
    'connect_blocks (outcome "done"), then get_workflow to verify.',
  ],
  'retry-with-live-workflow': [
    'No MCP tool reads run logs or triggers a retry. Use the Attio UI for runs and retries.',
    'After fixing the draft (set_block_config / update_block), the human publishes the new version, then retries from the original trigger execution.',
  ],
  'neon-deer-territory-routing': [
    'list_app_blocks workflow-utilities: confirm the app is installed and read its portal prerequisites (the lookup table must exist in the Neon Deer portal).',
    'describe_app_block c-lookup-row-find for its config keys.',
    'add_block the lookup step, then update-record to set owner/territory, then an optional Slack send-message.',
    'Slack: a config can read "complete" with no channel set; check channelId explicitly.',
    'get_workflow to verify. Not independently runtime-tested.',
  ],
  'neon-deer-subflow': [
    'Child: create_workflow with the Start a subflow trigger (j-subflow-start); end with Return from a subflow (j-subflow-return).',
    'Parent: add_block Call a subflow (j-subflow-run); app_workflow_target gives the workflow_id format it needs.',
    'Records pass as a typed record; named inputs and returns are TEXT. Use Find workspace member (c-member-find) to turn an email back into a member.',
    'describe_app_block each block for keys; get_workflow both workflows to verify.',
  ],
};
const recipes = {};
{
  const idx = readJson(path.join(SRC, 'recipes', 'index.json'));
  for (const r of idx.recipes) {
    recipes[r.id] = {
      id: r.id,
      title: (readText(path.join(SRC, r.path)).match(/^# (.+)$/m) || [])[1] || r.id,
      evidence_level: r.status,
      capabilities: r.capabilities,
      mcp_steps: MCP_STEPS[r.id] || [],
      body: unlink(readText(path.join(SRC, r.path))),
    };
  }
}

// ------------------------------------------------------------------- guides
const GUIDES = ['workflows', 'workflow-blocks', 'variables', 'filters', 'neon-deer-automations'];
const guides = {};
for (const g of GUIDES) {
  const p = path.join(SRC, 'guides', `${g}.md`);
  if (fs.existsSync(p)) guides[g] = unlink(readText(p));
}

// ------------------------------------------------------------- --public
// The public repo gets a scrubbed copy: no production-review capability
// (it indexes client workflows), client names and emails replaced, and every
// uuid swapped for a stable placeholder so example shapes still line up.
const PUBLIC = process.argv.includes('--public');
if (PUBLIC) {
  for (const id of Object.keys(capabilities)) if (/production-review/.test(id)) delete capabilities[id];
  for (const r of Object.values(recipes)) r.capabilities = r.capabilities.filter((id) => capabilities[id]);
}

const out = {
  _source: "Erik Wood's attio toolkit (catalog, recipes, guides), exported 2026-11-06. Rebuild with tools/build-workflow-context.js.",
  _evidence_levels: {
    'effect-verified': 'Ran, and the resulting record/task/note change was read back independently.',
    'runtime-verified': 'Ran in a test workflow; outputs observed. Effect not independently read back.',
    'config-verified': 'Config saved and read back. Not run.',
    'ui-observed': 'Seen in the Attio editor only.',
    documented: 'From vendor documentation; not tested here.',
    unresolved: 'Evidence conflicts or is incomplete; treat as unknown.',
  },
  capabilities,
  block_index: { system: bySlug, app: byAppBlock },
  recipes,
  guides,
};
let text = JSON.stringify(out, null, 1);
if (PUBLIC) {
  const ids = new Map();
  text = text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) => {
      if (!ids.has(u.toLowerCase())) ids.set(u.toLowerCase(), `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`);
      return ids.get(u.toLowerCase());
    })
    .replace(/[A-Za-z0-9._%+-]+@neondeerdata\.com/g, 'user@example.com')
    .replace(/production-review/g, 'internal-review')
    .replace(/luna-[ab]\//g, '');
  // Client names live outside the repo: one per line in ~/.attio-scrub-terms
  // (or comma-separated in SCRUB_TERMS). Longest first so phrases win.
  const termFile = path.join(require('os').homedir(), '.attio-scrub-terms');
  const terms = (process.env.SCRUB_TERMS || (fs.existsSync(termFile) ? readText(termFile) : ''))
    .split(/[,\n]/).map((t) => t.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!terms.length) { console.error('--public needs ~/.attio-scrub-terms or SCRUB_TERMS'); process.exit(1); }
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const t of terms) text = text.replace(new RegExp(`\\b${esc(t)}\\b`, 'gi'), 'a client');
  const leftover = text.match(new RegExp(`\\b(${terms.map(esc).join('|')})\\b|luna-[ab]`, 'gi'));
  if (leftover) { console.error('public scrub left:', [...new Set(leftover)].join(', ')); process.exit(1); }
}
fs.writeFileSync(OUT, text + '\n');
const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`wrote ${OUT} (${kb} KB): ${Object.keys(capabilities).length} capabilities, ` +
  `${Object.keys(bySlug).length} system blocks, ${Object.keys(byAppBlock).length} app blocks, ` +
  `${Object.keys(recipes).length} recipes, ${Object.keys(guides).length} guides`);
if (unmatchedApp.length) console.log('app capabilities with no app-blocks.json match:', unmatchedApp.join(', '));
