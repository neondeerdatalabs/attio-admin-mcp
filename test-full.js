/**
 * Full end-to-end test of the MCP server against a real Attio workspace.
 *
 * Requires:
 *   ATTIO_WORKSPACE_SLUG   your workspace slug (from your Attio URL)
 *   ~/.attio-session       your session cookie (see README)
 *
 * Everything else is discovered from the workspace at run time, so this works
 * in any workspace with no editing.
 *
 * Safe by design: creates only workflows prefixed ZZ-SELFTEST-, never publishes
 * anything, and deletes everything it creates. Existing workflows are read-only.
 *
 * Optional:
 *   CLONE_SOURCE_WORKFLOW_ID   run the clone test against a specific workflow.
 *                              If unset, the newest workflow with >1 block is
 *                              used; if none, the clone test is skipped.
 */
const { spawn } = require('child_process');

const SLUG = process.env.ATTIO_WORKSPACE_SLUG;
if (!SLUG) {
  console.error('ATTIO_WORKSPACE_SLUG is not set. Example:\n' +
    '  ATTIO_WORKSPACE_SLUG=your-workspace node test-full.js');
  process.exit(2);
}

const PREFIX = 'ZZ-SELFTEST-';
const UUIDish = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const child = spawn('node', [__dirname + '/server.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, ATTIO_WORKSPACE_SLUG: SLUG },
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
    const msg = JSON.parse(line);
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
  const res = await rpc('tools/call', { name, arguments: args });
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  return JSON.parse(res.result.content[0].text);
}

/**
 * Fixture helper: create a select attribute on a disposable list, straight
 * against the public API. There is no MCP tool for attribute creation, and
 * add_select_options needs something to add options to. Returns null (rather
 * than throwing) when there is no key, so the suite degrades to a skip.
 */
async function makeSelectAttr(listId) {
  const fs = require('fs'), os = require('os'), path = require('path');
  const f = path.join(os.homedir(), '.attio-apikey');
  const key = process.env.ATTIO_API_KEY || (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null);
  if (!key) return null;
  const slug = `zz_fixture_select_${Date.now().toString(36)}`;
  const res = await fetch(`https://api.attio.com/v2/lists/${listId}/attributes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ data: {
      type: 'select', title: 'ZZ Fixture Select', description: 'self-test fixture',
      is_multiselect: false, api_slug: slug, is_required: false, is_unique: false, config: {},
    } }),
  });
  if (!res.ok) return null;
  return { api_slug: slug };
}

let pass = 0, fail = 0, skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};
const skipped = (label, why) => { skip++; console.log(`  SKIP  ${label} — ${why}`); };

(async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05' });
  const created = [];

  try {
    console.log('\n=== 1. Session ===');
    const s = await call('check_session');
    check('cookie authenticates headless', s.ok === true);
    check('session not expired', s.session.expired === false, `${s.session.days_remaining}d remaining`);
    check('workspace matches env', s.workspace === SLUG, SLUG);

    console.log('\n=== 2. Discovery ===');
    const objects = await call('list_objects');
    check('objects discovered', objects.length > 0, `${objects.length} objects`);
    // Prefer companies, else any record-like object, else whatever exists.
    const target =
      objects.find((o) => o.api_slug === 'companies') ||
      objects.find((o) => /record/.test(o.entity_type)) ||
      objects[0];
    check('picked a target object', !!target, `${target.api_slug} (${target.entity_type})`);
    const OBJ = target.entity_definition_id;

    const list = await call('list_workflows');
    check('workflows listed', typeof list.count === 'number', `${list.count} found`);

    console.log('\n=== 2b. Preflight and name resolution ===');
    const pf = await call('preflight', {});
    check('preflight resolves objects + attributes', pf.summary.objects > 0 && pf.summary.attributes > 0,
      `${pf.summary.objects} objects, ${pf.summary.attributes} attrs, ${pf.summary.options} options`);
    check('preflight caches its result', /\.json$/.test(pf.cached_to || ''));
    const cached = await call('preflight', {});
    check('second call served from cache', cached.from_cache === true);

    // Find any attribute anywhere that has resolvable options.
    let optObj = null, optAttr = null;
    for (const o of pf.objects) {
      const a = o.attributes.find((x) => x.options && x.options.length);
      if (a) { optObj = o; optAttr = a; break; }
    }
    if (!optAttr) skipped('option resolution', 'no select/status attribute with options (API key missing?)');
    else {
      const r = await call('resolve', {
        object: optObj.api_slug, attribute: optAttr.api_slug, option: optAttr.options[0].title,
      });
      check('resolves a name to an option id', r.option && r.option.id === optAttr.options[0].id,
        `${optObj.api_slug}.${optAttr.api_slug} = "${optAttr.options[0].title}"`);
      check('emits a usable comparison value node',
        !!r.value_node && /^attio-(pipeline|select)$/.test(r.value_node.type), r.value_node.type);
      check('emits the variable path segment for that attribute',
        r.variable_path_segment && r.variable_path_segment.attribute === optAttr.attribute_definition_id);
    }
    let badOpt = false;
    try { await call('resolve', { object: '__nope__' }); }
    catch (e) { badOpt = /No object/.test(e.message); }
    check('unknown object fails with a useful message', badOpt);

    console.log('\n=== 3. Build a workflow from scratch ===');
    const wf = await call('create_workflow', {
      title: `${PREFIX}build`,
      description: 'Automated self-test. Inert, never published, auto-deleted.',
    });
    created.push(wf.workflow_id);
    check('created as draft', wf.status === 'draft');
    check('draft version provisioned (is_modern)', !!wf.draft_version_id);

    const trig = await call('add_block', {
      workflow_id: wf.workflow_id, block_type: 'trigger',
      provider: { type: 'system', system_block_slug: 'on-record-created', system_block_version: 'v1' },
      config: { type: 'object', entries: { object: { type: 'attio-object', entity_definition_id: OBJ } } },
      position: { x: 0, y: 0 },
    });
    const step = await call('add_block', {
      workflow_id: wf.workflow_id, block_type: 'step',
      provider: { type: 'system', system_block_slug: 'find-records', system_block_version: 'v1' },
      config: { type: 'object', entries: {
        entity: { type: 'attio-object', entity_definition_id: OBJ },
        limit: { type: 'number', value: 5 } } },
      position: { x: 270, y: 0 },
    });
    check('trigger + step created', !!trig.block_id && !!step.block_id);

    await call('connect_blocks', {
      workflow_id: wf.workflow_id, source_block_id: trig.block_id,
      outcome: 'done', target_block_id: step.block_id,
    });

    const built = await call('get_workflow', { workflow_id: wf.workflow_id });
    check('2 blocks, 1 path', built.definition.blocks.length === 2 && built.definition.paths.length === 1);
    check('all configs complete', built.definition.blocks.every((b) => b.config_state === 'complete'));
    check('still a draft', built.status === 'draft' && built.active_version_id === null);

    console.log('\n=== 4. Update an existing block (PUT would 409) ===');
    const upd = await call('set_block_config', {
      workflow_id: wf.workflow_id, block_id: step.block_id,
      config: { type: 'object', entries: {
        entity: { type: 'attio-object', entity_definition_id: OBJ },
        limit: { type: 'number', value: 25 } } },
    });
    check('config updated in place', upd.config.entries.limit.value === 25, 'limit 5 -> 25');

    console.log('\n=== 5. Publishing is out of scope by design ===');
    const tools = (await rpc('tools/list')).result.tools.map((t) => t.name);
    check('no tool can publish', !tools.some((n) => /^publish|^activate/.test(n)),
      `${tools.length} tools`);
    let unknown = false;
    try { await call('publish_workflow', { workflow_id: wf.workflow_id, confirm: true }); }
    catch (e) { unknown = /unknown tool/i.test(e.message); }
    check('publish_workflow cannot be called', unknown);
    const deact = await call('deactivate_workflow', { workflow_id: wf.workflow_id });
    check('deactivate is a safe no-op when not live', !!deact.note);

    console.log('\n=== 6. Live-workflow handling ===');
    const liveOne = (list.workflows || []).find((w) => w.status === 'live');
    if (!liveOne) skipped('live workflow handling', 'no live workflow in this workspace');
    else {
      // Editing a live workflow is allowed (writes go to its draft), but
      // DELETING one is destructive and must be refused without an explicit flag.
      let refused = false;
      try { await call('delete_workflow', { workflow_id: liveOne.workflow_id }); }
      catch (e) { refused = /LIVE/.test(e.message) && /confirm_delete_live/.test(e.message); }
      check('refuses to delete a live workflow without confirm', refused, liveOne.title);

      // Read-only assertion that the running version is untouched by drafts.
      const lw = await call('get_workflow', { workflow_id: liveOne.workflow_id });
      check('live workflow exposes both versions', !!lw.active_version_id,
        lw.draft_version_id && lw.draft_version_id !== lw.active_version_id
          ? 'draft differs from active' : 'draft == active');
    }

    console.log('\n=== 6b. Legacy (pre-modern) workflows ===');
    let legacyWf = null;
    for (const w of (list.workflows || [])) {
      try {
        const f = await call('get_workflow', { workflow_id: w.workflow_id });
        if (f.legacy) { legacyWf = f; break; }
      } catch { /* unreadable */ }
    }
    if (!legacyWf) skipped('legacy workflow read', 'no legacy workflow in this workspace');
    else {
      check('legacy workflow reads from a snapshot', !!legacyWf.snapshot_id,
        `${legacyWf.title} [${legacyWf.snapshot_status}]`);
      check('legacy blocks come back', legacyWf.definition.blocks.length > 0,
        `${legacyWf.definition.blocks.length} blocks`);
      check('legacy blocks carry a server schema',
        legacyWf.definition.blocks.some((b) => (b.outputs || []).length || (b.inputs || []).length));
      check('legacy read is flagged, not silently mixed with modern', legacyWf.legacy === true);
    }

    console.log('\n=== 7b. Variable wiring ===');
    const attrs = await call('list_attributes', { object: target.api_slug });
    check('attributes listed with UUIDs', attrs.count > 0 &&
      attrs.attributes.every((a) => /^[0-9a-f-]{36}$/i.test(a.attribute_definition_id)),
      `${attrs.count} on ${target.api_slug}`);

    const cat = await call('list_block_outputs');
    check('block output catalog present', cat.blocks.length > 0, `${cat.blocks.length} block types`);
    const fr = await call('list_block_outputs', { block_slug: 'find-records' });
    check('find-records outputs known', !!fr.fields.records && !!fr.fields.match_count);

    // The picker must see the trigger upstream of the step we connected earlier.
    const avail = await call('list_available_variables', {
      workflow_id: wf.workflow_id, block_id: step.block_id,
    });
    check('picker finds the upstream trigger', avail.upstream_blocks === 1,
      avail.available.map((a) => a.block).join(', '));
    const vars = avail.available[0].variables;
    check('picker emits usable variable nodes', vars.length > 0 &&
      vars.some((v) => v.node && v.node.type === 'variable' &&
        v.node.matchers[0].block_instance_id === trig.block_id),
      vars.map((v) => v.path).join(', '));

    // Round-trip: feed the picker's own node back into a real config.
    const vnode = vars.find((v) => v.node);
    const guard = await call('add_block', {
      workflow_id: wf.workflow_id, block_type: 'step',
      provider: { type: 'system', system_block_slug: 'guard', system_block_version: 'v1' },
      config: { type: 'object', entries: { predicate: { type: 'composite-predicate', operator: 'and',
        operands: [{ type: 'unary-predicate', operator: 'not-empty', operand: vnode.node }] } } },
      position: { x: 540, y: 0 },
    });
    const afterVar = await call('get_workflow', { workflow_id: wf.workflow_id });
    const gb = afterVar.definition.blocks.find((b) => b.block_id === guard.block_id);
    check('preset variable accepted by Attio', gb.config_state === 'complete',
      `path ${vnode.path}`);
    const rt = gb.config.entries.predicate.operands[0].operand.matchers[0];
    check('matcher survives round-trip', rt.block_instance_id === trig.block_id &&
      rt.operations.length > 0);

    // `predicate` is the modern input name for guard AND branch. `condition` is the
    // LEGACY name for both (see legacy-block-schemas.json) and does not apply here.
    check('modern guard input is "predicate"',
      Object.keys(gb.config.entries).includes('predicate'),
      Object.keys(gb.config.entries).join(', '));

    console.log('\n=== 7b. Block metadata (update_block) ===');
    // description and position are block-instance fields, not config. PATCH is a
    // partial update: sending one must not clear the other.
    await call('update_block', {
      workflow_id: wf.workflow_id, block_id: guard.block_id,
      description: 'selftest-desc', position: { x: 700, y: 120 },
    });
    let meta = await call('update_block', {
      workflow_id: wf.workflow_id, block_id: guard.block_id, description: 'selftest-desc-2',
    });
    check('PATCH sets description', meta.description === 'selftest-desc-2', meta.description);
    check('description-only PATCH leaves position intact',
      meta.position && meta.position.x === 700 && meta.position.y === 120,
      JSON.stringify(meta.position));
    meta = await call('update_block', {
      workflow_id: wf.workflow_id, block_id: guard.block_id, position: { x: 430, y: 240 },
    });
    check('PATCH sets position', meta.position.x === 430 && meta.position.y === 240);
    check('position-only PATCH leaves description intact',
      meta.description === 'selftest-desc-2', meta.description);
    const metaBack = await call('get_workflow', { workflow_id: wf.workflow_id });
    const mb = metaBack.definition.blocks.find((b) => b.block_id === guard.block_id);
    check('block metadata persists in get_workflow',
      mb.description === 'selftest-desc-2' && mb.position.x === 430);
    let metaThrew = false;
    try { await call('update_block', { workflow_id: wf.workflow_id, block_id: guard.block_id }); }
    catch { metaThrew = true; }
    check('update_block rejects a no-op call', metaThrew);

    console.log('\n=== 8. Clone ===');
    let sourceId = process.env.CLONE_SOURCE_WORKFLOW_ID;
    if (!sourceId) {
      for (const w of (list.workflows || []).slice(0, 12)) {
        try {
          const full = await call('get_workflow', { workflow_id: w.workflow_id });
          if (full.definition.blocks.length > 1) { sourceId = w.workflow_id; break; }
        } catch { /* skip unreadable */ }
      }
    }
    if (!sourceId) skipped('clone', 'no multi-block workflow available to clone');
    else {
      const src = await call('get_workflow', { workflow_id: sourceId });
      const clone = await call('clone_workflow', {
        source_workflow_id: sourceId, new_title: `${PREFIX}clone`,
      });
      created.push(clone.workflow_id);
      check('clone is a draft', clone.status === 'draft', src.title);
      check('all blocks cloned', clone.blocks_created === src.definition.blocks.length,
        `${clone.blocks_created}/${src.definition.blocks.length}`);
      check('all paths cloned', clone.paths_created === src.definition.paths.length,
        `${clone.paths_created}/${src.definition.paths.length}`);
      check('configs byte-identical to source', clone.verification.all_configs_match === true);
      check('no stale source ids leaked', clone.verification.stale_source_ids.length === 0);
    }
    console.log('\n=== 8b. Views ===');
    // Discovers its own object, creates only PREFIX-titled views, deletes them.
    // list_objects returns a bare array, and the suite already resolved `target`.
    const objSlug = target.api_slug;
    if (!objSlug) {
      skipped('views', 'no objects in this workspace');
    } else {
      const attrs = await call('list_attributes', { object: objSlug });
      const usable = (attrs.attributes || []).filter((a) => !a.is_archived).slice(0, 2).map((a) => a.api_slug);
      const before = await call('list_views', { object: objSlug });
      check('list_views reads an object', typeof before.count === 'number', `${before.count} views`);
      if (before.views[0]) {
        const gv = await call('get_view', { object: objSlug, view_id: before.views[0].entity_view_id });
        check('get_view resolves column slugs, not uuids',
          gv.columns.length === 0 || gv.columns.some((c) => c.path[0] && !UUIDish.test(c.path[0])),
          gv.columns.slice(0, 3).map((c) => c.path.join('.')).join(', '));
        check('get_view returns stored filter blocks', Array.isArray(gv.filter_blocks));
      }

      let viewId = null;
      try {
        const v = await call('create_view', { object: objSlug, title: `${PREFIX}view`, columns: usable });
        viewId = v.entity_view_id;
        check('create_view mints and creates', !!viewId, objSlug);
        check('columns created', v.columns_added === usable.length);

        const rt = await call('get_view', { object: objSlug, view_id: viewId });
        check('view round-trips', rt.view.title === `${PREFIX}view` && rt.columns.length === usable.length);

        const col = await call('add_view_column', { object: objSlug, view_id: viewId, attribute: usable[0] });
        check('add_view_column appends', col.column_count === usable.length + 1);

        // Filter write. NOTE: a stored block proves the write landed, not that the
        // filter is semantically right — same trap as config_state on workflows.
        const f = await call('set_view_filters', {
          object: objSlug, view_id: viewId,
          filters: [{ attribute: usable[0], value: 'zz-selftest', kind: 'generic' }],
        });
        check('set_view_filters stores a group + a filter block', f.blocks_stored === 2, `${f.blocks_stored} blocks`);
        const cleared = await call('set_view_filters', { object: objSlug, view_id: viewId, filters: [] });
        check('empty filters array clears them', cleared.blocks_stored === 0);

        let refused = '';
        try {
          await call('set_view_filters', {
            object: objSlug, view_id: viewId, filters: [{ attribute: usable[0], value: 'x', kind: 'date' }],
          });
        } catch (e) { refused = e.message; }
        check('unknown filter kind is refused, not guessed', /Unknown filter kind/.test(refused));
      } finally {
        if (viewId) {
          const d = await call('delete_view', { object: objSlug, view_id: viewId });
          check('view deleted and verified gone', d.verified_gone === true);
        }
      }
    }
    console.log('\n=== 8b2. Kanban views ===');
    // Discovers objects with status attributes, creates PREFIX-titled boards,
    // reads each back, deletes it. Refusal checks write nothing.
    {
      const objs = (await call('list_objects')).filter((o) => o.api_slug);
      const withStatus = [];
      for (const o of objs) {
        const a = (await call('list_attributes', { object: o.api_slug })).attributes || [];
        const st = a.filter((x) => x.type === 'pipeline' && !x.is_archived);
        const sel = a.find((x) => x.type === 'select' && !x.is_archived);
        withStatus.push({ slug: o.api_slug, status: st, select: sel });
      }

      const boards = [];
      const deals = withStatus.find((o) => o.slug === 'deals' && o.status.some((s) => s.api_slug === 'stage'));
      if (deals) boards.push({ object: 'deals', group_by: undefined, expect: 'stage', label: 'deals default -> stage' });
      const other = withStatus.find((o) => o.slug !== 'deals' && o.status.length);
      if (other) boards.push({ object: other.slug, group_by: other.status[0].api_slug, expect: other.status[0].api_slug, label: `${other.slug} by ${other.status[0].api_slug}` });
      if (!boards.length) skipped('kanban create', 'no object with a status attribute');

      for (const b of boards) {
        let id = null;
        try {
          const v = await call('create_view', {
            object: b.object, title: `${PREFIX}kanban`, type: 'kanban',
            ...(b.group_by ? { group_by: b.group_by } : {}), show_no_status: false,
          });
          id = v.entity_view_id;
          check(`kanban created (${b.label})`, !!id && v.type === 'kanban' && v.group_by.api_slug === b.expect);
          const rt = await call('get_view', { object: b.object, view_id: id });
          check(`kanban round-trips pivot + toggles (${b.label})`,
            rt.view.type === 'kanban' && rt.view.kanban.group_by[0] === b.expect &&
            rt.view.kanban.show_no_status === false && rt.view.kanban.show_time_in_status === true);

          // Status "is any of" filter: OR group of must-filters under the root AND.
          const stg = await call('list_select_options', { object: b.object, attribute: b.expect });
          const two = (stg.options || []).slice(0, 2).map((o) => o.title);

          // Column visibility (board settings toggle, not a filter).
          if (two.length === 2) {
            const sc = await call('set_kanban_columns', { object: b.object, view_id: id, show: [two[0]] });
            const back = await call('get_view', { object: b.object, view_id: id });
            check(`set_kanban_columns show-only round-trips (${b.label})`,
              sc.visible.length === 1 && back.view.kanban.visible_stages.length === 1 &&
              back.view.kanban.visible_stages[0] === two[0]);
            const un = await call('set_kanban_columns', { object: b.object, view_id: id, unhide: [two[1]] });
            check(`set_kanban_columns unhide adds one column (${b.label})`,
              un.changed === 1 && un.visible.includes(two[1]) && un.visible.length === 2);
            let bad = '';
            try { await call('set_kanban_columns', { object: b.object, view_id: id, show: ['ZZ no such stage'] }); }
            catch (e) { bad = e.message; }
            check(`unknown stage refused before writing (${b.label})`, /No stage/.test(bad));
          }
          if (two.length === 2) {
            const sf = await call('set_view_filters', {
              object: b.object, view_id: id, filters: [{ attribute: b.expect, kind: 'status', value: two }],
            });
            const orG = sf.stored.find((x) => x.block_type === 'group' && x.group_mode === 'or');
            check(`status "is any of" filter stored as OR group (${b.label})`,
              sf.blocks_stored === 4 && orG &&
              sf.stored.filter((x) => x.parent_entity_filter_block_id === orG.entity_filter_block_id).length === 2);
          }
        } finally {
          if (id) {
            const d = await call('delete_view', { object: b.object, view_id: id });
            check(`kanban deleted (${b.label})`, d.verified_gone === true);
          }
        }
      }

      const expectRefusal = async (label, args, re) => {
        let msg = '';
        try { await call('create_view', { title: `${PREFIX}should-not-exist`, ...args }); } catch (e) { msg = e.message; }
        check(label, re.test(msg), msg.slice(0, 90));
      };
      const selHost = withStatus.find((o) => o.select);
      if (selHost) {
        await expectRefusal('kanban on a select attribute is refused',
          { object: selHost.slug, type: 'kanban', group_by: selHost.select.api_slug }, /STATUS attribute only/);
      }
      if (other) {
        await expectRefusal('kanban without group_by off deals is refused',
          { object: other.slug, type: 'kanban' }, /needs group_by/);
      }
      const noStatus = withStatus.find((o) => !o.status.length);
      if (noStatus) {
        await expectRefusal('kanban on an object with no status attribute is refused',
          { object: noStatus.slug, type: 'kanban', group_by: 'anything' }, /NO status attributes/);
      }
      await expectRefusal('group_by on a table view is refused',
        { object: objSlug, group_by: 'stage' }, /kanban views only/);
    }
    console.log('\n=== 8b3. Reports (read-only) ===');
    // Dashboards cannot be deleted through this server yet, so the suite never creates
    // one. It previews reports, which is read-only, and checks preview against recount.
    {
      const dl = await call('list_dashboards');
      check('list_dashboards reads', typeof dl.count === 'number', `${dl.count} dashboards`);
      if (dl.dashboards[0]) {
        const gd = await call('get_dashboard', { dashboard_id: dl.dashboards[0].dashboard_id });
        check('get_dashboard reads cells', Array.isArray(gd.cells), `${gd.cells.length} cells`);
      }
      let pr = null;
      try {
        pr = await call('preview_report', { report: { title: 'selftest', source: { object: objSlug }, group: { attr: 'created_at' }, resolution: 'quarter' } });
      } catch (e) {
        if (/public API key/.test(e.message)) skipped('preview_report', 'no public API key for this workspace');
        else throw e;
      }
      if (pr) check('preview_report: Attio preview matches public-API recount', pr.check && pr.check.match === true,
        `${pr.check && pr.check.dataset_total} records, ${pr.check && pr.check.groups} groups`);
      if (pr) {
        const bad = await call('preview_report', { report: { title: 'x', source: { object: objSlug }, filters: [{ attr: 'created_at', op: 'after_relative', value: '-P1Y0M0DT0H0M0S' }] } });
        check('UI-unsupported relative date refused at compile', /not a UI-supported encoding/.test(bad.compile_error || ''), (bad.compile_error || '').slice(0, 80));
      }
    }
    console.log('\n=== 8c. Select options ===');
    // There is nothing disposable to test against here — a select attribute is
    // real workspace config. So: capture, change ONE colour, restore, verify.
    // The reorder path is deliberately NOT exercised here: it rewrites every
    // option's sort_order key, and this suite is meant to run in workspaces the
    // author does not own. verify-options.js covers reordering.
    let optRestore = null;
    try {
      // Specifically a SELECT here. Status attributes report type "pipeline" on
      // the internal API and live at a different route; 8f covers those.
      const selAttr = (await call('list_attributes', { object: objSlug })).attributes
        .find((a) => !a.is_archived && a.type === 'select');
      if (!selAttr) {
        skipped('select options', `no select attribute on ${objSlug}`);
      } else {
        const opts = await call('list_select_options', { object: objSlug, attribute: selAttr.api_slug });
        check('select options read on the cookie alone', opts.count > 0,
          `${opts.count} on ${objSlug}.${selAttr.api_slug}`);
        check('option ids and colors present',
          opts.options.every((o) => o.select_option_id && o.color));
        check('select options report kind "select"', opts.attribute_kind === 'select');

        if (opts.count > 0) {
          const t = opts.options[0];
          optRestore = { attribute: selAttr.api_slug, id: t.select_option_id, color: t.color };
          const swap = t.color === 'pastel_teal' ? 'pastel_violet' : 'pastel_teal';
          const res = await call('set_select_options', {
            object: objSlug, attribute: selAttr.api_slug, colors: { [t.select_option_id]: swap },
          });
          check('colour PATCH applied', res.colors_set === 1);
          const now = await call('list_select_options', { object: objSlug, attribute: selAttr.api_slug });
          check('colour change persisted',
            now.options.find((o) => o.select_option_id === t.select_option_id).color === swap);

          // A bad colour must never be stored. The palette is now enumerated, so
          // this is caught client-side with a usable message instead of being
          // sent on to earn an empty 400.
          let rejected = false;
          try {
            await call('set_select_options', {
              object: objSlug, attribute: selAttr.api_slug, colors: { [t.select_option_id]: 'not_a_colour' },
            });
          } catch (e) { rejected = /not an Attio palette colour|HTTP 400/.test(e.message); }
          check('invalid colour rejected, not stored', rejected);

          // The wrong NAMESPACE is the likelier mistake: pastel_* aimed at a
          // status attribute, or block_* at a select one. Same guarantee.
          let wrongNs = false;
          try {
            await call('set_select_options', {
              object: objSlug, attribute: selAttr.api_slug, colors: { [t.select_option_id]: 'block_red' },
            });
          } catch (e) { wrongNs = /wrong namespace/.test(e.message); }
          check('wrong colour namespace refused with a reason', wrongNs);

          // A bare name is accepted and prefixed for you.
          const bare = await call('set_select_options', {
            object: objSlug, attribute: selAttr.api_slug, colors: { [t.select_option_id]: 'teal' },
          });
          check('bare colour name is prefixed for the namespace', bare.colors_set === 1);
          const bareNow = await call('list_select_options', { object: objSlug, attribute: selAttr.api_slug });
          check('bare name resolved to pastel_teal',
            bareNow.options.find((o) => o.option_id === t.select_option_id).color === 'pastel_teal');
        }
      }
    } finally {
      if (optRestore) {
        await call('set_select_options', {
          object: objSlug, attribute: optRestore.attribute,
          colors: { [optRestore.id]: optRestore.color },
        });
        const back = await call('list_select_options', { object: objSlug, attribute: optRestore.attribute });
        check('original colour restored',
          back.options.find((o) => o.select_option_id === optRestore.id).color === optRestore.color,
          optRestore.color);
      }
    }
    console.log('\n=== 8d. Record layouts ===');
    // The save endpoint is a FULL REPLACE on a live record page, so this captures
    // the exact original element array and restores it in `finally`, then proves
    // the restore is byte-identical. If that last check ever fails, the layout is
    // wrong and the run says so loudly rather than exiting quietly.
    let layoutId = null, originalElements = null;
    try {
      const ls = await call('list_layouts', { object: objSlug });
      const rp = ls.layouts.find((l) => l.type === 'record-page');
      if (!rp) {
        skipped('layouts', `no record-page layout on ${objSlug}`);
      } else {
        layoutId = rp.custom_layout_id;
        const full = await call('get_layout', { layout_id: layoutId, raw: true });
        originalElements = full.raw_elements;
        check('get_layout returns a tree', full.tree.length > 0, `${full.element_count} elements`);

        // dry_run must not touch anything
        const dry = await call('edit_layout', {
          layout_id: layoutId, add_sections: [{ title: `${PREFIX}section` }], dry_run: true,
        });
        check('dry_run reports a diff', dry.dry_run === true &&
          dry.elements_after === dry.elements_before + 1);
        const unchanged = await call('get_layout', { layout_id: layoutId, raw: true });
        check('dry_run wrote nothing',
          JSON.stringify(unchanged.raw_elements) === JSON.stringify(originalElements));

        const attr = (await call('list_attributes', { object: objSlug })).attributes
          .find((a) => !a.is_archived);
        const res = await call('edit_layout', {
          layout_id: layoutId, add_sections: [{ title: `${PREFIX}section`, fields: [attr.api_slug] }],
        });
        check('section + field added', res.added.length === 2);
        const raw2 = (await call('get_layout', { layout_id: layoutId, raw: true })).raw_elements;
        check('full-replace preserved every original element',
          originalElements.every((o) => raw2.some((n) => n.element_id === o.element_id)),
          `${raw2.length} elements now`);

        const rem = await call('edit_layout', { layout_id: layoutId, remove: [`${PREFIX}section`] });
        check('removing a section takes its fields with it',
          rem.removed[0].elements_removed === 2, `${rem.removed[0].elements_removed} elements`);

        let guard = '';
        try { await call('set_layout', { layout_id: layoutId, elements: [] }); }
        catch (e) { guard = e.message; }
        check('set_layout refuses an empty array', /non-empty/.test(guard));
      }
    } finally {
      if (layoutId && originalElements) {
        await call('set_layout', { layout_id: layoutId, elements: originalElements });
        const back = (await call('get_layout', { layout_id: layoutId, raw: true })).raw_elements;
        check('layout restored byte-identical',
          JSON.stringify(back) === JSON.stringify(originalElements), `${back.length} elements`);
      }
    }

    console.log('\n=== 8e. Status (pipeline) options ===');
    // Status attributes are a SEPARATE namespace: type "pipeline" internally,
    // served from /pipeline-stages, ids named pipeline_stage_id, colours
    // block_* not pastel_*. Same capture/change/restore discipline as 8c.
    let stRestore = null;
    try {
      let stObj = null, stAttr = null;
      for (const o of [objSlug, 'deals', 'companies', 'people']) {
        if (!o) continue;
        let attrs;
        try { attrs = (await call('list_attributes', { object: o })).attributes; } catch { continue; }
        const hit = attrs.find((a) => !a.is_archived && /^(pipeline|status)$/.test(a.type || ''));
        if (hit) { stObj = o; stAttr = hit; break; }
      }
      if (!stAttr) {
        skipped('status options', 'no status attribute found in this workspace');
      } else {
        const opts = await call('list_select_options', { object: stObj, attribute: stAttr.api_slug });
        check('status options read on the cookie alone', opts.count > 0,
          `${opts.count} on ${stObj}.${stAttr.api_slug}`);
        check('status options report kind "status"', opts.attribute_kind === 'status');
        check('status ids come back as pipeline_stage_id',
          opts.options.every((o) => o.pipeline_stage_id && o.pipeline_stage_id === o.option_id));
        check('status colours use the block_ namespace',
          opts.options.every((o) => /^block_/.test(o.color || '')), opts.options[0] && opts.options[0].color);

        const t = opts.options[0];
        stRestore = { object: stObj, attribute: stAttr.api_slug, id: t.option_id, color: t.color };
        const swap = t.color === 'block_teal' ? 'block_violet' : 'block_teal';
        const res = await call('set_select_options', {
          object: stObj, attribute: stAttr.api_slug, colors: { [t.option_id]: swap },
        });
        check('status colour PATCH applied', res.colors_set === 1);
        const now = await call('list_select_options', { object: stObj, attribute: stAttr.api_slug });
        check('status colour change persisted',
          now.options.find((o) => o.option_id === t.option_id).color === swap);

        // The wrong namespace is the easy mistake here, and Attio answers it
        // with an empty 400. It must be caught before it is sent.
        let ns = false;
        try {
          await call('set_select_options', {
            object: stObj, attribute: stAttr.api_slug, colors: { [t.option_id]: 'pastel_red' },
          });
        } catch (e) { ns = /wrong namespace/.test(e.message); }
        check('pastel_* on a status attribute is refused with a reason', ns);
      }
    } finally {
      if (stRestore) {
        await call('set_select_options', {
          object: stRestore.object, attribute: stRestore.attribute,
          colors: { [stRestore.id]: stRestore.color },
        });
        const back = await call('list_select_options',
          { object: stRestore.object, attribute: stRestore.attribute });
        check('original status colour restored',
          back.options.find((o) => o.option_id === stRestore.id).color === stRestore.color,
          stRestore.color);
      }
    }

    console.log('\n=== 8f. Lists ===');
    // Fully disposable: this section creates its own list and deletes it, so
    // unlike 8c/8e nothing here touches real config. Creating a VIEW on a list
    // was previously believed impossible — that is the point of this section.
    let testListId = null, testListSlug = null;
    try {
      const listName = `ZZ-SELFTEST-LIST-${Date.now().toString(36)}`;
      const slug = listName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      testListSlug = slug;
      let made;
      try {
        made = await call('create_list', { name: listName, api_slug: slug, parent_object: 'companies' });
      } catch (e) {
        if (/needs an API key/.test(e.message)) { skipped('lists', 'no API key for this profile'); made = null; }
        else throw e;
      }
      if (made) {
        testListId = made.list_id;
        check('create_list returns a list_id', !!testListId, testListId);

        // Lists are not in /entity-definitions, so this is the cookie-only route.
        const catalogue = await call('list_lists');
        check('list_lists finds the new list on the cookie alone',
          catalogue.lists.some((l) => l.list_id === testListId), `${catalogue.count} lists`);

        // Kebab-case is the trap: the README example used it and Attio rejects it.
        let badSlug = false;
        try {
          await call('create_list', { name: 'ZZ Bad', api_slug: 'zz-bad-slug', parent_object: 'companies' });
        } catch (e) { badSlug = /snake_case/.test(e.message); }
        check('kebab-case slug refused before it reaches Attio', badSlug);

        // A list is an entity-definition, so the object tools address it by id.
        const lattrs = await call('list_attributes', { object: testListId });
        check('list attributes readable by list_id', lattrs.count > 0, `${lattrs.count} attributes`);
        check('parent_record present (internal-only attribute)',
          lattrs.attributes.some((a) => a.api_slug === 'parent_record'));

        // The headline: view creation on a list.
        const v = await call('create_view', {
          object: testListId, title: 'ZZ-SELFTEST-LIST-VIEW',
          columns: [[{ attribute: 'parent_record' }, { object: 'companies', attribute: 'name' }]],
        });
        check('create_view works on a LIST', !!v.entity_view_id, v.entity_view_id);
        check('multi-hop parent_record column created', v.columns_added === 1);

        const rt = await call('get_view', { object: testListId, view_id: v.entity_view_id });
        check('list view round-trips', rt.view.title === 'ZZ-SELFTEST-LIST-VIEW');
        check('column path resolves through parent_record',
          rt.columns[0] && rt.columns[0].hops === 2);

        const lv = await call('list_views', { object: testListId });
        check('new list view is listed', lv.count === 1);

        // add_select_options spans both APIs. Exercised here because the list is
        // disposable — nothing else in this suite can safely create options.
        // A fresh list has no select attribute and there is no tool to make one
        // (attribute creation is public-API only and out of scope here), so the
        // fixture is built directly. It dies with the list.
        const selOnList = await makeSelectAttr(testListId);
        if (!selOnList) {
          skipped('add_select_options', 'could not create a fixture select attribute (no API key?)');
        } else {
          const added = await call('add_select_options', {
            object: testListId, attribute: selOnList.api_slug,
            options: [{ title: 'ZZ Alpha', color: 'red' }, 'ZZ Beta'],
          });
          check('add_select_options creates options', added.created.length === 2);
          check('explicit colour applied despite public API ignoring it',
            added.created[0].color === 'pastel_red');
          // Attio assigns a RANDOM pastel_* colour here (was grey until at least 2026-09-03).
          check('option with no colour gets a valid pastel_* colour', /^pastel_[a-z-]+$/.test(added.created[1].color || ''), added.created[1].color);
          const again = await call('add_select_options', {
            object: testListId, attribute: selOnList.api_slug, options: ['ZZ Alpha'],
          });
          check('existing option is skipped, not duplicated',
            again.created.length === 0 && again.skipped.length === 1);
        }

        // Guard: deleting an OBJECT would take every record with it.
        let guarded = false;
        try {
          const objs = await call('list_objects');
          const c = objs.find((o) => o.api_slug === 'companies') || objs[0];
          await call('delete_list', { list_id: c.entity_definition_id, confirm_name: c.api_slug });
        } catch (e) { guarded = /not a list/.test(e.message); }
        check('delete_list refuses an object', guarded);

        // Guard: wrong confirm_name.
        let named = false;
        try {
          await call('delete_list', { list_id: testListId, confirm_name: 'something-else' });
        } catch (e) { named = /does not match/.test(e.message); }
        check('delete_list refuses a mismatched confirm_name', named);
      }
    } finally {
      if (testListId) {
        const d = await call('delete_list', { list_id: testListId, confirm_name: testListSlug });
        check('list deleted and verified gone', d.verified_gone === true);
      }
    }

    console.log('\n=== 8b. App blocks ===');
    const ab = await call('list_app_blocks');
    check('installed app blocks listed', Array.isArray(ab.apps), `${ab.count} apps`);
    const sys = await call('list_blocks');
    check('system catalog carries no app blocks', sys.blocks.every((b) => b.app === null));

    // Offline: the mapped corpus answers without a workspace.
    const lk = await call('describe_app_block', { app_block_id: 'c-lookup-row-find' });
    check('describe_app_block returns config + outcomes', lk.config.length > 0 && lk.outcomes.length > 0);
    check('gated block names its plan feature and portal steps',
      lk.prerequisites.plan_feature === 'automations.lookup' && lk.prerequisites.portal.length > 0);
    const outs = await call('list_block_outputs', { block_slug: 'send-email-notification' });
    check('list_block_outputs falls back to app source', outs.outcomes && outs.outcomes[0].id === 'queued');

    // A workflow with no start trigger cannot be a target.
    let noTarget = false;
    try { await call('app_workflow_target', { workflow_id: wf.workflow_id }); }
    catch (e) { noTarget = /no "Start a scheduled run" or "Start a subflow"/.test(e.message); }
    check('app_workflow_target refuses a workflow with no start trigger', noTarget);

    const awa = ab.apps.find((a) => a.app === 'workflow-utilities');
    if (!awa) {
      skipped('Advanced Workflow Automations build checks', 'app not installed in this workspace');
    } else {
      check('live install exposes every mapped block', awa.not_in_install.length === 0,
        awa.not_in_install.length ? `missing: ${awa.not_in_install.join(', ')}` : `v${awa.installed_version}`);
      check('every live block has a mapped spec', awa.blocks.every((b) => b.spec_known));

      const wf2 = await call('create_workflow', {
        title: `${PREFIX}app-blocks`,
        description: 'Automated self-test. Inert, never published, auto-deleted.',
      });
      created.push(wf2.workflow_id);
      const prov = (id) => ({ ...awa.provider_template, app_block_id: id });
      const obj = { type: 'attio-object', entity_definition_id: OBJ };

      // Subflow target: build a start trigger, then derive the encoded workflow_id from it.
      const start = await call('add_block', {
        workflow_id: wf2.workflow_id, block_type: 'trigger', provider: prov('j-subflow-start'),
        config: { type: 'object', entries: {
          object: obj,
          output_definitions: { type: 'array', items: ['Deal ID', 'Owner email'].map((name) => ({
            type: 'object', entries: { name: { type: 'string', value: name } } })) },
        } },
      });
      check('app trigger added', !!start.block_id);
      check('gated trigger review relays its plan feature',
        start.app_block_review && start.app_block_review.prerequisites.plan_feature === 'automations.schedule');
      const tgt = await call('app_workflow_target', { workflow_id: wf2.workflow_id });
      const sub = tgt.targets.find((t) => t.for_step === 'j-subflow-run');
      const expectSig = require('crypto').createHash('sha256')
        .update(JSON.stringify(['deal_id', 'owner_email'])).digest('hex');
      check('subflow target encodes [workflow, entry point, signature]',
        sub && sub.workflow_id_value === JSON.stringify([wf2.workflow_id, start.block_id, expectSig]));
      check('non-live target is flagged', !!tgt.warning);

      let badTarget = false;
      try {
        await call('add_block', { workflow_id: wf2.workflow_id, block_type: 'step', provider: prov('j-subflow-run'),
          config: { type: 'object', entries: { workflow_id: { type: 'string', value: wf2.workflow_id } } } });
      } catch (e) { badTarget = /workflow_id must be/.test(e.message); }
      check('bare-uuid subflow workflow_id refused before writing', badTarget);

      const run = await call('add_block', {
        workflow_id: wf2.workflow_id, block_type: 'step', provider: prov('j-subflow-run'),
        config: { type: 'object', entries: {
          object: obj, workflow_id: { type: 'string', value: sub.workflow_id_value } } },
      });
      check('subflow step accepts the built target', !!run.block_id);

      let badEnum = false;
      try {
        await call('add_block', { workflow_id: wf2.workflow_id, block_type: 'step', provider: prov('b-task-find'),
          config: { type: 'object', entries: { completion_status: { type: 'string', value: 'open' } } } });
      } catch (e) { badEnum = /must be one of/.test(e.message); }
      check('out-of-enum value refused before writing', badEnum);

      const tf = await call('add_block', {
        workflow_id: wf2.workflow_id, block_type: 'step', provider: prov('b-task-find'),
        config: { type: 'object', entries: {} },
      });
      check('review warns when the runtime default differs from the UI',
        tf.app_block_review.warnings.some((w) => /completion_status/.test(w)));

      let setRefused = false;
      try {
        await call('set_block_config', { workflow_id: wf2.workflow_id, block_id: tf.block_id,
          config: { type: 'object', entries: { completion_status: { type: 'string', value: 'nope' } } } });
      } catch (e) { setRefused = /must be one of/.test(e.message); }
      check('set_block_config reviews against the stored provider', setRefused);

      const back = await call('get_workflow', { workflow_id: wf2.workflow_id });
      check('app blocks read back with their provider',
        back.definition.blocks.filter((b) => b.provider.type === 'app').length === 3);
    }
  } catch (e) {
    fail++; console.log('\n  ERROR:', e.message);
  } finally {
    console.log('\n=== 9. Cleanup ===');
    for (const id of created) {
      try {
        const d = await call('delete_workflow', { workflow_id: id });
        check(`deleted ${id.slice(0, 8)}`, d.verified_gone === true);
      } catch (e) { check(`deleted ${id.slice(0, 8)}`, false, e.message); }
    }
    // Nothing with our prefix should survive, even from a crashed earlier run.
    try {
      const after = await call('list_workflows');
      const strays = (after.workflows || []).filter((w) => (w.title || '').startsWith(PREFIX));
      check('no self-test workflows left behind', strays.length === 0,
        strays.length ? strays.map((w) => w.title).join(', ') : 'workspace clean');
    } catch { /* ignore */ }

    console.log(`\n${'='.repeat(52)}`);
    console.log(`  ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
    console.log(`${'='.repeat(52)}`);
    child.stdin.end();
    process.exit(fail ? 1 : 0);
  }
})();
