#!/usr/bin/env node
/**
 * attio-admin-mcp
 *
 * MCP server for Attio's internal admin API — workspace configuration that the
 * public Attio API does not expose: workflows, views and their filters,
 * select-option colours and order, and record-page layouts.
 *
 * Auth is a browser session cookie. Attio API keys are rejected by this API
 * (verified: 401 "invalid authentication token"), so there is no token option.
 *
 * A cookie authenticates a USER, and therefore reaches exactly the workspaces
 * that user belongs to. To reach a different Attio ACCOUNT you need a second
 * cookie — see "profiles" below.
 *
 * Credentials:
 *   ~/.attio-session              default profile
 *   ~/.attio-session-<profile>    additional accounts, selected via `profile`
 *   ATTIO_SESSION_COOKIE          overrides the default profile
 *   ATTIO_SESSION_FILE            overrides the default profile's path
 *
 * Workspace:
 *   ATTIO_WORKSPACE_SLUG          default slug
 *   every tool also takes an optional `workspace_slug`
 *
 * Safety model: this server has NO publish/activate tool. Every write targets
 * draft_workflow_version_id, while a live workflow runs active_workflow_version_id,
 * so editing a live workflow stages changes without affecting what is running.
 * Publishing stays a deliberate human action in the Attio UI. Deleting a live
 * workflow is the one destructive case and requires an explicit confirm.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID, createHash } = require('crypto');

const ROOT = 'https://app.attio.com/api/common';
const DEFAULT_SLUG = process.env.ATTIO_WORKSPACE_SLUG || '';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ profiles

const cookieCache = new Map();

function sessionPath(profile) {
  if (!profile) return process.env.ATTIO_SESSION_FILE || path.join(os.homedir(), '.attio-session');
  return path.join(os.homedir(), `.attio-session-${profile}`);
}

function cookieFor(profile) {
  const key = profile || '__default__';
  if (cookieCache.has(key)) return cookieCache.get(key);

  let cookie = '';
  if (!profile && process.env.ATTIO_SESSION_COOKIE) {
    cookie = process.env.ATTIO_SESSION_COOKIE.trim();
  } else {
    const p = sessionPath(profile);
    try {
      cookie = fs.readFileSync(p, 'utf8').trim();
      try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
    } catch {
      const hint = profile
        ? `No cookie for profile "${profile}". Expected a file at ${p}.`
        : `No session cookie found. Expected ${p}, or set ATTIO_SESSION_COOKIE.`;
      throw new Error(`${hint} See README for how to capture one.`);
    }
  }
  if (!cookie) throw new Error(`Session file ${sessionPath(profile)} is empty.`);
  cookieCache.set(key, cookie);
  return cookie;
}

/** List profiles that actually have a cookie file present. */
function availableProfiles() {
  const out = [];
  try {
    if (fs.existsSync(sessionPath(null))) out.push('(default)');
    for (const f of fs.readdirSync(os.homedir())) {
      const m = f.match(/^\.attio-session-(.+)$/);
      if (m) out.push(m[1]);
    }
  } catch { /* ignore */ }
  return out;
}

/** Decode the session JWT so expiry is a fact, not a guess. */
function sessionInfo(cookie) {
  const m = cookie.match(/attio-session=([^;]+)/);
  if (!m) return { present: false };
  try {
    const p = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString());
    const daysLeft = (p.exp * 1000 - Date.now()) / 86400000;
    return {
      present: true,
      user_id: p.sub,
      session_id: p.sid,
      issued_at: new Date(p.iat * 1000).toISOString(),
      expires_at: new Date(p.exp * 1000).toISOString(),
      lifetime_days: Math.round((p.exp - p.iat) / 86400),
      days_remaining: Number(daysLeft.toFixed(1)),
      expired: daysLeft <= 0,
    };
  } catch {
    return { present: true, parse_error: true };
  }
}

// ---------------------------------------------------------------- http layer

/** Resolve the {slug, cookie} context for a tool call. */
function ctxFrom(args = {}) {
  const slug = args.workspace_slug || DEFAULT_SLUG;
  if (!slug) {
    throw new Error(
      'No workspace slug. Pass workspace_slug, or set ATTIO_WORKSPACE_SLUG. ' +
      'Use list_workspaces to see what this session can reach.'
    );
  }
  return { slug, cookie: cookieFor(args.profile), profile: args.profile || null };
}

async function raw(url, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      cookie,
      ...(body ? { 'content-type': 'application/json' } : {}),
      // Required on every non-GET request. Without it Attio returns 403.
      origin: 'https://app.attio.com',
      'user-agent': 'attio-admin-mcp/4.0',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const ct = res.headers.get('content-type') || '';
  const text = await res.text();

  // 204 No Content is a legitimate success (DELETE returns it).
  if (res.status === 204 || (res.ok && text === '')) return null;

  if (!ct.includes('json')) {
    if (res.status === 401 || text.includes('Unauthorized')) {
      throw new Error('401 Unauthorized — session cookie expired or wrong. Re-capture it.');
    }
    throw new Error(
      `Non-JSON response (HTTP ${res.status}) from ${url}. ` +
      `Usually means the path does not exist and the SPA served HTML.`
    );
  }

  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = json && Object.keys(json).length ? JSON.stringify(json) : '(empty body)';
    let hint = '';
    if (res.status === 400) {
      hint = ' — Attio returns 400 with no detail. Check: config missing; id fields present ' +
             'in body; config wrapped as {state,value} instead of the bare node; wrong system_block_version.';
    }
    if (res.status === 401) hint = ' — session cookie expired. Re-capture it.';
    if (res.status === 403) hint = ' — missing/incorrect Origin header, or this session lacks access.';
    if (res.status === 409) hint = ' — already exists. PUT on a block instance is create-only; use set_block_config.';
    throw new Error(`HTTP ${res.status} on ${method} ${url}: ${detail}${hint}`);
  }
  return json;
}

async function api(p, { method = 'GET', body, ctx } = {}) {
  try {
    return await raw(`${ROOT}/workspaces/${ctx.slug}${p}`, { method, body, cookie: ctx.cookie });
  } catch (err) {
    // A slug this session can't see fails confusingly. Say so plainly.
    if (/HTTP 40[34]/.test(err.message)) {
      let reachable = null;
      try {
        const ws = await raw(`${ROOT}/workspaces`, { cookie: ctx.cookie });
        reachable = ws.map((w) => (w.workspace || w).slug);
      } catch { /* ignore */ }
      if (reachable && !reachable.includes(ctx.slug)) {
        throw new Error(
          `Workspace "${ctx.slug}" is not reachable by this session` +
          `${ctx.profile ? ` (profile "${ctx.profile}")` : ''}. ` +
          `That cookie can reach: ${reachable.join(', ')}. ` +
          `A cookie authenticates one Attio ACCOUNT — to use a workspace on a different ` +
          `account, capture that account's cookie into ~/.attio-session-<profile> and pass profile.`
        );
      }
    }
    throw err;
  }
}

const unwrap = (r) => (r && r.value !== undefined ? r.value : r);

// ------------------------------------------------------------ domain helpers

const getWorkflow = (id, ctx) => api(`/workflows/${id}`, { ctx });

/**
 * Resolve the draft version to write into.
 *
 * Editing a LIVE workflow is allowed: every write in this server targets
 * draft_workflow_version_id, and the running automation uses
 * active_workflow_version_id. So edits never change what is currently running.
 * They stage changes that a human publishes later, in the Attio UI.
 */
async function draftTarget(id, ctx) {
  const wf = await getWorkflow(id, ctx);
  if (!wf.draft_workflow_version_id) {
    throw new Error(
      `Workflow "${wf.title}" has no draft version to write into` +
      `${wf.is_modern === false ? ' (is_modern is false — legacy workflow, unsupported)' : ''}.`
    );
  }
  return wf;
}

/** Surfaced on every write so editing a live workflow is never silent. */
function liveNote(wf) {
  return wf.status === 'live'
    ? {
        editing_live_workflow: true,
        note:
          `"${wf.title}" is LIVE. This change went to the DRAFT version, so the running ` +
          `automation is unaffected. It will only take effect if someone publishes in the Attio UI.`,
      }
    : {};
}

function readVersionOf(wf) {
  const v = wf.active_workflow_version_id || wf.draft_workflow_version_id;
  if (!v) {
    throw new Error(
      `Workflow ${wf.workflow_id} has no version. If you just created it, ` +
      `you probably omitted is_modern:true.`
    );
  }
  return v;
}

/**
 * List workflow ids. The body must be an ARRAY and `sort` is mandatory
 * (omitting it returns 400 with an empty body). The response is keyed by the
 * query id and triple-nested: [id].value.value is the id array.
 */
async function queryWorkflowIds(ctx, { includeArchived = false } = {}) {
  const qid = 'q';
  const res = await api('/workflows/batch-query-mrl', {
    method: 'POST',
    ctx,
    body: [{
      id: qid,
      filters: includeArchived ? []
        : [{ field: 'status', operator: 'eq', mode: 'must-not', value: 'archived' }],
      sort: { field: 'last_published_at', direction: 'desc', isDefault: true },
    }],
  });
  return res?.[qid]?.value?.value ?? [];
}

async function readDefinition(workflowId, versionId, ctx) {
  const V = `/workflows/${workflowId}/versions/${versionId}`;
  const blocks = unwrap(await api(`${V}/block-instances`, { ctx }));
  const paths = unwrap(await api(`${V}/paths`, { ctx }));

  let configs = {};
  if (blocks.length) {
    configs = await api(`${V}/block-instances/batch-get-config`, {
      method: 'POST', ctx,
      body: { workflow_version_block_instance_ids: blocks.map((b) => b.workflow_version_block_instance_id) },
    });
  }

  return {
    version_id: versionId,
    blocks: blocks.map((b) => ({
      block_id: b.workflow_version_block_instance_id,
      block_type: b.block_type,
      provider: b.provider,
      description: b.description,
      position: b.position,
      // batch-get-config nests one level deeper than the single-config GET
      config: configs[b.workflow_version_block_instance_id]?.value?.config?.value ?? null,
      config_state: configs[b.workflow_version_block_instance_id]?.value?.config?.state ?? null,
    })),
    paths: paths.map((p) => ({
      path_id: p.workflow_version_path_id,
      source_block_id: p.source.workflow_version_block_instance_id,
      outcome: p.source.outcome,
      target_block_id: p.target.workflow_version_block_instance_id,
    })),
  };
}

function remapIds(node, idMap) {
  let s = JSON.stringify(node);
  for (const [oldId, newId] of Object.entries(idMap)) s = s.split(oldId).join(newId);
  return JSON.parse(s);
}

// Every tool accepts these two.
const SCOPE_PROPS = {
  workspace_slug: { type: 'string', description: 'Defaults to ATTIO_WORKSPACE_SLUG.' },
  profile: { type: 'string', description: 'Cookie profile for a different Attio account: reads ~/.attio-session-<profile>.' },
};
const scoped = (props = {}, required = []) => ({
  type: 'object',
  properties: { ...props, ...SCOPE_PROPS },
  ...(required.length ? { required } : {}),
});


// ------------------------------------------------------- variable wiring
//
// Attio's UI has a variable picker: pick an upstream step, pick one of its
// output fields, and it writes a {"type":"variable"} node into the config.
// Headless callers need the same information. There is no schema endpoint
// that describes block outputs, so BLOCK_OUTPUTS is a corpus harvested from
// real workflows Attio's own UI wrote (see harvest-variables.js). It is
// observational: absence of a field here means "never seen", not "invalid".

const BLOCK_OUTPUTS = (() => {
  try { return require('./block-outputs.json'); } catch { return {}; }
})();

// Legacy snapshots are the ONE place Attio serves block schemas over the API.
// Kept separate from BLOCK_OUTPUTS because the two engines do not always agree
// on field names (legacy "record" vs modern "entity_instance").
const LEGACY_SCHEMAS = (() => {
  try { return require('./legacy-block-schemas.json'); } catch { return { blocks: {} }; }
})();

// ------------------------------------------------------------- app blocks
//
// App-provided blocks are absent from GET /workflow-blocks. Installed apps and
// their block slugs come from GET /apps (.surfaces); schemas for apps whose
// SOURCE we have (Neon Deer's) come from app-blocks.json, which also records
// what must exist in the Neon Deer portal before a block works. See
// docs/neon-deer-apps.md.

const APP_BLOCKS = (() => {
  try { return require('./app-blocks.json'); } catch { return { apps: {} }; }
})();

/** Corpus entry for an app_block_id, optionally pinned to an app slug. */
function findAppBlock(appBlockId, appSlug) {
  for (const [slug, app] of Object.entries(APP_BLOCKS.apps || {})) {
    if (appSlug && slug !== appSlug) continue;
    const block = app.blocks && app.blocks[appBlockId];
    if (block) return { slug, app, block };
  }
  return null;
}

// -------------------------------------------------------- workflow context
//
// Block references, recipes and guides from Erik Wood's attio toolkit, built by
// tools/build-workflow-context.js. Each claim carries an evidence level
// (effect-verified > runtime-verified > config-verified > ui-observed >
// documented). Served by workflow_guide and folded into the block tools.

const WF_CONTEXT = (() => {
  try { return require('./workflow-context.json'); } catch { return { capabilities: {}, block_index: { system: {}, app: {} }, recipes: {}, guides: {} }; }
})();

const EVIDENCE_RANK = ['effect-verified', 'runtime-verified', 'config-verified', 'ui-observed', 'documented', 'unresolved'];

/** Strongest evidence level across a capability's claims. */
function bestEvidence(cap) {
  const levels = (cap.claims || []).map((c) => c.evidence_level);
  return EVIDENCE_RANK.find((l) => levels.includes(l)) || null;
}

/** Capability for a system block slug ("find-records", "find-records@v1", "step-find-records"). */
function capForSystemBlock(slug) {
  const bare = String(slug || '').split('@')[0].replace(/^(trigger|step)-/, '');
  const id = WF_CONTEXT.block_index.system[bare];
  return id ? WF_CONTEXT.capabilities[id] : null;
}

/** Capability for an app block id (optionally pinned to an app slug). */
function capForAppBlock(appBlockId, appSlug) {
  const idx = WF_CONTEXT.block_index.app;
  const key = appSlug ? `${appSlug}/${appBlockId}` : Object.keys(idx).find((k) => k.split('/')[1] === appBlockId);
  return key && idx[key] ? WF_CONTEXT.capabilities[idx[key]] : null;
}

/** Compact reference block for tool responses. */
function capReference(cap, { examples = false } = {}) {
  if (!cap) return null;
  return {
    capability: cap.id,
    evidence: bestEvidence(cap),
    claims: cap.claims.map((c) => ({ statement: c.statement, evidence_level: c.evidence_level, scope: c.scope, limitations: c.limitations })),
    gaps: cap.gaps,
    known_gaps: cap.known_gaps || null,
    reference_inputs: cap.inputs,
    reference_outputs: cap.outputs,
    ...(examples ? { examples: cap.examples } : {}),
  };
}

const WORKFLOW_RULES = [
  'Run preflight first on any workspace you have not built in; configs use ids, never names.',
  'Before configuring a block, call workflow_guide with that block to read its evidence level, known gaps and an example config.',
  'Check workflow_guide recipes before inventing a multi-block pattern; follow their mcp_steps.',
  'Wire a variable only from an output the source block really emits (list_block_outputs, list_available_variables). Formula emits done.result, Aggregate done.total, Adjust time done.adjusted_timestamp.',
  'Outcomes are per block: most steps use "done", Loop items use "next", Branch uses true/false, Switch uses case_<id>/default.',
  'Aggregate values: aggregation_type is sum, mean, min or max. "average" saves but fails at runtime.',
  'A config reading complete is not proof required fields are set (Slack saved complete with no channel). Read the graph back with get_workflow.',
  'Prefer a Neon Deer app block (list_app_blocks) over custom Code or a large Switch for lookups, subflows, scheduling and set comparisons; relay its portal prerequisites.',
  'Never pass secrets through Code inputs: evaluated inputs are logged in run history.',
  'This MCP builds drafts only. Publishing, activation, run logs and retries happen in the Attio UI.',
  'Say how well tested a pattern is (its evidence level) when you propose it; documented or ui-observed means untested.',
];

/** The string held by a constant config node, or undefined (variables, absent). */
function constString(node) {
  if (!node || typeof node !== 'object') return undefined;
  if (node.type === 'string' && typeof node.value === 'string') return node.value;
  return undefined;
}

const subflowFieldKey = (name) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Mirrors the app's outputSignature(): sha256 hex of the JSON array of ordered output keys. */
function subflowOutputSignature(outputNames) {
  return createHash('sha256').update(JSON.stringify(outputNames.map(subflowFieldKey))).digest('hex');
}

// workflow_id formats, mirroring the app's own parsers.
// A value that fails these makes the step error at runtime, so it is refused before writing.
const TARGET_FORMATS = {
  'j-schedule-record': {
    hint: 'JSON string \'["<workflowId>","<entryPointId>"]\'. Build it with app_workflow_target.',
    ok: (v) => { try { const t = JSON.parse(v); return Array.isArray(t) && t.length === 2 && t.every((s) => typeof s === 'string' && s); } catch { return false; } },
  },
  'j-subflow-run': {
    hint: 'JSON string \'["<workflowId>","<entryPointId>","<64-hex output signature>"]\'. Build it with app_workflow_target.',
    ok: (v) => { try { const t = JSON.parse(v); return Array.isArray(t) && t.length === 3 && t[0] && t[1] && /^[a-f0-9]{64}$/.test(t[2]); } catch { return false; } },
  },
  'j-scheduled-runs-find': {
    hint: 'a BARE workflow uuid (unlike Schedule a workflow run).',
    ok: (v) => UUID_RE.test(v),
  },
};

const LEGACY_KEYS = {
  'j-subflow-run': ['dont_wait'],
  'j-subflow-return': ['named_outputs', 'object', 'workflow_id'],
};

/**
 * Check an app block config against the corpus before it is written. Throws on
 * values the app's runtime is known to reject; everything else comes back as
 * warnings plus the portal prerequisites to relay to the human.
 */
function reviewAppBlock(provider, config) {
  if (!provider || provider.type !== 'app') return null;
  const hit = findAppBlock(provider.app_block_id);
  if (!hit) return null;
  const { slug, app, block } = hit;
  const entries = (config && config.entries) || {};
  const specKeys = new Map(block.config.map((c) => [c.key, c]));
  const warnings = [];

  for (const [key, node] of Object.entries(entries)) {
    const spec = specKeys.get(key);
    if (!spec) { warnings.push(`"${key}" is not a config key of ${block.title}; the block ignores it.`); continue; }
    if ((LEGACY_KEYS[provider.app_block_id] || []).includes(key)) {
      warnings.push(`"${key}" is a legacy key kept for old configs. The UI no longer writes it; prefer the current key (see describe_app_block).`);
    }
    const value = constString(node);
    if (value === undefined) continue;
    if (Array.isArray(spec.enum_values) && !spec.enum_values.includes(value)) {
      throw new Error(`${block.title}: "${key}" must be one of ${spec.enum_values.map((v) => `"${v}"`).join(', ')}; got "${value}".`);
    }
    if (key === 'workflow_id' && TARGET_FORMATS[provider.app_block_id] && !TARGET_FORMATS[provider.app_block_id].ok(value)) {
      throw new Error(`${block.title}: workflow_id must be ${TARGET_FORMATS[provider.app_block_id].hint} Got: ${value}`);
    }
  }
  for (const c of block.config) {
    if (entries[c.key] !== undefined) continue;
    if (!c.optional && !(LEGACY_KEYS[provider.app_block_id] || []).includes(c.key)) {
      warnings.push(`Required key "${c.key}" is not set${c.notes ? ` (${c.notes})` : ''}.`);
    } else if (c.notes && /UI default|runtime default/i.test(c.notes)) {
      // The UI fills these on its own; over the API the runtime fallback applies instead.
      warnings.push(`"${c.key}" not set, so the runtime fallback applies, not the UI default: ${c.notes}`);
    }
  }
  return {
    app: slug,
    block: block.title,
    prerequisites: { ...block.prerequisites, connection: app.connection },
    app_guidance: app.guidance,
    warnings,
  };
}

function blockKey(b) {
  const p = b.provider || {};
  const slug = p.system_block_slug || p.app_block_slug || p.type;
  const ver = p.system_block_version || p.app_block_version;
  return ver ? `${slug}@${ver}` : slug;
}

/**
 * Build the config node that references an upstream block's output.
 * `path` is the access path, e.g. ["new_value"] or
 * ["entity_instance", {attribute: "<uuid>", object: "<uuid>"}].
 */
function buildVariable(blockId, outcome, path, as) {
  const operations = (path || []).map((seg) => {
    if (typeof seg === 'string') return { type: 'field', name: seg };
    if (seg && seg.attribute) {
      return {
        type: 'attribute-definition',
        entity_definition_id: seg.object,
        attribute_definition_id: seg.attribute,
      };
    }
    throw new Error(`Bad path segment: ${JSON.stringify(seg)}`);
  });
  const node = {
    type: 'variable',
    matchers: [{ id: randomUUID(), block_instance_id: blockId, outcome: outcome || 'done', operations }],
  };
  if (as) node.as = typeof as === 'string' ? { type: as } : as;
  return node;
}

/** Blocks that can reach `targetId` by following paths backwards. */
function upstreamOf(targetId, blocks, paths) {
  const byId = new Map(blocks.map((b) => [b.block_id, b]));
  const incoming = new Map();
  for (const p of paths) {
    const to = p.target_block_id || p.to_block_id;
    const from = p.source_block_id || p.from_block_id;
    if (!to || !from) continue;
    if (!incoming.has(to)) incoming.set(to, []);
    incoming.get(to).push({ from, outcome: p.outcome });
  }
  const seen = new Set();
  const order = [];
  const walk = (id, depth) => {
    for (const e of incoming.get(id) || []) {
      if (seen.has(e.from)) continue;
      seen.add(e.from);
      const b = byId.get(e.from);
      if (b) { order.push({ block: b, via_outcome: e.outcome, depth }); walk(e.from, depth + 1); }
    }
  };
  walk(targetId, 1);
  return order;
}


// ------------------------------------------------------------- preflight
//
// Two credentials, two jobs. The session cookie drives the internal Workflows
// API (workflows, objects, attributes). Select/status OPTION ids and workspace
// members are only on the PUBLIC v2 API, which needs an API key.
//
// Verified 2026-08-19: both APIs use the SAME uuids. The public API's
// object_id / attribute_id are the internal API's entity_definition_id /
// attribute_definition_id, so option ids resolved here are valid in configs.

const PUBLIC_ROOT = 'https://api.attio.com/v2';
const CACHE_DIR = path.join(os.homedir(), '.attio-admin-cache');

function apiKeyPath(profile) {
  return profile
    ? path.join(os.homedir(), `.attio-apikey-${profile}`)
    : path.join(os.homedir(), '.attio-apikey');
}

function apiKeyFor(profile, explicit) {
  if (explicit) return explicit;
  const envSpecific = profile && process.env[`ATTIO_API_KEY_${profile.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  if (envSpecific) return envSpecific;
  if (process.env.ATTIO_API_KEY) return process.env.ATTIO_API_KEY;
  const f = apiKeyPath(profile);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return null;
}

async function publicApi(p, key, opts = {}) {
  const { method = 'GET', body } = opts;
  const res = await fetch(`${PUBLIC_ROOT}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`public API ${res.status} on ${method} ${p}: ${text.slice(0, 300)}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`public API returned non-JSON on ${p}`); }
  return j.data !== undefined ? j.data : j;
}

const cachePath = (slug) => path.join(CACHE_DIR, `${slug}.json`);

function readCache(slug) {
  try { return JSON.parse(fs.readFileSync(cachePath(slug), 'utf8')); } catch { return null; }
}

function writeCache(slug, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(slug), JSON.stringify(data, null, 2));
    return cachePath(slug);
  } catch (e) { return `(not cached: ${e.message})`; }
}


// ---------------------------------------------------------------- legacy
//
// Pre-modern workflows have NO version records (draft/active are null and
// /versions returns []). Their definition lives in SNAPSHOTS instead:
//   GET /workflows/{id}/snapshots                  list, newest state in `status`
//   GET /workflows/{id}/snapshots/{sid}/nodes      the blocks
//   GET /workflows/{id}/snapshots/{sid}/edges      the connections
//
// Each node carries a `schema` with inputs, outputs and outcomes. That is the
// only place Attio serves a block's OUTPUT schema, which is otherwise
// resolved client-side and unavailable to API callers.

async function legacySnapshots(id, ctx) {
  return unwrap(await api(`/workflows/${id}/snapshots`, { ctx }));
}

function pickSnapshot(snaps, want) {
  if (!snaps.length) return null;
  const byStatus = (st) => snaps.find((s) => s.status === st);
  if (want === 'draft') return byStatus('draft') || null;
  if (want === 'active') return byStatus('live') || byStatus('published') || null;
  // auto: prefer what is actually running, else the draft, else newest
  return byStatus('live') || byStatus('published') || byStatus('draft') || snaps[0];
}

async function readLegacyDefinition(id, snapshotId, ctx) {
  const base = `/workflows/${id}/snapshots/${snapshotId}`;
  const nodes = unwrap(await api(`${base}/nodes`, { ctx }));
  let edges = [];
  try { edges = unwrap(await api(`${base}/edges`, { ctx })); }
  catch { /* some snapshots have no edges */ }
  return {
    blocks: nodes.map((n) => ({
      block_id: n.workflow_snapshot_node_id,
      description: n.description || n.default_description || null,
      position: n.position,
      block: n.block,
      // the schema Attio will not give you anywhere else
      inputs: (n.schema && n.schema.inputs || []).map((i) => ({
        slug: i.slug, title: i.title, data_types: i.allowed_data_types,
      })),
      outputs: (n.schema && n.schema.outputs || []).map((o) => ({
        slug: o.slug, title: o.title, data_types: o.allowed_data_types,
      })),
      outcomes: (n.schema && n.schema.outcomes) || null,
    })),
    paths: (edges || []).map((e) => ({
      path_id: e.workflow_snapshot_edge_id,
      source_block_id: e.source_workflow_snapshot_node_id || e.source,
      target_block_id: e.target_workflow_snapshot_node_id || e.target,
      outcome: e.outcome,
    })),
  };
}

// ------------------------------------------------------------------- views
//
// Attio's public API can READ views but cannot create or modify them. This
// section drives the same internal API the Views UI uses. The naming is the
// thing that hides it:
//
//   UI concept        internal API term
//   object / list  -> entity-definition
//   view           -> entity-view
//   view column    -> entity-view-attribute
//   view sort      -> entity-view-sort
//   filter         -> entity-filter + entity-filter-block
//
// **Lists are entity-definitions too.** A list id drops straight into every
// endpoint below where an object id goes. [VERIFIED 2026-08-24: a list's
// /entity-views and /attribute-definitions both return 200.] A list also carries
// a `parent_record` attribute (type entity-reference) that the PUBLIC API does
// not expose, which is what makes a 2-hop column onto the parent record possible.

/** Fractional-index ordering key. Lexically sortable, stable for appends. */
const sortKey = (i) => `m${i.toString(16).padStart(4, '0')}`;

/**
 * Resolve an object OR list reference to an entity_definition_id.
 * Accepts a uuid (object or list, passed through) or an object api_slug.
 */
async function resolveEntityDef(ref, ctx) {
  if (!ref) throw new Error('An object (api_slug) or list id is required.');
  if (UUID_RE.test(ref)) {
    // Fetch it so callers know the entity_type. Lists are reachable by id but are
    // NOT returned by /entity-definitions, so this is the only way to identify one.
    const d = unwrap(await api(`/entity-definitions/${ref}`, { ctx }).catch(() => null));
    return {
      entity_definition_id: ref,
      api_slug: d ? d.api_slug : null,
      entity_type: d ? d.entity_type : null,
      resolved_from: 'uuid',
    };
  }
  const defs = unwrap(await api('/entity-definitions', { ctx }));
  const hit = defs.find((d) => d.api_slug === ref) ||
    defs.find((d) => (d.api_slug || '').toLowerCase() === String(ref).toLowerCase());
  if (hit) {
    return {
      entity_definition_id: hit.entity_definition_id, api_slug: hit.api_slug,
      entity_type: hit.entity_type, resolved_from: 'api_slug',
    };
  }
  throw new Error(
    `No object with api_slug "${ref}". Available: ${defs.map((d) => d.api_slug).filter(Boolean).join(', ')}. ` +
    'For a LIST, pass its uuid instead — lists are entity-definitions but are not returned by /entity-definitions.'
  );
}

/** Resolve an attribute reference (uuid, api_slug, or title) within one entity definition. */
async function resolveAttr(entityDefId, ref, ctx) {
  if (UUID_RE.test(ref)) return { attribute_definition_id: ref, api_slug: null };
  const attrs = unwrap(await api(`/entity-definitions/${entityDefId}/attribute-definitions`, { ctx }));
  const live = attrs.filter((a) => !a.is_archived);
  const hit = live.find((a) => a.api_slug === ref) ||
    live.find((a) => (a.api_slug || '').toLowerCase() === String(ref).toLowerCase()) ||
    live.find((a) => (a.title || '').toLowerCase() === String(ref).toLowerCase());
  if (hit) return { attribute_definition_id: hit.attribute_definition_id, api_slug: hit.api_slug, type: hit.type };
  const archived = attrs.find((a) => a.is_archived &&
    (a.api_slug === ref || (a.title || '').toLowerCase() === String(ref).toLowerCase()));
  if (archived) {
    throw new Error(
      `Attribute "${ref}" exists but is ARCHIVED. Archived attributes save fine and then never render. ` +
      'Use the active attribute instead.'
    );
  }
  throw new Error(`No attribute "${ref}" on this entity. Try list_attributes to see what exists.`);
}

/**
 * Build one column's `path`. A path is a list of hops; more than one hop reads a
 * field off a LINKED record, e.g. [company, company.name] or, on a list,
 * [parent_record, person.email_addresses].
 * Accepts "slug", or [{object, attribute}, ...] for the multi-hop form.
 */
async function buildPath(entityDefId, attribute, ctx) {
  const hops = Array.isArray(attribute) ? attribute : [{ attribute }];
  const path = [];
  let currentEntity = entityDefId;
  for (const hop of hops) {
    if (hop.object) currentEntity = (await resolveEntityDef(hop.object, ctx)).entity_definition_id;
    const a = await resolveAttr(currentEntity, hop.attribute, ctx);
    path.push({ entity_definition_id: currentEntity, attribute_definition_id: a.attribute_definition_id });
  }
  return path;
}

/**
 * Resolve the attribute a kanban board groups its columns by. Only STATUS
 * attributes (internal type `pipeline`) are allowed. Deal stage is itself a
 * status attribute, so this one rule covers deals, people, companies, custom
 * objects and lists alike.
 *
 * The guard is ours, not Attio's: Attio happily stores a pivot on a select
 * attribute (HTTP 200, 2026-11-06). Refuse it here rather than leave a board
 * the UI was never designed to draw.
 */
async function resolveKanbanPivot(def, ref, ctx) {
  const attrs = unwrap(await api(`/entity-definitions/${def.entity_definition_id}/attribute-definitions`, { ctx }));
  const statusAttrs = attrs.filter((a) => a.type === 'pipeline' && !a.is_archived);
  const label = def.api_slug || def.entity_definition_id;
  const available = statusAttrs.length
    ? `Status attributes on "${label}": ${statusAttrs.map((a) => `${a.api_slug} ("${a.title}")`).join(', ')}.`
    : `"${label}" has NO status attributes. Create one first, then create the board.`;

  if (!ref) {
    // Deals ship with the Deal stage status attribute, so it is the natural default.
    if (def.api_slug === 'deals') {
      const stage = statusAttrs.find((a) => a.api_slug === 'stage');
      if (stage) return stage;
    }
    throw new Error(`A kanban view needs group_by: the status attribute that defines its columns. ${available}`);
  }

  const s = String(ref).toLowerCase();
  const hit = attrs.find((a) => a.attribute_definition_id === ref) ||
    attrs.find((a) => (a.api_slug || '').toLowerCase() === s) ||
    attrs.find((a) => (a.title || '').toLowerCase() === s);
  if (!hit) throw new Error(`No attribute "${ref}" on "${label}". ${available}`);
  if (hit.is_archived) throw new Error(`Attribute "${ref}" is ARCHIVED. ${available}`);
  if (hit.type !== 'pipeline') {
    throw new Error(
      `"${hit.api_slug || ref}" is a ${hit.type} attribute. Kanban views group by a STATUS attribute only. ${available}`
    );
  }
  return hit;
}

/**
 * Kanban column (stage) visibility is NOT a filter. It is a per-view, per-stage
 * "kanban-stage-characteristic" record. Captured from the UI's board settings menu
 * on a client workspace and replayed headless in a second workspace,
 * 2026-11-06:
 *   POST  .../entity-views/{view}/kanban-stage-characteristic  {pipeline_leaf_attribute}
 *         -> array of the stages that have a record (stages never touched have none
 *            and are visible). This POST is the READ; a GET returns the SPA's HTML.
 *   PATCH same path {pipeline_leaf_attribute, pipeline_stage_id, is_visible, aggregation}
 *         -> upserts one stage. Works for hide and re-show.
 * pipeline_leaf_attribute = {entity_definition_id, attribute_definition_id} of the
 * status attribute the board groups by. [VERIFIED 2026-11-06]
 */
const kscPath = (defId, viewId) => `${viewsBase(defId)}/${viewId}/kanban-stage-characteristic`;

/** The status attribute a board pivots on, as a pipeline_leaf_attribute. */
async function kanbanLeaf(defId, viewId, ctx) {
  const view = unwrap(await api(`${viewsBase(defId)}/${viewId}`, { ctx }));
  if (view.type !== 'kanban') throw new Error(`View "${view.title}" is a ${view.type} view, not a kanban board.`);
  const p = view.kanban_pivot_path;
  if (!p || !p.length) {
    throw new Error(`Board "${view.title}" has no explicit group-by attribute (kanban_pivot_path is null). ` +
      'Recreate it with create_view and group_by, or set it in the UI.');
  }
  return { view, leaf: p[p.length - 1] };
}

/** Read every active stage with its visibility on this board, in stage order. */
async function readKanbanColumns(defId, viewId, ctx) {
  const { view, leaf } = await kanbanLeaf(defId, viewId, ctx);
  const stages = (await fetchOptions(leaf.entity_definition_id, leaf.attribute_definition_id, OPTION_KINDS.pipeline, ctx))
    .filter((s) => !s.is_archived)
    .sort((a, b) => String(a.sort_order || '').localeCompare(String(b.sort_order || '')));
  const recs = unwrap(await api(kscPath(defId, viewId), { method: 'POST', ctx, body: { pipeline_leaf_attribute: leaf } })) || [];
  const byId = new Map(recs.map((r) => [r.pipeline_stage_id, r]));
  const columns = stages.map((s) => {
    const r = byId.get(s.option_id);
    return {
      title: s.title, pipeline_stage_id: s.option_id,
      visible: r ? r.is_visible !== false : true,
      aggregation: r ? r.aggregation : null,
    };
  });
  return { view, leaf, stages, columns };
}

/**
 * Set which stage columns a board shows. `show` = exactly these visible, all
 * others hidden. `hide` / `unhide` = change only the stages named. A stage's
 * existing per-column aggregation is carried through untouched.
 */
async function setKanbanColumns(defId, viewId, { show, hide, unhide }, ctx) {
  if (!show && !hide && !unhide) throw new Error('Pass show, hide, or unhide.');
  if (show && (hide || unhide)) throw new Error('show sets the full visible set; do not combine it with hide/unhide.');
  const { leaf, stages, columns } = await readKanbanColumns(defId, viewId, ctx);
  const resolve = (refs) => refs.map((r) => {
    const hit = findOption(stages, r);
    if (!hit) throw new Error(`No stage "${r}" on this board's status attribute. Stages: ${stages.map((s) => s.title).join(', ')}.`);
    return hit.option_id;
  });
  // Validate every name BEFORE writing anything.
  const want = new Map(columns.map((c) => [c.pipeline_stage_id, c.visible]));
  if (show) {
    const keep = new Set(resolve(show));
    for (const c of columns) want.set(c.pipeline_stage_id, keep.has(c.pipeline_stage_id));
  }
  for (const id of resolve(hide || [])) want.set(id, false);
  for (const id of resolve(unhide || [])) want.set(id, true);

  let changed = 0;
  for (const c of columns) {
    const v = want.get(c.pipeline_stage_id);
    if (v === c.visible) continue;
    await api(kscPath(defId, viewId), {
      method: 'PATCH', ctx,
      body: { pipeline_leaf_attribute: leaf, pipeline_stage_id: c.pipeline_stage_id, is_visible: v, aggregation: c.aggregation },
    });
    changed++;
  }
  const after = await readKanbanColumns(defId, viewId, ctx);
  return {
    changed,
    visible: after.columns.filter((c) => c.visible).map((c) => c.title),
    hidden: after.columns.filter((c) => !c.visible).map((c) => c.title),
  };
}

// Row-versioning constraint that rides on EVERY entity-filter constraint set.
const ACTIVE_UNTIL = { field: 'active_until', operator: 'empty', value: 'null', value_type: 'static' };

/**
 * Constraint fields are keyed to the ATTRIBUTE TYPE and are NOT derivable — one
 * type's field names are not evidence for another's. Verified entries only, with
 * their capture date. To add a type: build one real filter of it in the Attio UI,
 * read it back with get_view, and add it here WITH THE DATE. Never extrapolate.
 *
 * Ported from Erik Ash's attio_internal.py, whose two failed round-trips are the
 * reason this rule is written in capitals.
 */
const CONSTRAINT_KINDS = {
  // actor-reference (owner, PM, …). "current-member" makes a per-viewer dynamic filter.
  actor: { verified: '2026-08-18', fields: ['referenced_actor_id', 'referenced_actor_type'] },
  // select / status. value is an option_id (use resolve to get one).
  select: { verified: '2026-08-18', fields: ['select_option_id'] },
  // status (internal type "pipeline", incl. Deal stage). value is a stage title or
  // pipeline_stage_id, or an ARRAY of them. Captured from UI-built views in
  // neon-deer-data-labs (deals "Open Deals", "CX Invoices"), both filter_modes.
  status: { verified: '2026-11-06', fields: ['pipeline_stage_id'] },
  // scalar text/number equality. NOT captured from real traffic.
  generic: { verified: 'UNVERIFIED', fields: ['value'] },
};

function constraintsFor(kind, op, value) {
  const mode = op === 'is_not' ? 'must-not' : 'must';
  if (kind === 'actor') {
    const dynamic = value === 'current-member';
    return {
      filter_mode: 'must',
      constraints: [
        { field: 'referenced_actor_id', operator: 'eq', value, value_type: dynamic ? 'dynamic' : 'static' },
        { field: 'referenced_actor_type', operator: 'eq', value: 'workspace-member', value_type: 'static' },
        ACTIVE_UNTIL,
      ],
    };
  }
  if (kind === 'select') {
    return {
      filter_mode: mode,
      constraints: [{ field: 'select_option_id', operator: 'eq', value, value_type: 'static' }, ACTIVE_UNTIL],
    };
  }
  if (kind === 'status') {
    return {
      filter_mode: mode,
      constraints: [{ field: 'pipeline_stage_id', operator: 'eq', value, value_type: 'static' }, ACTIVE_UNTIL],
    };
  }
  if (kind !== 'generic') {
    throw new Error(
      `Unknown filter kind "${kind}". Known: ${Object.keys(CONSTRAINT_KINDS).join(', ')}. ` +
      'Constraint field names are per attribute type and cannot be guessed: build one filter of this ' +
      'type in the Attio UI, read it back with get_view, and add the shape to CONSTRAINT_KINDS.'
    );
  }
  return {
    filter_mode: mode,
    constraints: [{ field: 'value', operator: 'eq', value, value_type: 'static' }, ACTIVE_UNTIL],
  };
}

/** Turn a filter spec list into the entity-filter-blocks tree (one AND group + a block each). */
async function buildFilterBlocks(entityDefId, filters, ctx) {
  const rootId = crypto.randomUUID();
  const blocks = [{
    entity_filter_block_id: rootId,
    block_type: 'group',
    group_mode: 'and',
    parent_entity_filter_block_id: null,
    sort_order: sortKey(0),
  }];
  let i = 1;
  for (const f of filters) {
    const path = await buildPath(entityDefId, f.attribute, ctx);
    const kind = f.kind || 'generic';
    const op = f.op || 'eq';

    if (kind === 'status') {
      // Resolve titles to pipeline_stage_ids against the attribute the path ends on.
      const last = path[path.length - 1];
      const stages = await fetchOptions(last.entity_definition_id, last.attribute_definition_id, OPTION_KINDS.pipeline, ctx);
      const refs = Array.isArray(f.value) ? f.value : [f.value];
      if (!refs.length) throw new Error(`Status filter on "${JSON.stringify(f.attribute)}" has no values.`);
      const ids = refs.map((r) => {
        const hit = findOption(stages.filter((s) => !s.is_archived), r);
        if (!hit) {
          throw new Error(`No status "${r}" on this attribute. Stages: ${stages.filter((s) => !s.is_archived).map((s) => s.title).join(', ')}.`);
        }
        return hit.option_id;
      });
      // "is any of" = an OR group of must-filters nested under the root AND group
      // (same nesting as UI-built views). "is none of" = must-not filters, AND-ed.
      let parent = rootId;
      if (ids.length > 1 && op !== 'is_not') {
        parent = crypto.randomUUID();
        blocks.push({
          entity_filter_block_id: parent, block_type: 'group', group_mode: 'or',
          parent_entity_filter_block_id: rootId, sort_order: sortKey(i++),
        });
      }
      let j = 0;
      for (const id of ids) {
        const { filter_mode, constraints } = constraintsFor('status', op, id);
        blocks.push({
          entity_filter_block_id: crypto.randomUUID(), block_type: 'filter',
          parent_entity_filter_block_id: parent,
          sort_order: parent === rootId ? sortKey(i++) : sortKey(j++),
          filter_mode, filter_path: path, constraints,
        });
      }
      continue;
    }

    const { filter_mode, constraints } = constraintsFor(kind, op, f.value);
    blocks.push({
      entity_filter_block_id: crypto.randomUUID(),
      block_type: 'filter',
      parent_entity_filter_block_id: rootId,
      sort_order: sortKey(i++),
      filter_mode,
      filter_path: path,
      constraints,
    });
  }
  return blocks;
}

const viewsBase = (defId) => `/entity-definitions/${defId}/entity-views`;

// Standard objects live at /{ws}/{slug}/view/{id}; a /custom/ prefix on them
// redirects to a DIFFERENT view (seen on a client workspace, 2026-11-06). The custom-object
// form is kept as before and is unverified.
const STANDARD_OBJECTS = new Set(['people', 'companies', 'deals', 'users', 'workspaces']);
const viewUrl = (ctx, def, viewId) => STANDARD_OBJECTS.has(def.api_slug)
  ? `https://app.attio.com/${ctx.slug}/${def.api_slug}/view/${viewId}`
  : `https://app.attio.com/${ctx.slug}/custom/${def.api_slug || def.entity_definition_id}/view/${viewId}`;

// -------------------------------------------------------- select options
//
// Select/status option ids ARE on the internal API, at
//   /entity-definitions/{def}/attribute-definitions/{attr}/select-options
// An earlier probe of 8 candidate paths concluded they were not, because this
// endpoint wraps its payload as {accurate_at, values:[...]} — `values`, PLURAL —
// while the rest of this API uses {value:[...]}. Unwrapping for `value` yields
// undefined and reads as "no such endpoint". [VERIFIED 2026-08-24]
//
// Option COLOR is a named palette value, not hex, and the public API cannot set
// it at all. The internal one can: a single-field PATCH per option.

// TWO namespaces, one shape. Which one you get is keyed to the attribute TYPE,
// and nothing about the response tells you which you asked for, so resolve the
// type first rather than guessing.
//
//   select (single or multi) -> /select-options   id select_option_id   colours pastel_*
//   status  (internally "pipeline") -> /pipeline-stages  id pipeline_stage_id  colours block_*
//
// `pipeline-stages` is why status options looked unreachable for so long. The
// obvious guesses (`statuses`, `status-options`) fall through to the SPA, which
// answers unknown paths with an HTML 200; `select-options` returns a real 400
// ("Select options cannot be retrieved for non-select attributes") that reads
// like a hard no rather than a wrong-route. [VERIFIED 2026-09-03]
const OPTION_KINDS = {
  select: {
    segment: 'select-options', idField: 'select_option_id', prefix: 'pastel_', label: 'select',
  },
  pipeline: {
    segment: 'pipeline-stages', idField: 'pipeline_stage_id', prefix: 'block_', label: 'status',
  },
};

const optionsPath = (defId, attrId, kind) =>
  `/entity-definitions/${defId}/attribute-definitions/${attrId}/${kind.segment}`;

/**
 * Which namespace an attribute's options live in.
 * `resolveAttr` omits `type` when handed a uuid, so fetch it in that case rather
 * than probing — a wrong guess here is a 400 with an empty body.
 */
async function resolveOptionKind(defId, attr, ctx) {
  let type = attr.type;
  if (!type) {
    const attrs = unwrap(await api(`/entity-definitions/${defId}/attribute-definitions`, { ctx }));
    const hit = attrs.find((a) => a.attribute_definition_id === attr.attribute_definition_id);
    type = hit && hit.type;
  }
  if (type === 'select') return OPTION_KINDS.select;
  if (type === 'pipeline' || type === 'status') return OPTION_KINDS.pipeline;
  throw new Error(
    `Attribute "${attr.api_slug || attr.attribute_definition_id}" is type "${type || 'unknown'}", ` +
    'which has no options. Only select and status attributes do.'
  );
}

// ------------------------------------------------------ record layouts
//
// A record page is ONE TREE of "elements", saved by a FULL-REPLACE POST:
//   POST /custom-layouts/{id}  {"elements": [ ...the entire tree... ]}
// There is no per-element endpoint. Everything here is therefore strictly
// read-modify-write: anything you fail to send back is deleted. Deletion is
// expressed by OMISSION, not by a flag.
//
// An identity write (POST back exactly what was read) round-trips byte-identical.
// [VERIFIED 2026-08-24] That is what makes read-modify-write safe.
//
// A child element's type is keyed to its CONTAINER, not to the field:
//   details -> detail-value · email-tab -> email-tab-value
//   relationship-tab -> relationship-tab-value

const LAYOUT_CHILD_TYPE = {
  details: 'detail-value',
  'email-tab': 'email-tab-value',
  'relationship-tab': 'relationship-tab-value',
};

/** Containers a field can be added to. */
const isContainer = (e) => Object.prototype.hasOwnProperty.call(LAYOUT_CHILD_TYPE, e.type);

/** Next sort_order after everything currently under `parentId`. */
function nextSort(elements, parentId) {
  const sibs = elements.filter((e) => e.parent_element_id === parentId).map((e) => String(e.sort_order || ''));
  return sibs.length ? sibs.sort().pop() + 'm' : 'm0000';
}

/** Every descendant id of `id`, inclusive — needed because delete is by omission. */
function withDescendants(elements, id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of elements) {
      if (e.parent_element_id && out.has(e.parent_element_id) && !out.has(e.element_id)) {
        out.add(e.element_id); grew = true;
      }
    }
  }
  return out;
}

/** Find an element by element_id, or by exact/case-insensitive title. */
function findElement(elements, ref) {
  return elements.find((e) => e.element_id === ref) ||
    elements.find((e) => e.title === ref) ||
    elements.find((e) => (e.title || '').toLowerCase() === String(ref).toLowerCase());
}

async function getLayoutRaw(layoutId, ctx) {
  const l = await api(`/custom-layouts/${layoutId}`, { ctx });
  if (!l || !Array.isArray(l.elements)) {
    throw new Error(`Layout ${layoutId} returned no elements array.`);
  }
  return l;
}

/**
 * The palette, enumerated against Attio rather than observed in the wild.
 * Every one of these was PATCHed successfully and everything else tried (pink,
 * cyan, indigo, lime, gold, black, white, navy, olive) was rejected with a 400.
 * The same twelve names serve both namespaces; only the prefix differs.
 * [VERIFIED 2026-09-03]
 */
const PALETTE = [
  'red', 'orange', 'yellow', 'green', 'light-green', 'teal',
  'blue', 'purple', 'violet', 'brown', 'magenta', 'grey',
];

/**
 * Accept "red" or "pastel_red"/"block_red" and return the name this attribute's
 * namespace actually wants. Attio validates colour for real (a bad name is a 400
 * and nothing is stored), so this is a courtesy that turns an empty 400 into a
 * sentence — notably when a pastel_* name is aimed at a status attribute.
 */
function normalizeColor(color, kind) {
  const raw = String(color);
  const bare = raw.replace(/^(pastel_|block_)/, '');
  if (!PALETTE.includes(bare)) {
    throw new Error(
      `"${raw}" is not an Attio palette colour. Valid: ${PALETTE.join(', ')} ` +
      `(sent as ${kind.prefix}<name> for ${kind.label} attributes).`
    );
  }
  const wanted = kind.prefix + bare;
  if (raw !== bare && raw !== wanted) {
    throw new Error(
      `"${raw}" is the wrong namespace for a ${kind.label} attribute — it wants "${wanted}". ` +
      'Attio rejects the wrong prefix with an empty 400.'
    );
  }
  return wanted;
}

async function fetchOptions(defId, attrId, kind, ctx) {
  const r = await api(optionsPath(defId, attrId, kind), { ctx });
  // `values`, not `value` — see note above.
  const opts = (r && (r.values || r.value)) || [];
  if (!Array.isArray(opts)) throw new Error(`Unexpected ${kind.segment} envelope; Attio may have changed it.`);
  // Normalise the id field so callers do not care which namespace they hit.
  return opts.map((o) => ({ ...o, option_id: o[kind.idField] }));
}

/** Match an option by id, exact title, or case-insensitive title. */
function findOption(opts, ref) {
  return opts.find((o) => o.option_id === ref) ||
    opts.find((o) => o.title === ref) ||
    opts.find((o) => (o.title || '').toLowerCase() === String(ref).toLowerCase());
}

// -------------------------------------------------------------------- tools

const TOOLS = {
  list_workspaces: {
    description:
      'List every workspace the session cookie can reach. A cookie authenticates one Attio ACCOUNT, ' +
      'so this is the definitive answer to "why can I not see workspace X". Also lists available cookie profiles.',
    inputSchema: {
      type: 'object',
      properties: { profile: SCOPE_PROPS.profile },
    },
    async run({ profile } = {}) {
      const cookie = cookieFor(profile);
      const ws = await raw(`${ROOT}/workspaces`, { cookie });
      return {
        profile: profile || '(default)',
        session: sessionInfo(cookie),
        profiles_available: availableProfiles(),
        workspaces: ws.map((w) => {
          const x = w.workspace || w;
          return { slug: x.slug, name: x.name, workspace_id: x.id };
        }),
      };
    },
  },

  check_session: {
    description:
      'Validate a session cookie. Reports JWT expiry and days remaining, then makes a real ' +
      'authenticated call against the target workspace. Run this first when something is wrong.',
    inputSchema: scoped(),
    async run(args = {}) {
      const ctx = ctxFrom(args);
      const info = sessionInfo(ctx.cookie);
      if (!info.present) throw new Error(`No attio-session cookie in ${sessionPath(ctx.profile)}.`);
      if (info.expired) throw new Error(`Session expired ${info.expires_at}. Re-capture the cookie.`);
      const ids = await queryWorkflowIds(ctx);
      return {
        ok: true,
        workspace: ctx.slug,
        profile: ctx.profile || '(default)',
        workflow_count: ids.length,
        session: info,
      };
    },
  },

  preflight: {
    description:
      'Resolve EVERYTHING a workspace needs before you build a workflow, in one pass: objects, their ' +
      'attributes, select/status option ids, lists, and workspace members. Run this FIRST on any account ' +
      'you have not built in. Configs reference all of these by uuid and never by name, so without this ' +
      'you are guessing. Results are cached per workspace; pass refresh:true after schema changes. ' +
      'Needs an API key as well as the session cookie, because option ids and members are only on the ' +
      'public API (~/.attio-apikey, ~/.attio-apikey-<profile>, or ATTIO_API_KEY).',
    inputSchema: scoped({
      api_key: { type: 'string', description: 'Overrides the stored key. Usually unnecessary.' },
      refresh: { type: 'boolean', description: 'Ignore any cached result and re-scrape.' },
      include_options: { type: 'boolean', description: 'Resolve select/status option ids. Default true.' },
    }),
    async run(args = {}) {
      const ctx = ctxFrom(args);
      const wantOptions = args.include_options !== false;

      if (!args.refresh) {
        const hit = readCache(ctx.slug);
        // older cache files predate the cached_to stamp; fill it in on read
        if (hit) return { ...hit, cached_to: hit.cached_to || cachePath(ctx.slug),
          from_cache: true, note: 'Cached. Pass refresh:true to re-scrape.' };
      }

      const key = apiKeyFor(ctx.profile, args.api_key);
      const warnings = [];

      const defs = (await api('/entity-definitions', { ctx })).filter((d) => !d.is_archived);
      const objects = [];
      for (const d of defs) {
        const attrs = unwrap(await api(`/entity-definitions/${d.entity_definition_id}/attribute-definitions`, { ctx }))
          .filter((a) => !a.is_archived);
        const out = {
          api_slug: d.api_slug,
          singular_noun: d.singular_noun,
          entity_definition_id: d.entity_definition_id,
          entity_type: d.entity_type,
          attributes: attrs.map((a) => ({
            api_slug: a.api_slug,
            title: a.title,
            type: a.type,
            attribute_definition_id: a.attribute_definition_id,
            is_multiselect: a.is_multiselect,
            is_required: a.is_required,
          })),
        };
        // Option ids live only on the public API, and only for these types.
        if (wantOptions && key) {
          for (const a of out.attributes) {
            const isSelect = a.type === 'select';
            const isStatus = a.type === 'status' || a.type === 'pipeline';
            if (!isSelect && !isStatus) continue;
            const suffix = isSelect ? 'options' : 'statuses';
            try {
              const rows = await publicApi(
                `/objects/${encodeURIComponent(d.api_slug)}/attributes/${encodeURIComponent(a.api_slug)}/${suffix}`, key);
              a.options = rows.filter((r) => !r.is_archived).map((r) => ({
                title: r.title,
                // status ids fill pipeline_stage_id; option ids fill select values
                id: r.id.option_id || r.id.status_id,
                kind: r.id.option_id ? 'option' : 'status',
              }));
            } catch (e) {
              warnings.push(`${d.api_slug}.${a.api_slug}: ${String(e.message).slice(0, 100)}`);
            }
          }
        }
        objects.push(out);
      }

      let members = null, lists = null;
      if (key) {
        try {
          members = (await publicApi('/workspace_members', key))
            .filter((m) => m.access_level !== 'suspended')
            .map((m) => ({
              workspace_member_id: m.id.workspace_member_id,
              name: [m.first_name, m.last_name].filter(Boolean).join(' '),
              email_address: m.email_address,
              access_level: m.access_level,
            }));
        } catch (e) { warnings.push(`workspace_members: ${String(e.message).slice(0, 100)}`); }
        try {
          lists = (await publicApi('/lists', key)).map((l) => ({
            api_slug: l.api_slug, name: l.name, list_id: l.id.list_id,
          }));
        } catch (e) { warnings.push(`lists: ${String(e.message).slice(0, 100)}`); }
      } else {
        warnings.push(
          'No API key, so option ids, members and lists were skipped. Any condition on a status or ' +
          'select field needs those ids. Save one to ' + apiKeyPath(ctx.profile) + '.');
      }

      const optionCount = objects.reduce((n, o) =>
        n + o.attributes.reduce((m, a) => m + (a.options ? a.options.length : 0), 0), 0);

      const result = {
        workspace: ctx.slug,
        profile: ctx.profile || '(default)',
        scraped_at: new Date().toISOString(),
        summary: {
          objects: objects.length,
          attributes: objects.reduce((n, o) => n + o.attributes.length, 0),
          options: optionCount,
          lists: lists ? lists.length : null,
          members: members ? members.length : null,
        },
        objects, lists, members,
        warnings,
      };
      // stamp the path BEFORE writing, so a cache hit reports it too
      result.cached_to = cachePath(ctx.slug);
      const wrote = writeCache(ctx.slug, result);
      if (wrote !== result.cached_to) result.cached_to = wrote;
      return result;
    },
  },

  resolve: {
    description:
      'Turn human names into the uuids a config needs, using the preflight cache. Give it an object and ' +
      'optionally an attribute and an option title, and it returns the ids plus a ready-to-paste config ' +
      'node. Use this instead of hand-copying uuids. Runs preflight first if nothing is cached.',
    inputSchema: scoped({
      object: { type: 'string', description: 'Object api_slug, e.g. "deals".' },
      attribute: { type: 'string', description: 'Attribute api_slug or title, e.g. "stage".' },
      option: { type: 'string', description: 'Option/status title, e.g. "Contacted".' },
      member: { type: 'string', description: 'Workspace member name or email to resolve instead.' },
    }, ['object']),
    async run(args = {}) {
      const ctx = ctxFrom(args);
      let data = readCache(ctx.slug);
      if (!data) data = await TOOLS.preflight.run(args);

      if (args.member) {
        const q = args.member.toLowerCase();
        const hits = (data.members || []).filter((m) =>
          (m.name || '').toLowerCase().includes(q) || (m.email_address || '').toLowerCase().includes(q));
        if (!hits.length) throw new Error(`No workspace member matching "${args.member}".`);
        return { members: hits };
      }

      const obj = (data.objects || []).find((o) => o.api_slug === args.object) ||
        (data.objects || []).find((o) => o.api_slug.toLowerCase() === String(args.object).toLowerCase());
      if (!obj) {
        throw new Error(`No object "${args.object}". Available: ${(data.objects || []).map((o) => o.api_slug).join(', ')}`);
      }
      const out = {
        object: obj.api_slug,
        entity_definition_id: obj.entity_definition_id,
        object_node: { type: 'attio-object', entity_definition_id: obj.entity_definition_id },
      };
      if (!args.attribute) {
        out.attributes = obj.attributes.map((a) => `${a.api_slug} (${a.type})`);
        return out;
      }

      const q = String(args.attribute).toLowerCase();
      const attr = obj.attributes.find((a) => a.api_slug.toLowerCase() === q) ||
        obj.attributes.find((a) => (a.title || '').toLowerCase() === q) ||
        obj.attributes.find((a) => a.api_slug.toLowerCase().includes(q));
      if (!attr) {
        throw new Error(`No attribute "${args.attribute}" on ${obj.api_slug}. ` +
          `Try: ${obj.attributes.slice(0, 25).map((a) => a.api_slug).join(', ')}`);
      }
      out.attribute = { api_slug: attr.api_slug, title: attr.title, type: attr.type,
        attribute_definition_id: attr.attribute_definition_id };
      out.attribute_node = { type: 'attio-attribute',
        entity_definition_id: obj.entity_definition_id,
        attribute_definition_id: attr.attribute_definition_id };
      // the operations[] hop for reading this attribute off a record in a variable path
      out.variable_path_segment = { attribute: attr.attribute_definition_id, object: obj.entity_definition_id };

      if (args.option) {
        if (!attr.options) {
          throw new Error(`Attribute ${attr.api_slug} has no options cached (type "${attr.type}"). ` +
            `Only select/status/pipeline attributes have them, and preflight needs an API key to fetch them.`);
        }
        const oq = args.option.toLowerCase();
        const opt = attr.options.find((o) => (o.title || '').toLowerCase() === oq) ||
          attr.options.find((o) => (o.title || '').toLowerCase().includes(oq));
        if (!opt) {
          throw new Error(`No option "${args.option}" on ${attr.api_slug}. ` +
            `Available: ${attr.options.map((o) => o.title).join(', ')}`);
        }
        out.option = opt;
        out.value_node = opt.kind === 'status'
          ? { type: 'attio-pipeline', entity_definition_id: obj.entity_definition_id,
              attribute_definition_id: attr.attribute_definition_id, pipeline_stage_id: opt.id }
          : { type: 'attio-select', entity_definition_id: obj.entity_definition_id,
              attribute_definition_id: attr.attribute_definition_id, option_id: opt.id };
      } else if (attr.options) {
        out.available_options = attr.options.map((o) => o.title);
      }
      return out;
    },
  },

  list_blocks: {
    description:
      'The workspace\'s live catalog of SYSTEM blocks: every built-in trigger and step. Served by the ' +
      'workspace, so it is correct on a brand-new account with no workflows in it. Use this rather than a ' +
      'hardcoded slug list. The workflow config field system_block_slug is system_block_type minus its ' +
      '"trigger-"/"step-" prefix. Blocks from installed apps are NOT in this catalog: use list_app_blocks.',
    inputSchema: scoped({
      type: { type: 'string', enum: ['trigger', 'step'], description: 'Optional filter.' },
    }),
    async run(args = {}) {
      const ctx = ctxFrom(args);
      const blocks = unwrap(await api('/workflow-blocks', { ctx }));
      const out = blocks
        .filter((b) => !args.type || b.type === args.type)
        .map((b) => ({
          type: b.type,
          system_block_type: b.system_block_type || null,
          // config uses the bare slug, not the prefixed type
          block_slug: b.system_block_type
            ? b.system_block_type.replace(/^(trigger|step)-/, '')
            : null,
          title: b.title,
          description: b.description,
          workflow_block_id: b.workflow_block_id,
          app: b.app ? { id: b.app.id || null, title: b.app.title || null } : null,
          execution_cost: b.execution_cost ? b.execution_cost.credits : null,
          outputs_known: false,
        }));
      for (const b of out) {
        const k = Object.keys(BLOCK_OUTPUTS).find((x) => x.split('@')[0] === b.block_slug);
        b.outputs_known = !!k;
        const cap = capForSystemBlock(b.block_slug);
        b.reference = cap ? { capability: cap.id, evidence: bestEvidence(cap), gaps: cap.gaps.length } : null;
      }
      return {
        workspace: ctx.slug,
        count: out.length,
        outputs_known_for: out.filter((b) => b.outputs_known).length,
        note: 'outputs_known=false means list_block_outputs has no harvested schema for it yet. ' +
              'Wire that block once in the UI, then re-run harvest-variables.js to learn its outputs.',
        blocks: out.sort((a, b) => String(a.system_block_type).localeCompare(String(b.system_block_type))),
      };
    },
  },

  list_app_blocks: {
    description:
      'Blocks contributed by INSTALLED apps (Slack, lemlist, Neon Deer\'s Advanced Workflow Automations, ' +
      'Email Notifications, …), which list_blocks does not show. Returns each app\'s live app_id and a ' +
      'ready provider for add_block. For apps whose source is mapped (spec_known), also the portal ' +
      'prerequisites the human must set up first; relay those before building. Apps with no blocks but ' +
      'mapped guidance (e.g. Duplicate Detection) are listed too, so you know when to send the human there.',
    inputSchema: scoped({
      app: { type: 'string', description: 'Optional: filter to one app slug, e.g. "workflow-utilities".' },
    }),
    async run(args = {}) {
      const ctx = ctxFrom(args);
      const [{ apps }, { app_installations: installs }] = await Promise.all([
        api('/apps', { ctx }), api('/app-installations', { ctx }),
      ]);
      const out = [];
      for (const a of apps) {
        if (!a.is_installed || (args.app && a.slug !== args.app)) continue;
        const mapped = APP_BLOCKS.apps && APP_BLOCKS.apps[a.slug];
        const surfaces = (a.surfaces || []).filter((s) => /^workflow-block-/.test(s.type));
        if (!surfaces.length && !mapped) continue;
        const inst = installs.find((i) => i.app_id === a.app_id);
        out.push({
          app: a.slug,
          title: a.title,
          developer: a.developer_account ? a.developer_account.title : null,
          app_id: a.app_id,
          installed_version: inst ? `${inst.major}.${inst.minor}` : null,
          spec_known: !!mapped,
          ...(mapped ? { connection: mapped.connection, guidance: mapped.guidance } : {}),
          blocks: surfaces.map((s) => {
            const spec = mapped && mapped.blocks && mapped.blocks[s.slug];
            const pre = spec && spec.prerequisites;
            return {
              app_block_id: s.slug,
              block_type: s.type.replace('workflow-block-', ''),
              title: s.title,
              spec_known: !!spec,
              ...(pre && (pre.plan_feature || pre.portal.length)
                ? { needs: { plan_feature: pre.plan_feature, portal: pre.portal } } : {}),
            };
          }),
          // Mapped blocks the live install does not expose: the install is older than the mapped source.
          ...(mapped && mapped.blocks
            ? { not_in_install: Object.keys(mapped.blocks).filter((id) => !surfaces.some((s) => s.slug === id)) }
            : {}),
          provider_template: surfaces.length
            ? { type: 'app', app_id: a.app_id, app_block_id: '<app_block_id>', app_user_connection_membership_id: null }
            : null,
        });
      }
      return {
        workspace: ctx.slug,
        count: out.length,
        note: 'app_id is per app build: dev builds of the same app run under different ids, so always take it from here. ' +
              'Apps with per-user connections (e.g. Mailchimp) need app_user_connection_membership_id copied off an ' +
              'existing block of that app (get_workflow). describe_app_block gives full config keys and outcomes.',
        apps: out,
      };
    },
  },

  describe_app_block: {
    description:
      'Full schema of an app block whose source is mapped: every config key with its type, allowed values ' +
      'and runtime notes; outcomes and their output fields; portal prerequisites (what must be set up at ' +
      'app.neondeerdata.com first, which plan feature it needs, and the error text when it is missing); ' +
      'and known gotchas. Read this before writing an app block config. Offline: no workspace call.',
    inputSchema: {
      type: 'object',
      properties: {
        app_block_id: { type: 'string', description: 'e.g. "c-lookup-row-find" or "send-email-notification".' },
        app: { type: 'string', description: 'Optional app slug to disambiguate.' },
      },
      required: ['app_block_id'],
    },
    async run(args) {
      const hit = findAppBlock(args.app_block_id, args.app);
      if (!hit) {
        const known = Object.entries(APP_BLOCKS.apps || {})
          .flatMap(([slug, a]) => Object.keys(a.blocks || {}).map((id) => `${slug}:${id}`));
        throw new Error(
          `No mapped schema for "${args.app_block_id}". Mapped: ${known.join(', ')}. ` +
          'For other app blocks, read a configured instance with get_workflow, or see config-keys.json.');
      }
      const { slug, app, block } = hit;
      return {
        app: slug,
        app_title: app.title,
        source: app.source,
        app_block_id: args.app_block_id,
        ...block,
        connection: app.connection,
        connection_failure: app.connection_failure,
        app_guidance: app.guidance,
        app_notes: app.global_notes,
        ...(TARGET_FORMATS[args.app_block_id] ? { workflow_id_format: TARGET_FORMATS[args.app_block_id].hint } : {}),
        reference: capReference(capForAppBlock(args.app_block_id, slug)),
      };
    },
  },

  app_workflow_target: {
    description:
      'Build the workflow_id value that Advanced Workflow Automations\' "Schedule a workflow run" ' +
      '(j-schedule-record) and "Call a subflow" (j-subflow-run) expect: an encoded tuple of the TARGET ' +
      'workflow id, its start trigger\'s block id and (subflows) a signature of its output names. ' +
      'Reads the target\'s active version (else draft). Also returns the target\'s input keys for named_inputs. ' +
      'The target must be turned on in Attio before the step can use it.',
    inputSchema: scoped({
      workflow_id: { type: 'string', description: 'The TARGET workflow, i.e. the one being scheduled or called.' },
    }, ['workflow_id']),
    async run(args) {
      const ctx = ctxFrom(args);
      const wf = await getWorkflow(args.workflow_id, ctx);
      const def = await readDefinition(args.workflow_id, readVersionOf(wf), ctx);
      const names = (node) => ((node && node.items) || [])
        .map((r) => constString(r && r.entries && r.entries.name))
        .filter((n) => typeof n === 'string');
      const targets = [];
      for (const b of def.blocks) {
        const id = b.provider && b.provider.app_block_id;
        if (id === 'j-scheduled-record') {
          targets.push({
            start_trigger: 'Start a scheduled run', entry_point_id: b.block_id,
            for_step: 'j-schedule-record',
            workflow_id_value: JSON.stringify([wf.workflow_id, b.block_id]),
          });
        } else if (id === 'j-subflow-start') {
          const e = (b.config && b.config.entries) || {};
          const outputs = names(e.output_definitions);
          targets.push({
            start_trigger: 'Start a subflow', entry_point_id: b.block_id,
            for_step: 'j-subflow-run',
            workflow_id_value: JSON.stringify([wf.workflow_id, b.block_id, subflowOutputSignature(outputs)]),
            input_keys: names(e.input_definitions).map(subflowFieldKey),
            output_keys: outputs.map(subflowFieldKey),
          });
        }
      }
      if (!targets.length) {
        throw new Error(
          `"${wf.title}" has no "Start a scheduled run" or "Start a subflow" trigger, so it cannot be ` +
          'scheduled or called. Add one (Advanced Workflow Automations) and turn the workflow on.');
      }
      return {
        workspace: ctx.slug,
        target_workflow: wf.title,
        target_status: wf.status,
        ...(wf.status !== 'live'
          ? { warning: `Target is "${wf.status}". It must be turned on in Attio before a step can schedule or call it.` }
          : {}),
        note: 'Write workflow_id_value as a constant string node: {"type":"string","value":<workflow_id_value>}. ' +
              'A subflow\'s signature changes whenever its output names change; rebuild this value then.',
        targets,
      };
    },
  },

  list_attributes: {
    description:
      'List an object\'s attributes with their attribute_definition_id, api_slug, title and type. ' +
      'Variable paths that read a field off a record need these UUIDs (operations[] of type ' +
      '"attribute-definition"), and configs never accept slugs. Pass object as an api_slug or a UUID.',
    inputSchema: scoped({
      object: { type: 'string', description: 'api_slug (e.g. "companies") or entity_definition_id.' },
      include_archived: { type: 'boolean', description: 'Default false.' },
    }, ['object']),
    async run(args = {}) {
      const ctx = ctxFrom(args);
      let eid = args.object;
      if (!/^[0-9a-f-]{36}$/i.test(eid)) {
        const defs = await api('/entity-definitions', { ctx });
        const hit = defs.find((d) => d.api_slug === eid);
        if (!hit) {
          throw new Error(
            `No object with api_slug "${eid}" in ${ctx.slug}. ` +
            `Available: ${defs.filter((d) => !d.is_archived).map((d) => d.api_slug).join(', ')}`);
        }
        eid = hit.entity_definition_id;
      }
      const attrs = unwrap(await api(`/entity-definitions/${eid}/attribute-definitions`, { ctx }));
      return {
        workspace: ctx.slug,
        entity_definition_id: eid,
        count: attrs.length,
        note: 'Select/status OPTION ids are not on this internal API. Read them from the public API: ' +
              'GET /v2/objects/{slug}/attributes/{attr_slug}/options (or /statuses for pipelines).',
        attributes: attrs
          .filter((a) => args.include_archived || !a.is_archived)
          .map((a) => ({
            attribute_definition_id: a.attribute_definition_id,
            api_slug: a.api_slug,
            title: a.title,
            type: a.type,
            is_multiselect: a.is_multiselect,
            is_required: a.is_required,
            is_archived: a.is_archived,
          })),
      };
    },
  },

  list_block_outputs: {
    description:
      'What output fields a block type exposes to downstream steps, i.e. what you can build a variable ' +
      'from. Attio publishes no schema for this, so this catalog is harvested from real workflows its ' +
      'own UI wrote. Observational: a missing field means "never observed", not "invalid". ' +
      'Omit block_slug to list every block type in the catalog.',
    inputSchema: {
      type: 'object',
      properties: {
        block_slug: { type: 'string', description: 'e.g. "find-records" or "find-records@v1".' },
      },
    },
    async run(args = {}) {
      if (!args.block_slug) {
        return {
          source: 'harvested from live workflows; observational, not authoritative',
          legend: 'fields = real config keys, usable now. picker = field COUNT read off the UI ' +
                  'variable picker, where field_count 0 means the block emits nothing at all.',
          blocks: Object.entries(BLOCK_OUTPUTS).map(([k, v]) => ({
            block: k, block_type: v.block_type, outcomes: v.outcomes, fields: Object.keys(v.fields),
          })),
        };
      }
      const want = args.block_slug;
      const bare = want.split('@')[0];
      const legacy = LEGACY_SCHEMAS.blocks && LEGACY_SCHEMAS.blocks[bare];
      const key = BLOCK_OUTPUTS[want]
        ? want
        : Object.keys(BLOCK_OUTPUTS).find((k) => k.split('@')[0] === want.split('@')[0]);
      const app = !key && !legacy ? findAppBlock(bare) : null;
      if (app) {
        const ref = capForAppBlock(bare, app.slug);
        return {
          block: bare,
          app: app.slug,
          source: `app source (${app.app.source}), not harvested`,
          outcomes: app.block.outcomes,
          ...(ref ? { reference_outputs: ref.outputs, reference_evidence: bestEvidence(ref) } : {}),
        };
      }
      const refCap = capForSystemBlock(bare);
      if (!key && !legacy && refCap) {
        return {
          block: bare,
          source: 'reference catalog only (never harvested from a live workflow)',
          reference_outputs: refCap.outputs,
          reference_evidence: bestEvidence(refCap),
        };
      }
      if (!key && !legacy) {
        throw new Error(
          `No observed outputs for "${want}". Known: ${Object.keys(BLOCK_OUTPUTS).join(', ')}. ` +
          `To learn an unknown block, wire it once in the UI and read the config back with get_workflow.`);
      }
      const res = key ? { block: key, ...BLOCK_OUTPUTS[key] } : { block: bare, fields: {} };
      if (legacy) {
        res.legacy_schema = {
          outputs: Object.keys(legacy.outputs || {}),
          inputs: Object.keys(legacy.inputs || {}),
          source: 'server-provided, from a legacy workflow snapshot',
          warning: LEGACY_SCHEMAS._warning,
        };
      }
      if (refCap) {
        res.reference_outputs = refCap.outputs;
        res.reference_evidence = bestEvidence(refCap);
      }
      return res;
    },
  },

  list_available_variables: {
    description:
      'The headless equivalent of Attio\'s variable picker. Given a block, walks every upstream block ' +
      'that can reach it and returns the variable nodes you can paste straight into that block\'s config. ' +
      'Use this instead of hand-writing matchers: it fills in block_instance_id, outcome and operations, ' +
      'and generates the matcher id. Set object to also expand record fields into attribute paths.',
    inputSchema: scoped({
      workflow_id: { type: 'string' },
      block_id: { type: 'string', description: 'The block that will CONSUME the variable.' },
      expand_attributes_for: {
        type: 'string',
        description: 'Optional object api_slug or UUID. For fields that hold a record, also emit a ' +
                     'ready-made path per attribute of that object.',
      },
    }, ['workflow_id', 'block_id']),
    async run(args = {}) {
      const ctx = ctxFrom(args);
      const wf = await getWorkflow(args.workflow_id, ctx);
      const versionId = readVersionOf(wf);
      const def = await readDefinition(args.workflow_id, versionId, ctx);
      const target = def.blocks.find((b) => b.block_id === args.block_id);
      if (!target) {
        throw new Error(
          `Block ${args.block_id} is not in this workflow. Blocks: ` +
          def.blocks.map((b) => `${b.block_id} (${blockKey(b)})`).join(', '));
      }

      let attrs = null, attrObjId = null;
      if (args.expand_attributes_for) {
        const r = await TOOLS.list_attributes.run({ ...args, object: args.expand_attributes_for });
        attrs = r.attributes.filter((a) => !a.is_archived);
        attrObjId = r.entity_definition_id;
      }

      const upstream = upstreamOf(args.block_id, def.blocks, def.paths);
      const out = [];
      for (const { block, via_outcome, depth } of upstream) {
        const key = blockKey(block);
        const cat = BLOCK_OUTPUTS[key] || BLOCK_OUTPUTS[Object.keys(BLOCK_OUTPUTS).find((k) => k.split('@')[0] === String(key).split('@')[0])];
        const entry = {
          from_block_id: block.block_id,
          block: key,
          description: block.description || null,
          steps_upstream: depth,
          outcome: via_outcome || 'done',
          variables: [],
        };
        if (!cat) {
          entry.note = `No harvested output schema for "${key}". Wire it once in the UI and read it back.`;
        } else {
          for (const [field, meta] of Object.entries(cat.fields)) {
            entry.variables.push({
              path: field,
              observed_uses: meta.observed,
              ...(meta.type ? { type: meta.type } : {}),
              node: buildVariable(block.block_id, via_outcome || 'done', [field], meta.type),
            });
            if (meta.traversable_to_attributes && attrs) {
              for (const a of attrs) {
                entry.variables.push({
                  path: `${field}.${a.api_slug}`,
                  attribute: { api_slug: a.api_slug, title: a.title, type: a.type },
                  node: buildVariable(block.block_id, via_outcome || 'done',
                    [field, { attribute: a.attribute_definition_id, object: attrObjId }]),
                });
              }
            } else if (meta.traversable_to_attributes) {
              entry.variables.push({
                path: `${field}.<attribute>`,
                hint: 'This field holds a record. Pass expand_attributes_for=<object> to list its attributes.',
                example_paths: meta.example_paths || undefined,
              });
            }
          }
        }
        out.push(entry);
      }

      return {
        workspace: ctx.slug,
        workflow: wf.title,
        consuming_block: { block_id: target.block_id, block: blockKey(target) },
        upstream_blocks: out.length,
        note: out.length
          ? 'Paste a "node" value into the consuming block\'s config, then write it with set_block_config.'
          : 'No upstream blocks. Connect this block with connect_blocks first, or it can reference nothing.',
        available: out,
      };
    },
  },

  list_objects: {
    description:
      'List workspace objects (entity definitions) with their UUIDs. Config nodes reference objects by ' +
      'entity_definition_id, never by slug, so this is where those UUIDs come from.',
    inputSchema: scoped({ include_archived: { type: 'boolean', description: 'Default false.' } }),
    async run(args = {}) {
      const ctx = ctxFrom(args);
      const defs = await api('/entity-definitions', { ctx });
      return defs
        .filter((d) => args.include_archived || !d.is_archived)
        .map((d) => ({
          entity_definition_id: d.entity_definition_id,
          api_slug: d.api_slug,
          singular_noun: d.singular_noun,
          entity_type: d.entity_type,
        }));
    },
  },

  list_workflows: {
    description: 'List workflows in the workspace, with id, title and status.',
    inputSchema: scoped({ include_archived: { type: 'boolean', description: 'Default false.' } }),
    async run(args = {}) {
      const ctx = ctxFrom(args);
      const ids = await queryWorkflowIds(ctx, { includeArchived: args.include_archived });
      const out = [];
      for (const id of ids) {
        try {
          const wf = await getWorkflow(id, ctx);
          out.push({ workflow_id: wf.workflow_id, title: wf.title, status: wf.status });
        } catch (e) {
          out.push({ workflow_id: id, error: String(e.message || e) });
        }
      }
      return { workspace: ctx.slug, count: out.length, workflows: out };
    },
  },

  get_workflow: {
    description:
      'Read a workflow in full: metadata plus blocks, their configs and the paths between them. ' +
      'Reads the active version for live workflows, otherwise the draft. Pre-modern ("legacy") ' +
      'workflows have no versions and are read from their snapshot instead, transparently.',
    inputSchema: scoped({
      workflow_id: { type: 'string' },
      version: { type: 'string', enum: ['auto', 'draft', 'active'], description: 'Default auto.' },
    }, ['workflow_id']),
    async run(args) {
      const ctx = ctxFrom(args);
      const wf = await getWorkflow(args.workflow_id, ctx);
      const v = args.version || 'auto';

      // Legacy workflows have no versions at all; their definition is in snapshots.
      if (!wf.draft_workflow_version_id && !wf.active_workflow_version_id) {
        const snaps = await legacySnapshots(args.workflow_id, ctx);
        if (!snaps.length) {
          throw new Error(
            `Workflow "${wf.title}" has neither a version nor a snapshot. ` +
            `If you just created it, you probably omitted is_modern:true.`);
        }
        const snap = pickSnapshot(snaps, v);
        if (!snap) throw new Error(`No "${v}" snapshot. Available: ${snaps.map((x) => x.status).join(', ')}`);
        return {
          workflow_id: wf.workflow_id,
          title: wf.title,
          description: wf.description,
          status: wf.status,
          is_modern: wf.is_modern,
          legacy: true,
          note: 'Pre-modern workflow: read from a SNAPSHOT, not a version. Writes are not supported ' +
                'here, and block ids are snapshot node ids. Unlike modern blocks, each block carries ' +
                'its own inputs/outputs schema.',
          snapshot_id: snap.workflow_snapshot_id,
          snapshot_status: snap.status,
          snapshots: snaps.map((x) => ({ id: x.workflow_snapshot_id, status: x.status, created_at: x.created_at })),
          definition: await readLegacyDefinition(args.workflow_id, snap.workflow_snapshot_id, ctx),
        };
      }

      const versionId =
        v === 'draft' ? wf.draft_workflow_version_id
        : v === 'active' ? wf.active_workflow_version_id
        : readVersionOf(wf);
      if (!versionId) throw new Error(`Workflow has no "${v}" version.`);
      return {
        workflow_id: wf.workflow_id,
        title: wf.title,
        description: wf.description,
        status: wf.status,
        is_modern: wf.is_modern,
        draft_version_id: wf.draft_workflow_version_id,
        active_version_id: wf.active_workflow_version_id,
        definition: await readDefinition(args.workflow_id, versionId, ctx),
      };
    },
  },

  create_workflow: {
    description:
      'Create an empty workflow. Always sets is_modern:true so the draft version is provisioned. ' +
      'The result is always a draft and is never activated.',
    inputSchema: scoped({ title: { type: 'string' }, description: { type: 'string' } }, ['title']),
    async run(args) {
      const ctx = ctxFrom(args);
      const workflow_id = crypto.randomUUID();
      const wf = await api(`/workflows/${workflow_id}`, {
        method: 'PUT', ctx,
        body: { title: args.title, is_modern: true, ...(args.description ? { description: args.description } : {}) },
      });
      return {
        workspace: ctx.slug,
        workflow_id: wf.workflow_id,
        title: wf.title,
        status: wf.status,
        draft_version_id: wf.draft_workflow_version_id,
      };
    },
  },

  add_block: {
    description:
      'Add a block (trigger or step) to a workflow draft. config is required; pass {"type":"object","entries":{}} if empty. ' +
      'Use provider {type:"system",system_block_slug,system_block_version} or {type:"app",app_id,app_block_id} ' +
      '(take app providers from list_app_blocks). For mapped app blocks the config is checked first and the ' +
      'result carries app_block_review: relay its prerequisites (portal setup, plan) to the human.',
    inputSchema: scoped({
      workflow_id: { type: 'string' },
      block_type: { type: 'string', enum: ['trigger', 'step'] },
      provider: { type: 'object' },
      config: { type: 'object', description: 'Bare config node, NOT the {state,value} wrapper.' },
      position: { type: 'object', description: '{x,y}. Cosmetic only.' },
      description: { type: 'string' },
    }, ['workflow_id', 'block_type', 'provider']),
    async run(args) {
      const ctx = ctxFrom(args);
      const review = reviewAppBlock(args.provider, args.config);
      const wf = await draftTarget(args.workflow_id, ctx);
      const block_id = crypto.randomUUID();
      await api(`/workflows/${args.workflow_id}/versions/${wf.draft_workflow_version_id}/block-instances/${block_id}`, {
        method: 'PUT', ctx,
        body: {
          block_type: args.block_type,
          provider: args.provider,
          description: args.description ?? null,
          position: args.position ?? { x: 0, y: 0 },
          config: args.config ?? { type: 'object', entries: {} },
        },
      });
      return {
        block_id, version_id: wf.draft_workflow_version_id,
        ...(review ? { app_block_review: review } : {}),
        ...liveNote(wf),
      };
    },
  },

  set_block_config: {
    description:
      "Update an existing block's config. Required because PUT on an existing block-instance returns 409 " +
      '(create-only). Pass the bare config node; it is wrapped for you.',
    inputSchema: scoped({
      workflow_id: { type: 'string' },
      block_id: { type: 'string' },
      config: { type: 'object', description: 'Bare config node.' },
    }, ['workflow_id', 'block_id', 'config']),
    async run(args) {
      const ctx = ctxFrom(args);
      const wf = await draftTarget(args.workflow_id, ctx);
      const b = `/workflows/${args.workflow_id}/versions/${wf.draft_workflow_version_id}/block-instances/${args.block_id}`;
      const instance = unwrap(await api(b, { ctx }));
      const review = reviewAppBlock(instance && instance.provider, args.config);
      await api(`${b}/config`, { method: 'PUT', ctx, body: { config: args.config } });
      const back = await api(`${b}/config`, { ctx });
      return {
        block_id: args.block_id, config_state: back.config.state, config: back.config.value,
        ...(review ? { app_block_review: review } : {}),
        ...liveNote(wf),
      };
    },
  },

  update_block: {
    description:
      "Update a block's metadata: its description (the caption shown ON the block in the editor) and its " +
      'position. Both are block-instance fields, NOT config — setting them through set_block_config does ' +
      'nothing. There is no "organize blocks" endpoint: laying a canvas out means giving each block ' +
      'distinct {x,y} coordinates here, or they stack on top of each other. The editor grid runs roughly ' +
      'x: 160 / 430 / 700 by depth, y in rows per branch.',
    inputSchema: scoped({
      workflow_id: { type: 'string' },
      block_id: { type: 'string' },
      description: { type: 'string', description: 'Caption on the block. Pass "" to clear it.' },
      position: { type: 'object', description: '{x,y}. Cosmetic, but blocks stack without it.' },
    }, ['workflow_id', 'block_id']),
    async run(args) {
      if (args.description === undefined && args.position === undefined) {
        throw new Error('Nothing to update: pass description, position, or both.');
      }
      const ctx = ctxFrom(args);
      const wf = await draftTarget(args.workflow_id, ctx);
      const p = `/workflows/${args.workflow_id}/versions/${wf.draft_workflow_version_id}/block-instances/${args.block_id}`;
      const body = {};
      if (args.description !== undefined) body.description = args.description;
      if (args.position !== undefined) body.position = args.position;
      await api(p, { method: 'PATCH', ctx, body });
      const back = unwrap(await api(p, { ctx }));
      return {
        block_id: args.block_id,
        description: back.description,
        position: back.position,
        ...liveNote(wf),
      };
    },
  },

  connect_blocks: {
    description:
      'Create an edge. outcome is "done" for normal steps, "true"/"false" for branch, ' +
      'or "case_<caseId>" for switch (must match cases[].id in the switch config).',
    inputSchema: scoped({
      workflow_id: { type: 'string' },
      source_block_id: { type: 'string' },
      outcome: { type: 'string' },
      target_block_id: { type: 'string' },
    }, ['workflow_id', 'source_block_id', 'outcome', 'target_block_id']),
    async run(args) {
      const ctx = ctxFrom(args);
      const wf = await draftTarget(args.workflow_id, ctx);
      const path_id = crypto.randomUUID();
      await api(`/workflows/${args.workflow_id}/versions/${wf.draft_workflow_version_id}/paths/${path_id}`, {
        method: 'PUT', ctx,
        body: {
          source: { workflow_version_block_instance_id: args.source_block_id, outcome: args.outcome },
          target: { workflow_version_block_instance_id: args.target_block_id },
        },
      });
      return { path_id, ...liveNote(wf) };
    },
  },

  clone_workflow: {
    description:
      'Clone any workflow (including a live one) into a new draft. Reads the source active version by default, ' +
      'remaps all block ids everywhere in configs, preserves switch case_* outcomes, and verifies the result. ' +
      'Source and destination must be in the same workspace.',
    inputSchema: scoped({
      source_workflow_id: { type: 'string' },
      new_title: { type: 'string' },
      source_version: { type: 'string', enum: ['auto', 'draft', 'active'] },
    }, ['source_workflow_id', 'new_title']),
    async run(args) {
      const ctx = ctxFrom(args);
      const src = await getWorkflow(args.source_workflow_id, ctx);
      const sv = args.source_version || 'auto';
      const srcVersionId =
        sv === 'draft' ? src.draft_workflow_version_id
        : sv === 'active' ? src.active_workflow_version_id
        : readVersionOf(src);
      const def = await readDefinition(args.source_workflow_id, srcVersionId, ctx);

      const created = await TOOLS.create_workflow.run({
        title: args.new_title,
        description: src.description || undefined,
        workspace_slug: args.workspace_slug,
        profile: args.profile,
      });
      const V = `/workflows/${created.workflow_id}/versions/${created.draft_version_id}`;

      const idMap = {};
      for (const b of def.blocks) idMap[b.block_id] = crypto.randomUUID();

      for (const b of def.blocks) {
        await api(`${V}/block-instances/${idMap[b.block_id]}`, {
          method: 'PUT', ctx,
          body: {
            block_type: b.block_type,
            provider: b.provider,
            description: b.description,
            position: b.position,
            config: b.config ? remapIds(b.config, idMap) : { type: 'object', entries: {} },
          },
        });
      }
      for (const p of def.paths) {
        await api(`${V}/paths/${crypto.randomUUID()}`, {
          method: 'PUT', ctx,
          body: {
            source: { workflow_version_block_instance_id: idMap[p.source_block_id], outcome: p.outcome },
            target: { workflow_version_block_instance_id: idMap[p.target_block_id] },
          },
        });
      }

      // Verify: configs must match the source once ids are normalized back.
      const clone = await readDefinition(created.workflow_id, created.draft_version_id, ctx);
      const inv = {};
      for (const [o, n] of Object.entries(idMap)) inv[n] = o;
      const norm = (o) => {
        let s = JSON.stringify(o);
        for (const [n, o2] of Object.entries(inv)) s = s.split(n).join(o2);
        return s;
      };
      const key = (b) => `${b.block_type}|${b.provider.system_block_slug || b.provider.app_block_id}|${b.position.x},${b.position.y}`;
      const mismatches = [];
      for (const s of def.blocks) {
        const c = clone.blocks.find((x) => key(x) === key(s));
        if (!c) { mismatches.push(`missing block ${key(s)}`); continue; }
        if (norm(c.config) !== JSON.stringify(s.config)) mismatches.push(`config differs on ${key(s)}`);
      }
      const stale = Object.keys(idMap).filter((oldId) => JSON.stringify(clone.blocks).includes(oldId));

      return {
        workspace: ctx.slug,
        workflow_id: created.workflow_id,
        title: args.new_title,
        status: 'draft',
        blocks_created: def.blocks.length,
        paths_created: def.paths.length,
        verification: {
          all_configs_match: mismatches.length === 0,
          mismatches,
          stale_source_ids: stale,
          config_states: clone.blocks.map((b) => b.config_state),
        },
      };
    },
  },

  // NOTE: There is deliberately NO publish/activate tool.
  // This server builds and modifies drafts only, so nothing here can make a
  // workflow start firing on real data. Publishing is a human action in the
  // Attio UI. deactivate_workflow is kept because turning something OFF is a
  // safety valve, not a publishing capability.

  deactivate_workflow: {
    description:
      'Take a live workflow off. Sets status to "paused" and clears active_workflow_version_id.',
    inputSchema: scoped({ workflow_id: { type: 'string' } }, ['workflow_id']),
    async run(args) {
      const ctx = ctxFrom(args);
      const wf = await getWorkflow(args.workflow_id, ctx);
      if (!wf.active_workflow_version_id) {
        return { workflow_id: args.workflow_id, status: wf.status, note: 'Already not active; nothing to do.' };
      }
      await api(`/workflows/${args.workflow_id}/versions/${wf.active_workflow_version_id}/deactivate`, {
        method: 'POST', ctx, body: {},
      });
      const after = await getWorkflow(args.workflow_id, ctx);
      return { workflow_id: args.workflow_id, status: after.status, active_version_id: after.active_workflow_version_id };
    },
  },

  delete_workflow: {
    description:
      'Delete a workflow. Deleting a LIVE workflow requires confirm_delete_live:true, because that is ' +
      'destructive and irreversible, unlike editing a draft.',
    inputSchema: scoped({
      workflow_id: { type: 'string' },
      confirm_delete_live: { type: 'boolean', description: 'Required only when the workflow is live.' },
    }, ['workflow_id']),
    async run(args) {
      const ctx = ctxFrom(args);
      const wf = await getWorkflow(args.workflow_id, ctx);
      if (wf.status === 'live' && args.confirm_delete_live !== true) {
        throw new Error(
          `"${wf.title}" is LIVE. Deleting it is destructive and irreversible. ` +
          `Pass confirm_delete_live:true if that is really intended.`
        );
      }
      await api(`/workflows/${args.workflow_id}`, { method: 'DELETE', ctx });
      let gone = false;
      try { await getWorkflow(args.workflow_id, ctx); } catch { gone = true; }
      return { deleted: true, title: wf.title, verified_gone: gone };
    },
  },

  // ---------------------------------------------------------------- lists
  //
  // Lists straddle the two APIs. Creation is public-API only (the internal one
  // has no create route), while deletion is internal-API only (the public one
  // has no DELETE /v2/lists/{id} at all). So create_list needs the API key and
  // delete_list needs the cookie.

  list_lists: {
    description:
      'List every LIST in the workspace, with id, name and icon. Lists are entity-definitions but are ' +
      'NOT returned by /entity-definitions, so this is the only way to discover them on the cookie ' +
      'alone — `preflight` also has them but needs an API key. The id returned here is the list_id AND ' +
      'its entity_definition_id; pass it as `object` to the view, attribute and option tools.',
    inputSchema: scoped({}),
    async run(args = {}) {
      const ctx = ctxFrom(args);
      const r = await api('/collections', { ctx });
      const rows = (r && (r.values || r.value)) || [];
      return {
        count: rows.length,
        lists: rows
          .map((c) => ({
            list_id: c.id,
            name: c.name,
            is_public: c.is_public,
            created_at: c.created_at,
          }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      };
    },
  },

  create_list: {
    description:
      'Create a LIST. This is the one write here that goes to the PUBLIC API, so it needs an API key ' +
      '(~/.attio-apikey) rather than the session cookie. `api_slug` must be snake_case — Attio rejects ' +
      'kebab-case with a validation error. Returns the list_id, which doubles as its ' +
      'entity_definition_id everywhere else in this server.',
    inputSchema: scoped({
      name: { type: 'string', description: 'Display name, e.g. "Active Prospects".' },
      api_slug: { type: 'string', description: 'snake_case slug. Defaults to a slugified `name`.' },
      parent_object: { type: 'string', description: 'Object api_slug the list hangs off, e.g. "companies".' },
      workspace_access: {
        type: 'string',
        description: '"full-access" (default), "read-and-write", "read-only", or null for private.',
      },
      api_key: { type: 'string', description: 'Overrides the stored key. Usually unnecessary.' },
    }, ['name', 'parent_object']),
    async run(args) {
      const ctx = ctxFrom(args);
      const key = apiKeyFor(ctx.profile, args.api_key);
      if (!key) {
        throw new Error('create_list needs an API key: list creation is not on the internal API. ' +
          'Save one to ' + apiKeyPath(ctx.profile) + '.');
      }
      const slug = args.api_slug || String(args.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      if (!/^[a-z][a-z0-9_]*$/.test(slug)) {
        throw new Error(`"${slug}" is not a valid slug. Attio requires snake_case, e.g. "active_prospects".`);
      }
      const created = await publicApi('/lists', key, {
        method: 'POST',
        body: {
          data: {
            name: args.name,
            api_slug: slug,
            parent_object: args.parent_object,
            workspace_access: args.workspace_access === undefined ? 'full-access' : args.workspace_access,
            workspace_member_access: [],
          },
        },
      });
      const list_id = created && created.id && created.id.list_id;
      return {
        list_id,
        name: created.name,
        api_slug: created.api_slug,
        parent_object: created.parent_object,
        workspace_access: created.workspace_access,
        note: 'This id is also its entity_definition_id — pass it as `object` to list_views, ' +
          'create_view, list_attributes and the option tools.',
      };
    },
  },

  delete_list: {
    description:
      'Delete a LIST and everything in it: its views, its list-specific attributes, and its entries. ' +
      'NOT REVERSIBLE. The public API has no delete route for lists; this is the internal one. Note the ' +
      'path is /collections/{id}, not /entity-definitions/{id} — the latter returns "The Entry Entity ' +
      'Definition cannot be deleted". Verifies the list is actually gone before reporting success, ' +
      'because the SPA answers unknown paths with an empty 200.',
    inputSchema: scoped({
      list_id: { type: 'string', description: 'The list uuid.' },
      confirm_name: {
        type: 'string',
        description: "The list's exact name, as a guard against deleting the wrong one. Required.",
      },
      api_key: { type: 'string', description: 'Used only to verify deletion afterwards. Optional.' },
    }, ['list_id', 'confirm_name']),
    async run(args) {
      const ctx = ctxFrom(args);
      if (!UUID_RE.test(args.list_id)) {
        throw new Error(`"${args.list_id}" is not a uuid. delete_list takes a list_id, not a slug.`);
      }
      const def = await resolveEntityDef(args.list_id, ctx);
      if (def.entity_type !== 'collection-entry') {
        throw new Error(
          `${args.list_id} is not a list (entity_type "${def.entity_type}"). delete_list refuses to ` +
          'touch objects — deleting an object would take every record with it.'
        );
      }
      // Compare loosely: the caller may have the display name ("ZZ Test List")
      // while this resolves to the slug ("zz_test_list").
      const loose = (s) => String(s).trim().toLowerCase().replace(/[\s_-]+/g, '');
      const actual = def.api_slug || '';
      if (loose(actual) !== loose(args.confirm_name)) {
        throw new Error(
          `confirm_name "${args.confirm_name}" does not match this list (api_slug "${actual}"). ` +
          'Pass the list name or its slug exactly.'
        );
      }
      await api(`/collections/${args.list_id}`, { method: 'DELETE', ctx });
      // An empty 200 proves nothing — the SPA returns one for unknown paths too.
      //
      // Verify against /collections/{id}, NOT /entity-definitions/{id}: deleting
      // a list leaves its *entry* entity-definition behind, so the entity route
      // keeps serving a 200 for a list that is genuinely gone (the public API
      // 404s it and it vanishes from the catalogue). That stale read is also why
      // DELETE /entity-definitions/{id} answers "The Entry Entity Definition
      // cannot be deleted". [VERIFIED 2026-09-03]
      let verified_gone = false;
      try {
        await api(`/collections/${args.list_id}`, { ctx });
      } catch (e) {
        verified_gone = /HTTP 404/.test(e.message);
      }
      return {
        deleted: verified_gone,
        list_id: args.list_id,
        api_slug: actual,
        verified_gone,
        ...(verified_gone ? {} : {
          warning: 'Attio accepted the DELETE but the collection still reads back. Treat it as NOT deleted.',
        }),
      };
    },
  },

  // ---------------------------------------------------------------- views

  list_views: {
    description:
      "List an object's or list's views. `object` takes an object api_slug (\"companies\") or a uuid; " +
      'a LIST is addressed by its uuid, because lists are entity-definitions too.',
    inputSchema: scoped({
      object: { type: 'string', description: 'Object api_slug, or an object/list uuid.' },
      include_archived: { type: 'boolean', description: 'Default false.' },
    }, ['object']),
    async run(args) {
      const ctx = ctxFrom(args);
      const def = await resolveEntityDef(args.object, ctx);
      const views = unwrap(await api(viewsBase(def.entity_definition_id), { ctx }));
      const rows = views
        .filter((v) => args.include_archived || !v.is_archived)
        .map((v) => ({
          entity_view_id: v.entity_view_id,
          title: v.title,
          type: v.type,
          entity_filter_id: v.entity_filter_id,
          sort_order: v.sort_order,
          is_archived: v.is_archived,
        }));
      return { entity_definition_id: def.entity_definition_id, object: def.api_slug, count: rows.length, views: rows };
    },
  },

  get_view: {
    description:
      'Read one view in full: its metadata, its columns (with attribute slugs resolved), its sorts, and ' +
      'its stored filter blocks. **This is the ground truth for filter shapes.** To learn how Attio ' +
      'stores a filter on an attribute type not yet in CONSTRAINT_KINDS, build that filter once in the ' +
      'UI and read it back here rather than guessing the field names.',
    inputSchema: scoped({
      object: { type: 'string', description: 'Object api_slug, or an object/list uuid.' },
      view_id: { type: 'string' },
    }, ['object', 'view_id']),
    async run(args) {
      const ctx = ctxFrom(args);
      const def = await resolveEntityDef(args.object, ctx);
      const base = `${viewsBase(def.entity_definition_id)}/${args.view_id}`;
      const view = unwrap(await api(base, { ctx }));
      const [cols, sorts] = await Promise.all([
        api(`${base}/entity-view-attributes`, { ctx }).then(unwrap).catch(() => []),
        api(`${base}/entity-view-sorts`, { ctx }).then(unwrap).catch(() => []),
      ]);

      // Name the attributes so the caller sees slugs rather than a wall of uuids.
      const attrs = unwrap(await api(`/entity-definitions/${def.entity_definition_id}/attribute-definitions`, { ctx }));
      const nameOf = new Map(attrs.map((a) => [a.attribute_definition_id, a.api_slug || a.title]));

      let filter_blocks = [];
      if (view.entity_filter_id) {
        filter_blocks = await api(
          `/entity-definitions/${def.entity_definition_id}/entity-filters/${view.entity_filter_id}/entity-filter-blocks`,
          { ctx }
        ).then(unwrap).catch(() => []);
      }

      let stage_columns = null;
      if (view.type === 'kanban' && view.kanban_pivot_path && view.kanban_pivot_path.length) {
        stage_columns = (await readKanbanColumns(def.entity_definition_id, args.view_id, ctx).catch(() => null));
      }

      return {
        entity_definition_id: def.entity_definition_id,
        view: {
          entity_view_id: view.entity_view_id, title: view.title, type: view.type,
          entity_filter_id: view.entity_filter_id, is_archived: view.is_archived,
          ...(view.type === 'kanban' ? {
            kanban: {
              group_by: (view.kanban_pivot_path || []).map((h) => nameOf.get(h.attribute_definition_id) || h.attribute_definition_id),
              group_by_raw: view.kanban_pivot_path,
              show_no_status: view.kanban_is_no_status_visible,
              show_time_in_status: view.kanban_is_time_in_status_visible,
              label_display_mode: view.kanban_attribute_label_display_mode,
              aggregation: view.kanban_aggregation,
              ...(stage_columns ? {
                visible_stages: stage_columns.columns.filter((c) => c.visible).map((c) => c.title),
                hidden_stages: stage_columns.columns.filter((c) => !c.visible).map((c) => c.title),
              } : {}),
            },
          } : {}),
        },
        columns: (cols || []).map((c) => ({
          entity_view_attribute_id: c.entity_view_attribute_id,
          sort_order: c.sort_order,
          title: c.title,
          hops: (c.path || []).length,
          path: (c.path || []).map((h) => nameOf.get(h.attribute_definition_id) || h.attribute_definition_id),
          raw_path: c.path,
        })),
        sorts: sorts || [],
        filter_blocks,
      };
    },
  },

  create_view: {
    description:
      'Create a view, optionally with columns and filters in the same call. The client mints the id, so ' +
      'the view exists at a URL you already know. An EMPTY filter container is fine — `entity_filter_id` ' +
      'is just a uuid the view points at, and filters are additive afterwards. type "table" (default) or ' +
      '"kanban". A kanban board groups by a STATUS attribute (group_by); on deals that may be Deal stage ' +
      '(the default there) or any other status attribute. On every other object or list, group_by is ' +
      'required, and the object must already have a status attribute.',
    inputSchema: scoped({
      object: { type: 'string', description: 'Object api_slug, or an object/list uuid.' },
      title: { type: 'string' },
      type: { type: 'string', enum: ['table', 'kanban'], description: 'Default "table".' },
      group_by: {
        type: 'string',
        description:
          'Kanban only. Status attribute (api_slug, title or uuid) whose options become the columns. ' +
          'Defaults to "stage" on deals; required elsewhere. Non-status attributes are refused.',
      },
      show_no_status: {
        type: 'boolean',
        description: 'Kanban only. Show the "No status" column for records with no value. Default true.',
      },
      show_time_in_status: {
        type: 'boolean',
        description: 'Kanban only. Show time-in-status on cards. Default true.',
      },
      visible_stages: {
        type: 'array',
        description:
          'Kanban only. Stage titles (or ids) to show as columns; every other stage is hidden on this board. ' +
          'Omit to show all. This is the board settings column toggle, NOT a filter. Change later with ' +
          'set_kanban_columns.',
      },
      columns: {
        type: 'array',
        description:
          'Attribute api_slugs or uuids. For a column that reads through a link, pass an array of hops ' +
          'instead: [{"attribute":"parent_record"},{"object":"people","attribute":"email_addresses"}].',
      },
      filters: {
        type: 'array',
        description:
          'Each: {attribute, value, kind, op}. kind is "actor" | "select" | "status" | "generic" (default). ' +
          'For status, value is a stage title/id or an array of them ("is any of"). ' +
          'op "eq" (default) or "is_not". For select, value is an option_id — use resolve to get one. ' +
          'For actor, value "current-member" makes a per-viewer dynamic filter.',
      },
    }, ['object', 'title']),
    async run(args) {
      const ctx = ctxFrom(args);
      const def = await resolveEntityDef(args.object, ctx);
      // View creation on a LIST works. An earlier note here recorded it as
      // rejected with a 404 and made this tool refuse outright; re-tested end to
      // end on 2026-09-03 (create view, multi-hop parent_record column, actor
      // filter, read back) and every step returned 200. Whatever the 404 was, it
      // was not a standing limit. [VERIFIED 2026-09-03]
      const type = args.type || 'table';
      if (!['table', 'kanban'].includes(type)) throw new Error(`type must be "table" or "kanban", got "${type}".`);
      if (type === 'table' && (args.group_by || args.visible_stages || args.show_no_status !== undefined || args.show_time_in_status !== undefined)) {
        throw new Error('group_by / visible_stages / show_no_status / show_time_in_status apply to kanban views only. Pass type "kanban".');
      }

      // Resolve the pivot BEFORE writing anything, so a bad group_by leaves no half-made view.
      const pivot = type === 'kanban' ? await resolveKanbanPivot(def, args.group_by, ctx) : null;

      const view_id = crypto.randomUUID();
      const entity_filter_id = crypto.randomUUID();

      // Kanban field shapes captured from three UI-built deal boards and confirmed by
      // PUT + read-back on deals and a custom object, 2026-11-06. kanban_aggregation is
      // deliberately null: PUT silently drops it, and only its `type` is validated by
      // Attio (a bogus `field` is stored as-is), so it is not set until a UI capture of
      // each aggregation exists. Label display mode "icon" is the only value seen.
      // [VERIFIED 2026-11-06]
      await api(`${viewsBase(def.entity_definition_id)}/${view_id}`, {
        method: 'PUT', ctx,
        body: {
          entity_filter_id,
          title: args.title,
          type,
          sort_order: sortKey(0),
          kanban_aggregation: null,
          kanban_pivot_path: pivot
            ? [{ entity_definition_id: def.entity_definition_id, attribute_definition_id: pivot.attribute_definition_id }]
            : null,
          kanban_attribute_label_display_mode: pivot ? 'icon' : null,
          kanban_is_no_status_visible: pivot ? args.show_no_status !== false : null,
          kanban_is_time_in_status_visible: pivot ? args.show_time_in_status !== false : null,
        },
      });

      const columns = [];
      let i = 1;
      for (const c of args.columns || []) {
        const path = await buildPath(def.entity_definition_id, c, ctx);
        const id = crypto.randomUUID();
        await api(`${viewsBase(def.entity_definition_id)}/${view_id}/entity-view-attributes/${id}`, {
          method: 'PUT', ctx, body: { path, field: null, sort_order: sortKey(i++) },
        });
        columns.push({ entity_view_attribute_id: id, hops: path.length });
      }

      let filters_applied = 0;
      if (args.filters && args.filters.length) {
        const blocks = await buildFilterBlocks(def.entity_definition_id, args.filters, ctx);
        await api(`/entity-definitions/${def.entity_definition_id}/entity-filters/${entity_filter_id}/entity-filter-blocks`, {
          method: 'PUT', ctx, body: blocks,
        });
        filters_applied = args.filters.length;
      }

      let stage_columns = null;
      if (type === 'kanban' && args.visible_stages) {
        stage_columns = await setKanbanColumns(def.entity_definition_id, view_id, { show: args.visible_stages }, ctx);
      }

      return {
        entity_view_id: view_id,
        entity_filter_id,
        title: args.title,
        type,
        ...(pivot ? { group_by: { api_slug: pivot.api_slug, title: pivot.title, attribute_definition_id: pivot.attribute_definition_id } } : {}),
        entity_definition_id: def.entity_definition_id,
        columns_added: columns.length,
        filters_applied,
        ...(stage_columns ? { visible_stages: stage_columns.visible, hidden_stages: stage_columns.hidden } : {}),
        url: viewUrl(ctx, def, view_id),
      };
    },
  },

  add_view_column: {
    description:
      'Append one column to an existing view. `attribute` is an api_slug or uuid, or an array of hops ' +
      'to read a field off a linked record: [{"attribute":"parent_record"},{"object":"people",' +
      '"attribute":"email_addresses"}]. On a LIST, the first hop is usually `parent_record`, which the ' +
      'public API does not expose at all.',
    inputSchema: scoped({
      object: { type: 'string', description: 'Object api_slug, or an object/list uuid.' },
      view_id: { type: 'string' },
      attribute: { type: ['string', 'array'], description: 'Slug/uuid, or an array of {object, attribute} hops.' },
    }, ['object', 'view_id', 'attribute']),
    async run(args) {
      const ctx = ctxFrom(args);
      const def = await resolveEntityDef(args.object, ctx);
      const base = `${viewsBase(def.entity_definition_id)}/${args.view_id}`;
      const existing = unwrap(await api(`${base}/entity-view-attributes`, { ctx }).catch(() => []));
      const path = await buildPath(def.entity_definition_id, args.attribute, ctx);
      const id = crypto.randomUUID();
      await api(`${base}/entity-view-attributes/${id}`, {
        method: 'PUT', ctx,
        body: { path, field: null, sort_order: sortKey((existing || []).length + 1) },
      });
      return { entity_view_attribute_id: id, hops: path.length, path, column_count: (existing || []).length + 1 };
    },
  },

  set_view_filters: {
    description:
      "REPLACE a view's filters. The filter-blocks PUT is a full replace, so pass every filter you want " +
      'kept; an empty array clears them. Filter constraint field names are per attribute TYPE and are ' +
      'not derivable, so only captured kinds are accepted: "actor", "select" and "status" are verified ' +
      'against real traffic, "generic" (scalar equality) is NOT — verify it with get_view before relying on it. ' +
      'kind "status" (any status attribute, incl. Deal stage) takes stage titles or ids, singly or as an ' +
      'array: an array with op "eq" means "is any of", with op "is_not" means "is none of".',
    inputSchema: scoped({
      object: { type: 'string', description: 'Object api_slug, or an object/list uuid.' },
      view_id: { type: 'string' },
      filters: {
        type: 'array',
        description: 'Each: {attribute, value, kind, op}. Empty array clears all filters.',
      },
    }, ['object', 'view_id', 'filters']),
    async run(args) {
      const ctx = ctxFrom(args);
      const def = await resolveEntityDef(args.object, ctx);
      const view = unwrap(await api(`${viewsBase(def.entity_definition_id)}/${args.view_id}`, { ctx }));
      if (!view.entity_filter_id) throw new Error('This view has no entity_filter_id to write filters into.');
      const blocks = args.filters.length
        ? await buildFilterBlocks(def.entity_definition_id, args.filters, ctx)
        : [];
      await api(`/entity-definitions/${def.entity_definition_id}/entity-filters/${view.entity_filter_id}/entity-filter-blocks`, {
        method: 'PUT', ctx, body: blocks,
      });
      const back = await api(
        `/entity-definitions/${def.entity_definition_id}/entity-filters/${view.entity_filter_id}/entity-filter-blocks`,
        { ctx }
      ).then(unwrap).catch(() => []);
      return {
        entity_view_id: args.view_id,
        filters_written: args.filters.length,
        blocks_stored: (back || []).length,
        stored: back,
      };
    },
  },

  set_kanban_columns: {
    description:
      "Choose which stage columns a kanban board shows. This is the board's settings-menu column toggle, " +
      'stored per board and per stage; it is NOT a filter (a filter hides cards, not columns). Pass `show` ' +
      'for the exact visible set (everything else hidden), or `hide` / `unhide` to change only the stages ' +
      'named. Stage names are validated before anything is written. Returns the visible and hidden stages ' +
      'read back from Attio.',
    inputSchema: scoped({
      object: { type: 'string', description: 'Object api_slug, or an object/list uuid.' },
      view_id: { type: 'string' },
      show: { type: 'array', description: 'Stage titles or ids to show; all other stages are hidden.' },
      hide: { type: 'array', description: 'Stage titles or ids to hide. Others unchanged.' },
      unhide: { type: 'array', description: 'Stage titles or ids to show again. Others unchanged.' },
    }, ['object', 'view_id']),
    async run(args) {
      const ctx = ctxFrom(args);
      const def = await resolveEntityDef(args.object, ctx);
      const r = await setKanbanColumns(def.entity_definition_id, args.view_id,
        { show: args.show, hide: args.hide, unhide: args.unhide }, ctx);
      return { entity_view_id: args.view_id, ...r };
    },
  },

  delete_view: {
    description:
      'Delete a view and confirm it is gone. Prefer creating and rebuilding your own views over deleting ' +
      "someone else's: a view is a person's saved workspace, and deletion is not reversible.",
    inputSchema: scoped({
      object: { type: 'string', description: 'Object api_slug, or an object/list uuid.' },
      view_id: { type: 'string' },
    }, ['object', 'view_id']),
    async run(args) {
      const ctx = ctxFrom(args);
      const def = await resolveEntityDef(args.object, ctx);
      const base = `${viewsBase(def.entity_definition_id)}/${args.view_id}`;
      const view = unwrap(await api(base, { ctx }));
      await api(base, { method: 'DELETE', ctx });
      let gone = false;
      try { await api(base, { ctx }); } catch { gone = true; }
      return { deleted: true, title: view.title, entity_view_id: args.view_id, verified_gone: gone };
    },
  },

  // ------------------------------------------------------ select options

  list_select_options: {
    description:
      "Read a select or STATUS attribute's options: ids, titles, colors and order. Works on the SESSION " +
      'COOKIE ALONE — no API key needed, unlike `preflight`, which reads option ids off the public API. ' +
      'Use this to get the option ids that filters and configs need, and to see current colors before ' +
      'changing them. Status attributes are served from a different route (`pipeline-stages`) and their ' +
      'id field is `pipeline_stage_id`; `option_id` is returned either way as a stable alias.',
    inputSchema: scoped({
      object: { type: 'string', description: 'Object api_slug, or an object/list uuid.' },
      attribute: { type: 'string', description: 'Attribute api_slug, title, or uuid.' },
      include_archived: { type: 'boolean', description: 'Default false.' },
    }, ['object', 'attribute']),
    async run(args) {
      const ctx = ctxFrom(args);
      const def = await resolveEntityDef(args.object, ctx);
      const attr = await resolveAttr(def.entity_definition_id, args.attribute, ctx);
      const kind = await resolveOptionKind(def.entity_definition_id, attr, ctx);
      const opts = await fetchOptions(def.entity_definition_id, attr.attribute_definition_id, kind, ctx);
      const rows = opts
        .filter((o) => args.include_archived || !o.is_archived)
        .sort((a, b) => String(a.sort_order).localeCompare(String(b.sort_order)))
        .map((o) => ({
          // Native id field for the namespace, plus a stable alias.
          [kind.idField]: o.option_id,
          option_id: o.option_id,
          title: o.title,
          color: o.color,
          sort_order: o.sort_order,
          is_archived: o.is_archived,
        }));
      return {
        object: def.api_slug || def.entity_definition_id,
        attribute: attr.api_slug || args.attribute,
        attribute_definition_id: attr.attribute_definition_id,
        attribute_kind: kind.label,
        count: rows.length,
        options: rows,
      };
    },
  },

  add_select_options: {
    description:
      'ADD options to a select or status attribute, with colours, in one call. This spans BOTH APIs and ' +
      'so needs an API key as well as the cookie: creation exists only on the public API, and that ' +
      'endpoint SILENTLY IGNORES a colour (Attio assigns a RANDOM one), while colour can only be ' +
      'set on the internal one. Existing options are skipped, not duplicated. Use set_select_options to ' +
      'recolour or reorder what is already there.',
    inputSchema: scoped({
      object: { type: 'string', description: 'Object api_slug, or an object/list uuid.' },
      attribute: { type: 'string', description: 'Attribute api_slug, title, or uuid.' },
      options: {
        type: 'array',
        description:
          'Either plain titles ["Alpha","Beta"] or objects [{"title":"Alpha","color":"red"}]. Colour is ' +
          'optional and takes a bare palette name or a fully-prefixed one.',
      },
      api_key: { type: 'string', description: 'Overrides the stored key. Usually unnecessary.' },
    }, ['object', 'attribute', 'options']),
    async run(args) {
      const ctx = ctxFrom(args);
      const key = apiKeyFor(ctx.profile, args.api_key);
      if (!key) {
        throw new Error('add_select_options needs an API key: creating an option is not on the internal ' +
          'API. Save one to ' + apiKeyPath(ctx.profile) + '. (Recolouring existing options needs only ' +
          'the cookie — see set_select_options.)');
      }
      if (!Array.isArray(args.options) || !args.options.length) {
        throw new Error('Pass at least one option.');
      }
      const def = await resolveEntityDef(args.object, ctx);
      const attr = await resolveAttr(def.entity_definition_id, args.attribute, ctx);
      const kind = await resolveOptionKind(def.entity_definition_id, attr, ctx);

      // Normalise input and validate every colour BEFORE creating anything, so a
      // typo cannot leave half the options created and uncoloured.
      const wanted = args.options.map((o) => {
        const spec = typeof o === 'string' ? { title: o } : o;
        if (!spec || !spec.title) throw new Error('Each option needs a title.');
        return {
          title: String(spec.title),
          color: spec.color ? normalizeColor(spec.color, kind) : null,
        };
      });

      // The public API addresses lists and objects on different paths, and the
      // trailing segment differs by type the same way the internal one does.
      const parent = def.entity_type === 'collection-entry' ? 'lists' : 'objects';
      const segment = kind === OPTION_KINDS.pipeline ? 'statuses' : 'options';
      const publicPath =
        `/${parent}/${def.entity_definition_id}/attributes/${attr.attribute_definition_id}/${segment}`;

      const before = await fetchOptions(def.entity_definition_id, attr.attribute_definition_id, kind, ctx);
      const created = [], skipped = [];
      for (const w of wanted) {
        const existing = findOption(before, w.title);
        if (existing) { skipped.push({ title: w.title, reason: 'already exists', option_id: existing.option_id }); continue; }
        const made = await publicApi(publicPath, key, { method: 'POST', body: { data: { title: w.title } } });
        const id = made && made.id && (made.id.option_id || made.id.status_id);
        if (!id) throw new Error(`Created "${w.title}" but could not read its id back from the public API.`);
        created.push({ title: w.title, option_id: id, color: w.color });
      }

      // Second pass: colour. The create above yields a random palette colour
      // (was always grey until at least 2026-09-03; random as of 2026-11-06).
      const optPath = optionsPath(def.entity_definition_id, attr.attribute_definition_id, kind);
      let colored = 0;
      for (const c of created) {
        if (!c.color) continue;
        await api(`${optPath}/${c.option_id}`, { method: 'PATCH', ctx, body: { color: c.color } });
        colored++;
      }

      const after = await fetchOptions(def.entity_definition_id, attr.attribute_definition_id, kind, ctx);
      return {
        object: def.api_slug || def.entity_definition_id,
        attribute: attr.api_slug || args.attribute,
        attribute_kind: kind.label,
        created: created.map((c) => ({
          title: c.title,
          [kind.idField]: c.option_id,
          color: (after.find((o) => o.option_id === c.option_id) || {}).color,
        })),
        colors_set: colored,
        ...(skipped.length ? { skipped } : {}),
        ...(created.some((c) => !c.color)
          ? { note: 'Options created without an explicit colour get a RANDOM colour from Attio. The public API ignores ' +
              'colour on create. Set them with set_select_options.' }
          : {}),
      };
    },
  },

  set_select_options: {
    description:
      "Set the COLORS and/or the ORDER of a select or STATUS attribute's options. Attio's public API can " +
      'do neither, and its UI is the only other route. Colors are named palette values, not hex: pass a ' +
      'bare name ("red") and the right prefix is applied, or spell it out (pastel_* for select, block_* ' +
      'for status). Both are single-field PATCHes, issued one per option. Identify options by title or ' +
      'by id. Returns a before/after diff.',
    inputSchema: scoped({
      object: { type: 'string', description: 'Object api_slug, or an object/list uuid.' },
      attribute: { type: 'string', description: 'Attribute api_slug, title, or uuid.' },
      colors: {
        type: 'object',
        description: 'Map of option title (or id) -> palette colour name, e.g. {"Won":"pastel_green"}.',
      },
      order: {
        type: 'array',
        description:
          'Option titles (or ids) in the desired order. Options you leave out keep their relative ' +
          'order and are placed after the ones you list.',
      },
    }, ['object', 'attribute']),
    async run(args) {
      if (!args.colors && !args.order) throw new Error('Nothing to do: pass colors, order, or both.');
      const ctx = ctxFrom(args);
      const def = await resolveEntityDef(args.object, ctx);
      const attr = await resolveAttr(def.entity_definition_id, args.attribute, ctx);
      const kind = await resolveOptionKind(def.entity_definition_id, attr, ctx);
      const optPath = optionsPath(def.entity_definition_id, attr.attribute_definition_id, kind);
      const before = await fetchOptions(def.entity_definition_id, attr.attribute_definition_id, kind, ctx);
      const live = before.filter((o) => !o.is_archived);
      const warnings = [];
      const snapshot = (o) => ({ title: o.title, color: o.color, sort_order: o.sort_order });
      const beforeMap = new Map(before.map((o) => [o.option_id, snapshot(o)]));

      // ---- colours -------------------------------------------------------
      // The palette is now enumerated against Attio rather than observed, so an
      // unknown name is a hard error instead of a warning: it would only earn an
      // empty 400 from the API. normalizeColor also accepts a bare "red" and
      // applies the prefix this attribute's namespace needs.
      let colored = 0;
      for (const [ref, color] of Object.entries(args.colors || {})) {
        const o = findOption(before, ref);
        if (!o) throw new Error(`No option "${ref}" on ${attr.api_slug || args.attribute}. ` +
          `Have: ${live.map((x) => x.title).join(', ')}`);
        await api(`${optPath}/${o.option_id}`, {
          method: 'PATCH', ctx, body: { color: normalizeColor(color, kind) },
        });
        colored++;
      }

      // ---- order ---------------------------------------------------------
      // Assign fresh keys to everything so the result is a total order: listed
      // options first in the order given, then the rest in their current order.
      let reordered = 0;
      if (args.order) {
        const listed = [];
        for (const ref of args.order) {
          const o = findOption(before, ref);
          if (!o) throw new Error(`No option "${ref}" to order. Have: ${live.map((x) => x.title).join(', ')}`);
          if (o.is_archived) warnings.push(`"${o.title}" is archived; ordering it has no visible effect.`);
          if (!listed.includes(o)) listed.push(o);
        }
        const rest = live
          .filter((o) => !listed.includes(o))
          .sort((a, b) => String(a.sort_order).localeCompare(String(b.sort_order)));
        const finalOrder = [...listed, ...rest];
        for (let i = 0; i < finalOrder.length; i++) {
          await api(`${optPath}/${finalOrder[i].option_id}`, {
            method: 'PATCH', ctx, body: { sort_order: sortKey(i) },
          });
          reordered++;
        }
      }

      const after = await fetchOptions(def.entity_definition_id, attr.attribute_definition_id, kind, ctx);
      const changed = after
        .map((o) => ({ id: o.option_id, before: beforeMap.get(o.option_id), after: snapshot(o) }))
        .filter((d) => d.before && (d.before.color !== d.after.color || d.before.sort_order !== d.after.sort_order))
        .map((d) => ({
          title: d.after.title,
          color: d.before.color === d.after.color ? undefined : `${d.before.color} -> ${d.after.color}`,
          sort_order: d.before.sort_order === d.after.sort_order ? undefined : `${d.before.sort_order} -> ${d.after.sort_order}`,
        }));

      return {
        object: def.api_slug || def.entity_definition_id,
        attribute: attr.api_slug || args.attribute,
        attribute_kind: kind.label,
        colors_set: colored,
        options_reordered: reordered,
        changed,
        final_order: after
          .filter((o) => !o.is_archived)
          .sort((a, b) => String(a.sort_order).localeCompare(String(b.sort_order)))
          .map((o) => `${o.title} (${o.color})`),
        ...(warnings.length ? { warnings } : {}),
      };
    },
  },

  // ----------------------------------------------------- record layouts

  list_layouts: {
    description:
      "List an object's custom layouts. `record-page` is the record detail page; `custom-form` is the " +
      'Quick Add form. Use the returned custom_layout_id with get_layout and edit_layout.',
    inputSchema: scoped({
      object: { type: 'string', description: 'Object api_slug, or an object/list uuid.' },
    }, ['object']),
    async run(args) {
      const ctx = ctxFrom(args);
      const def = await resolveEntityDef(args.object, ctx);
      const r = await api(`/entity-definitions/${def.entity_definition_id}/custom-layouts`, { ctx });
      const layouts = (r && r.custom_layouts) || [];
      return {
        object: def.api_slug || def.entity_definition_id,
        count: layouts.length,
        layouts: layouts.map((l) => ({
          custom_layout_id: l.custom_layout_id, type: l.type, title: l.title, description: l.description,
        })),
      };
    },
  },

  get_layout: {
    description:
      'Read a record-page layout as a readable tree: sections, the fields inside them, and tabs, with ' +
      'attribute uuids resolved to slugs. **Read this before every edit** — the save endpoint is a full ' +
      'replace, so an edit built on stale state deletes whatever it did not know about.',
    inputSchema: scoped({
      layout_id: { type: 'string' },
      raw: { type: 'boolean', description: 'Also return the untouched elements array. Default false.' },
    }, ['layout_id']),
    async run(args) {
      const ctx = ctxFrom(args);
      const layout = await getLayoutRaw(args.layout_id, ctx);
      const els = layout.elements;

      const attrs = unwrap(await api(
        `/entity-definitions/${layout.entity_definition_id}/attribute-definitions`, { ctx }
      ).catch(() => []));
      const attrById = new Map((attrs || []).map((a) => [a.attribute_definition_id, a]));
      const pathNames = (p) => (p || []).map((h) => {
        const a = attrById.get(h.attribute_definition_id);
        return a ? (a.api_slug || a.title) : h.attribute_definition_id;
      });

      const kids = (id) => els.filter((e) => e.parent_element_id === id)
        .sort((a, b) => String(a.sort_order).localeCompare(String(b.sort_order)));
      const node = (e) => {
        const names = pathNames(e.path);
        const a = e.path && e.path.length === 1 ? attrById.get(e.path[0].attribute_definition_id) : null;
        return {
          element_id: e.element_id,
          type: e.type,
          ...(e.title ? { title: e.title } : {}),
          ...(names.length ? { path: names } : {}),
          ...(a && a.is_archived ? { WARNING: 'references an ARCHIVED attribute — saves but never renders' } : {}),
          ...(e.is_system_element ? { system: true } : {}),
          ...(e.is_locked ? { locked: true } : {}),
          sort_order: e.sort_order,
          ...(kids(e.element_id).length ? { children: kids(e.element_id).map(node) } : {}),
        };
      };

      const roots = els.filter((e) => !e.parent_element_id)
        .sort((a, b) => String(a.sort_order).localeCompare(String(b.sort_order)));
      return {
        custom_layout_id: layout.custom_layout_id,
        entity_definition_id: layout.entity_definition_id,
        type: layout.type,
        title: layout.title,
        element_count: els.length,
        sections: els.filter((e) => e.type === 'details').map((e) => ({ element_id: e.element_id, title: e.title })),
        tabs: els.filter((e) => /-tab$/.test(e.type)).map((e) => ({ element_id: e.element_id, type: e.type, title: e.title })),
        tree: roots.map(node),
        ...(args.raw ? { raw_elements: els } : {}),
      };
    },
  },

  edit_layout: {
    description:
      'Add sections, add fields to a section or tab, add a relationship tab, or remove elements — on a ' +
      'record-page layout. Strictly read-modify-write: the whole tree is re-read, changed, and posted ' +
      'back, so untouched elements survive. Removing an element removes its descendants too, because ' +
      'the save deletes by omission. Returns a before/after diff. Pass dry_run to see the diff without ' +
      'saving.',
    inputSchema: scoped({
      layout_id: { type: 'string' },
      add_sections: {
        type: 'array',
        description: 'Each: {title, fields?:[attribute slugs]}. Appended after existing sections.',
      },
      add_fields: {
        type: 'array',
        description: 'Each: {to: section/tab title or element_id, fields:[attribute slugs or uuids]}.',
      },
      remove: {
        type: 'array',
        description: 'Element titles or element_ids. Descendants go too. System/locked elements are refused.',
      },
      dry_run: { type: 'boolean', description: 'Compute and return the diff without saving.' },
    }, ['layout_id']),
    async run(args) {
      const ops = ['add_sections', 'add_fields', 'remove'].filter((k) => args[k] && args[k].length);
      if (!ops.length) throw new Error('Nothing to do: pass add_sections, add_fields, and/or remove.');

      const ctx = ctxFrom(args);
      const layout = await getLayoutRaw(args.layout_id, ctx);
      const defId = layout.entity_definition_id;
      let els = layout.elements.map((e) => ({ ...e }));
      const before = new Set(els.map((e) => e.element_id));
      const warnings = [];
      const added = [], removed = [];

      const attrs = unwrap(await api(`/entity-definitions/${defId}/attribute-definitions`, { ctx }));
      const resolveField = (ref) => {
        const a = (attrs || []).find((x) => x.attribute_definition_id === ref) ||
          (attrs || []).find((x) => x.api_slug === ref) ||
          (attrs || []).find((x) => (x.title || '').toLowerCase() === String(ref).toLowerCase());
        if (!a) throw new Error(`No attribute "${ref}" on this object.`);
        // An element pointing at an archived attribute SAVES (200) and then never
        // renders on the page. Skipping loudly beats writing an invisible field.
        if (a.is_archived) {
          warnings.push(`Skipped "${ref}": the attribute is ARCHIVED. It would save but never render. ` +
            'Use the active attribute instead.');
          return null;
        }
        return a;
      };

      // ---- removals first, so a title freed up here can be reused below ----
      for (const ref of args.remove || []) {
        const el = findElement(els, ref);
        if (!el) throw new Error(`No layout element "${ref}". Use get_layout to see what exists.`);
        if (el.is_system_element || el.is_locked) {
          throw new Error(`"${ref}" is a system/locked element (${el.type}) and cannot be removed.`);
        }
        const doomed = withDescendants(els, el.element_id);
        removed.push({ title: el.title || el.type, type: el.type, elements_removed: doomed.size });
        els = els.filter((e) => !doomed.has(e.element_id));
      }

      // ---- new sections ----
      // Sections hang off the group that already holds the `details` elements.
      for (const spec of args.add_sections || []) {
        if (!spec.title) throw new Error('Each add_sections entry needs a title.');
        const anySection = els.find((e) => e.type === 'details');
        const parent = anySection ? anySection.parent_element_id : null;
        if (!parent) throw new Error('Could not find the group that holds sections on this layout.');
        const id = crypto.randomUUID();
        // A section carries NO `path`/`field` keys. Sending them as null is a 400
        // with an empty body; omitting the structural keys instead is a 500. The
        // accepted shape is exactly this key set. [VERIFIED 2026-08-24]
        els.push({
          element_id: id, type: 'details', title: spec.title, slug: null,
          parent_element_id: parent, sort_order: nextSort(els, parent),
          archived_at: null, is_locked: false, is_system_element: false,
        });
        added.push({ type: 'details', title: spec.title });
        for (const f of spec.fields || []) {
          const a = resolveField(f);
          if (!a) continue;
          els.push({
            element_id: crypto.randomUUID(), type: 'detail-value', title: null, slug: null,
            parent_element_id: id, sort_order: nextSort(els, id),
            archived_at: null, is_locked: false, is_system_element: false,
            path: [{ entity_definition_id: defId, attribute_definition_id: a.attribute_definition_id }],
            field: null,
          });
          added.push({ type: 'detail-value', into: spec.title, field: a.api_slug });
        }
      }

      // ---- fields into an existing container ----
      for (const spec of args.add_fields || []) {
        const container = findElement(els, spec.to);
        if (!container) throw new Error(`No section or tab "${spec.to}" on this layout.`);
        const childType = LAYOUT_CHILD_TYPE[container.type];
        if (!childType) {
          throw new Error(
            `"${spec.to}" is a ${container.type}, which does not hold fields. ` +
            `Fields go in: ${Object.keys(LAYOUT_CHILD_TYPE).join(', ')}.`
          );
        }
        for (const f of spec.fields || []) {
          const a = resolveField(f);
          if (!a) continue;
          els.push({
            element_id: crypto.randomUUID(), type: childType, title: null, slug: null,
            parent_element_id: container.element_id, sort_order: nextSort(els, container.element_id),
            archived_at: null, is_locked: false, is_system_element: false,
            path: [{ entity_definition_id: defId, attribute_definition_id: a.attribute_definition_id }],
            field: null,
          });
          added.push({ type: childType, into: container.title || container.type, field: a.api_slug });
        }
      }

      const diff = {
        elements_before: layout.elements.length,
        elements_after: els.length,
        added, removed,
      };
      if (args.dry_run) {
        return { dry_run: true, custom_layout_id: args.layout_id, ...diff,
          ...(warnings.length ? { warnings } : {}) };
      }

      await api(`/custom-layouts/${args.layout_id}`, { method: 'POST', ctx, body: { elements: els } });
      const after = await getLayoutRaw(args.layout_id, ctx);
      const afterIds = new Set(after.elements.map((e) => e.element_id));
      const survived = [...before].filter((id) => afterIds.has(id)).length;

      return {
        custom_layout_id: args.layout_id,
        ...diff,
        saved_element_count: after.elements.length,
        untouched_elements_preserved: `${survived}/${before.size - removed.reduce((n, r) => n + r.elements_removed, 0)}`,
        ...(warnings.length ? { warnings } : {}),
      };
    },
  },

  set_layout: {
    description:
      'Escape hatch: replace a layout\'s ENTIRE element tree with the array you supply. This is what ' +
      'edit_layout does internally. **Anything missing from `elements` is deleted** — always base the ' +
      'array on a fresh get_layout({raw:true}). Prefer edit_layout; use this only for a change it cannot ' +
      'express, such as reordering or retitling.',
    inputSchema: scoped({
      layout_id: { type: 'string' },
      elements: { type: 'array', description: 'The complete element tree. Omission means deletion.' },
    }, ['layout_id', 'elements']),
    async run(args) {
      const ctx = ctxFrom(args);
      const current = await getLayoutRaw(args.layout_id, ctx);
      if (!Array.isArray(args.elements) || !args.elements.length) {
        throw new Error('elements must be a non-empty array. An empty array would erase the layout.');
      }
      const currentIds = new Set(current.elements.map((e) => e.element_id));
      const givenIds = new Set(args.elements.map((e) => e.element_id));
      const dropping = [...currentIds].filter((id) => !givenIds.has(id));
      const droppedSystem = current.elements
        .filter((e) => dropping.includes(e.element_id) && (e.is_system_element || e.is_locked));
      if (droppedSystem.length) {
        throw new Error(
          `This would delete ${droppedSystem.length} system/locked element(s): ` +
          `${droppedSystem.map((e) => e.title || e.type).join(', ')}. Re-read with get_layout({raw:true}) ` +
          'and include them.'
        );
      }
      await api(`/custom-layouts/${args.layout_id}`, { method: 'POST', ctx, body: { elements: args.elements } });
      const after = await getLayoutRaw(args.layout_id, ctx);
      return {
        custom_layout_id: args.layout_id,
        elements_before: current.elements.length,
        elements_after: after.elements.length,
        elements_dropped: dropping.length,
      };
    },
  },
};

// Reports and dashboards live in their own module (ported from Erik Wood's
// build_dashboard.py). They reuse this file's HTTP layer and context handling.
// ------------------------------------------------------------ workflow_guide

TOOLS.workflow_guide = {
  description:
    'Context for BUILDING Attio workflows: tested block references, multi-block recipes, guides and build ' +
    'rules, from Erik Wood\'s toolkit. Each block reference lists its inputs, outputs, an example config, ' +
    'known gaps and an evidence level (effect-verified > runtime-verified > config-verified > ui-observed > ' +
    'documented). Call with no arguments for the rules and an index; with block for one block ("find-records", ' +
    '"c-lookup-row-find"); with recipe for a pattern and the MCP tools that build it; with query to search; ' +
    'with guide for a long-form guide. Offline: no workspace call.',
  inputSchema: {
    type: 'object',
    properties: {
      block: { type: 'string', description: 'System block slug (e.g. "aggregate-values"), app block id (e.g. "j-subflow-run"), or capability id.' },
      recipe: { type: 'string', description: 'Recipe id, e.g. "find-aggregate-update".' },
      query: { type: 'string', description: 'Keywords to search capabilities and recipes, e.g. "loop records".' },
      guide: { type: 'string', enum: Object.keys(WF_CONTEXT.guides), description: 'Long-form guide to return in full.' },
    },
  },
  async run(args = {}) {
    const caps = WF_CONTEXT.capabilities;
    if (args.block) {
      const cap = caps[args.block] || capForSystemBlock(args.block) || capForAppBlock(args.block);
      if (!cap) {
        throw new Error(`No reference for "${args.block}". Try workflow_guide with query, or list_blocks / list_app_blocks. ` +
          'No reference means untested here, not invalid.');
      }
      const recipesUsing = Object.values(WF_CONTEXT.recipes).filter((r) => r.capabilities.includes(cap.id)).map((r) => r.id);
      return { title: cap.title, summary: cap.summary, providers: cap.providers, ...capReference(cap, { examples: true }),
        constraints: cap.constraints, recipes: recipesUsing };
    }
    if (args.recipe) {
      const r = WF_CONTEXT.recipes[args.recipe];
      if (!r) throw new Error(`Unknown recipe "${args.recipe}". Known: ${Object.keys(WF_CONTEXT.recipes).join(', ')}`);
      return { ...r, blocks: r.capabilities.map((id) => caps[id] ? { capability: id, title: caps[id].title, evidence: bestEvidence(caps[id]) } : { capability: id }) };
    }
    if (args.guide) {
      const g = WF_CONTEXT.guides[args.guide];
      if (!g) throw new Error(`Unknown guide "${args.guide}". Known: ${Object.keys(WF_CONTEXT.guides).join(', ')}`);
      return { guide: args.guide, text: g };
    }
    if (args.query) {
      // Crude stem (records -> record) so plural queries match singular keywords.
      const terms = [...new Set(String(args.query).toLowerCase().split(/\s+/).filter(Boolean).map((t) => (t.length > 3 ? t.replace(/s$/, '') : t)))];
      const capList = Object.values(caps);
      const headOf = (c) => [c.id, c.title, c.summary, ...(c.keywords || [])].join(' ').toLowerCase();
      // Rare terms weigh more (idf), so "loop records" ranks Loop above every record block.
      const idf = Object.fromEntries(terms.map((t) => {
        const df = capList.filter((c) => headOf(c).includes(t)).length;
        return [t, Math.log((capList.length + 1) / (df + 1)) + 0.1];
      }));
      const score = (hay) => terms.reduce((n, t) => n + (hay.includes(t) ? idf[t] : 0), 0);
      const capHits = capList.map((c) => ({
        c, s: score(headOf(c)) * 2 + score(c.title.toLowerCase()) * 2 +
              score(JSON.stringify(c.inputs).toLowerCase() + JSON.stringify(c.outputs).toLowerCase()),
      })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 10);
      const recHits = Object.values(WF_CONTEXT.recipes).map((r) => ({ r, s: score((r.id + ' ' + r.title + ' ' + r.body).toLowerCase()) }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
      return {
        query: args.query,
        capabilities: capHits.map(({ c }) => ({ capability: c.id, title: c.title, summary: c.summary, evidence: bestEvidence(c), gaps: c.gaps })),
        recipes: recHits.map(({ r }) => ({ recipe: r.id, title: r.title, evidence_level: r.evidence_level })),
        next: 'Call workflow_guide with block or recipe for the full reference.',
      };
    }
    const group = (re) => Object.values(caps).filter((c) => re.test(c.id)).map((c) => ({ capability: c.id, title: c.title, evidence: bestEvidence(c) }));
    return {
      source: WF_CONTEXT._source || 'workflow-context.json missing; run tools/build-workflow-context.js',
      rules: WORKFLOW_RULES,
      evidence_levels: WF_CONTEXT._evidence_levels,
      recipes: Object.values(WF_CONTEXT.recipes).map((r) => ({ recipe: r.id, title: r.title, evidence_level: r.evidence_level })),
      guides: Object.keys(WF_CONTEXT.guides),
      system_blocks: group(/^workflow\.block\./),
      neon_deer_app_blocks: group(/^workflow\.app\./),
      other: group(/^(workflow\.(builder|lifecycle|logs|triggers|production-review)|variables\.|filters\.)/),
    };
  },
};

Object.assign(TOOLS, require('./reports').makeReportTools({ api, raw, unwrap, ctxFrom, scoped, apiKeyFor, ROOT }));
Object.assign(TOOLS, require('./formulas').makeFormulaTools({ api, raw, unwrap, ctxFrom, scoped, ROOT }));

// --------------------------------------------------------------- mcp plumbing

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(req) {
  const { method, params } = req;

  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'attio-admin-mcp', version: '4.8.0' },
      instructions: 'Attio admin tools (internal API). For workflow builds, follow these rules:\n- ' + WORKFLOW_RULES.join('\n- '),
    };
  }
  if (method === 'tools/list') {
    return {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name, description: t.description, inputSchema: t.inputSchema,
      })),
    };
  }
  if (method === 'tools/call') {
    const tool = TOOLS[params?.name];
    if (!tool) throw new Error(`Unknown tool: ${params?.name}`);
    const result = await tool.run(params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
  throw new Error(`Unknown method: ${method}`);
}

let buf = '';
let pending = 0;
let stdinEnded = false;
const maybeExit = () => { if (stdinEnded && pending === 0) process.exit(0); };

process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;

    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.id === undefined) continue; // notification

    pending++;
    handle(req)
      .then((result) => send({ jsonrpc: '2.0', id: req.id, result }))
      .catch((err) => send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: String(err.message || err) } }))
      .finally(() => { pending--; maybeExit(); });
  }
});

process.stdin.on('end', () => { stdinEnded = true; maybeExit(); });
