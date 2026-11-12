'use strict';
// Run history for modern (versioned) workflows, plus retry. Shapes captured
// from the Attio UI on 2026-11-12 (docs/captures/workflow-runs-2026-11-12.md).
//
//   GET  /workflows/{wf}/runs/latest                       -> newest run's sort_key
//   POST /workflows/{wf}/runs/query                        -> runs, newest first, cursor paged
//   GET  /workflows/{wf}/versions/{ver}/runs/{run}         -> one run
//   GET  .../runs/{run}/frames                             -> root / loop / retry frames
//   GET  .../frames/{frame}/block-executions               -> per-block status, error, attempts
//   GET  .../block-executions/{exec}/outcome-data          -> the block's output values
//   POST .../block-executions/{exec}/retry                 -> re-run a failed block (a write)
//
// The UI has no server-side status filter and never shows evaluated inputs, so
// neither does this: status is filtered client-side, and inputs are not exposed.

const { randomUUID } = require('crypto');

const PAGE = 500;

function makeRunTools({ api, unwrap, ctxFrom, scoped }) {
  const list = (r) => { const v = unwrap(r); return Array.isArray(v) ? v : []; };

  async function modernWorkflow(id, ctx) {
    const wf = await api(`/workflows/${id}`, { ctx });
    if (!wf.draft_workflow_version_id && !wf.active_workflow_version_id) {
      throw new Error(`"${wf.title}" is a legacy (pre-modern) workflow. Its run history uses a different ` +
        'API (GET /workflows/{id}/runs, /workflow-runs/{id}) that these tools do not read.');
    }
    return wf;
  }

  // Yields runs newest first. Seeded from runs/latest; each next page starts
  // after the last row seen. Stops on a short page.
  async function* runsOf(wf, ctx) {
    const latest = await api(`/workflows/${wf}/runs/latest`, { ctx });
    if (!latest || !latest.latest_run) return;
    let cursor = { sort_key: latest.latest_run.sort_key, inclusive: true };
    for (;;) {
      const page = list(await api(`/workflows/${wf}/runs/query`, {
        method: 'POST', ctx, body: { sort_key_cursor: cursor, limit: PAGE, filter: {} },
      }));
      for (const r of page) yield r;
      if (page.length < PAGE) return;
      cursor = { sort_key: page[page.length - 1].sort_key, inclusive: false };
    }
  }

  async function findRun(wf, runId, ctx) {
    if (!runId) {
      for await (const r of runsOf(wf, ctx)) return r;
      throw new Error('This workflow has never run.');
    }
    for await (const r of runsOf(wf, ctx)) if (r.workflow_version_run_id === runId) return r;
    throw new Error(`Run ${runId} not found on workflow ${wf}.`);
  }

  const runSummary = (r) => ({
    run_id: r.workflow_version_run_id,
    number: r.sequence_number,
    status: r.status,
    version_id: r.workflow_version_id,
    started_at: r.created_at,
    finished_at: r.completed_at || r.failed_at || r.canceled_at || null,
    retried_from: r.retried_from,
  });

  // Block labels for a version: provider slug plus the block's own description.
  async function blockLabels(wf, ver, ctx) {
    const out = {};
    try {
      for (const b of list(await api(`/workflows/${wf}/versions/${ver}/block-instances`, { ctx }))) {
        const p = b.provider || {};
        out[b.workflow_version_block_instance_id] = {
          block_type: b.block_type,
          block: p.system_block_slug || p.app_block_id || p.type || null,
          description: b.description || null,
        };
      }
    } catch { /* labels are a convenience; a run still reads without them */ }
    return out;
  }

  // Attio runtime values are typed trees ({__type, entries|value|...}). Flatten
  // to plain JSON so outputs are readable.
  function plain(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(plain);
    if (v.__type === 'object' && v.entries) {
      return Object.fromEntries(Object.entries(v.entries).map(([k, x]) => [k, plain(x)]));
    }
    for (const k of ['items', 'elements', 'values']) if (Array.isArray(v[k])) return v[k].map(plain);
    if ('value' in v && Object.keys(v).length <= 2) return plain(v.value);
    const { __type, ...rest } = v;
    return __type ? { type: __type, ...rest } : rest;
  }

  async function readRun(wf, run, { outputs, blockId }, ctx) {
    const R = `/workflows/${wf}/versions/${run.workflow_version_id}/runs/${run.workflow_version_run_id}`;
    const [frames, labels, pointers] = await Promise.all([
      api(`${R}/frames`, { ctx }).then(list),
      blockLabels(wf, run.workflow_version_id, ctx),
      api(`${R}/retry-pointers`, { ctx }).catch(() => null),
    ]);
    const steps = [];
    for (const f of frames) {
      const execs = list(await api(`${R}/frames/${f.workflow_version_run_frame_id}/block-executions`, { ctx }));
      for (const x of execs) {
        const id = x.workflow_version_block_instance_id;
        if (blockId && id !== blockId) continue;
        const step = {
          frame: f.type,
          frame_id: f.workflow_version_run_frame_id,
          block_id: id,
          ...(labels[id] || {}),
          execution_id: x.workflow_version_run_frame_block_execution_id,
          status: x.status,
          outcome: x.outcome,
          ...(x.failure_reason ? { failure_reason: x.failure_reason } : {}),
          ...(x.error_message ? { error: x.error_message } : {}),
          ...(x.waiting_reason ? { waiting_reason: x.waiting_reason } : {}),
          ...(x.did_continue_on_error ? { continued_on_error: true } : {}),
          attempts: x.attempts,
          credits: x.execution_cost ? x.execution_cost.amount : 0,
          started_at: x.started_executing_at,
          finished_at: x.completed_at || x.failed_at || x.canceled_at || null,
          has_output: x.has_outcome_data,
        };
        if (outputs && x.has_outcome_data) {
          const od = await api(`${R}/frames/${f.workflow_version_run_frame_id}/block-executions/${step.execution_id}/outcome-data`, { ctx });
          step.output = plain(od.runtime_value);
        }
        steps.push(step);
      }
    }
    steps.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
    return { frames: frames.map((f) => ({ frame_id: f.workflow_version_run_frame_id, type: f.type, status: f.status, parent: f.parent_workflow_version_run_frame_id })), steps, retried_to: pointers ? pointers.retried_to : null };
  }

  return {
    list_workflow_runs: {
      description:
        'List a published workflow\'s runs, newest first: run id, number, status, version, start/finish times, ' +
        'plus 7-day statistics and the all-time run count. status filters client-side (Attio has no server filter). ' +
        'Modern workflows only. Read-only.',
      inputSchema: scoped({
        workflow_id: { type: 'string' },
        status: { type: 'string', description: 'Only runs with this status, e.g. failed, completed, executing.' },
        limit: { type: 'number', description: 'Max runs returned after filtering. Default 50.' },
        since: { type: 'string', description: 'ISO date/time; stop at runs older than this.' },
      }, ['workflow_id']),
      async run(args) {
        const ctx = ctxFrom(args);
        const wf = await modernWorkflow(args.workflow_id, ctx);
        const limit = args.limit ?? 50;
        const since = args.since ? Date.parse(args.since) : null;
        if (args.since && Number.isNaN(since)) throw new Error(`since "${args.since}" is not a date.`);
        const runs = []; let scanned = 0;
        for await (const r of runsOf(args.workflow_id, ctx)) {
          if (since !== null && Date.parse(r.created_at) < since) break;
          scanned++;
          if (args.status && r.status !== args.status && r.filterable_status !== args.status) continue;
          runs.push(runSummary(r));
          if (runs.length >= limit) break;
        }
        const [stats, counts] = await Promise.all([
          api(`/workflows/${args.workflow_id}/statistics`, { ctx }).catch(() => null),
          api('/workflows/batch-run-counts', { method: 'POST', ctx, body: { workflow_ids: [args.workflow_id] } }).catch(() => null),
        ]);
        const c = counts && counts[args.workflow_id];
        return {
          workspace: ctx.slug, workflow_id: wf.workflow_id, title: wf.title || wf.ai_title || null, status: wf.status,
          total_runs: c && c.value ? c.value.value : null,
          last_7_days: stats ? {
            runs: stats.last_7_days_runs, completed: stats.last_7_days_completed_runs, failed: stats.last_7_days_failed_runs,
            filtered: stats.last_7_days_filtered_runs, executing: stats.last_7_days_executing_runs,
            credits: stats.last_7_days_credits_consumed,
          } : null,
          scanned, returned: runs.length, runs,
        };
      },
    },

    get_workflow_run: {
      description:
        'Read one workflow run step by step: each block\'s status, outcome, error message, attempts, credits and timing, ' +
        'across root, loop and retry frames. include_outputs adds each block\'s output values (real record data). ' +
        'Block inputs are not available: Attio does not expose them. Defaults to the latest run. Read-only.',
      inputSchema: scoped({
        workflow_id: { type: 'string' },
        run_id: { type: 'string', description: 'Default: the latest run.' },
        include_outputs: { type: 'boolean', description: 'Fetch each block\'s output values. Default false.' },
        block_id: { type: 'string', description: 'Only this block (workflow_version_block_instance_id).' },
      }, ['workflow_id']),
      async run(args) {
        const ctx = ctxFrom(args);
        const wf = await modernWorkflow(args.workflow_id, ctx);
        const run = await findRun(args.workflow_id, args.run_id, ctx);
        const detail = await readRun(args.workflow_id, run, { outputs: !!args.include_outputs, blockId: args.block_id }, ctx);
        const failed = detail.steps.filter((s) => s.status === 'failed');
        return {
          workspace: ctx.slug, workflow_id: wf.workflow_id, title: wf.title || wf.ai_title || null,
          run: runSummary(run),
          failed_steps: failed.length,
          ...detail,
        };
      },
    },

    retry_workflow_run: {
      description:
        'Retry a failed block in a workflow run, as the UI Retry button does. This RE-RUNS the block and everything after ' +
        'it for real (emails, record writes). Without confirm:true it only previews what would be retried. ' +
        'Retries the run\'s failed block; pass execution_id if more than one failed.',
      inputSchema: scoped({
        workflow_id: { type: 'string' },
        run_id: { type: 'string' },
        execution_id: { type: 'string', description: 'The failed block execution to retry (from get_workflow_run).' },
        confirm: { type: 'boolean', description: 'Must be true to actually retry. Ask the human first.' },
      }, ['workflow_id', 'run_id']),
      async run(args) {
        const ctx = ctxFrom(args);
        const wf = await modernWorkflow(args.workflow_id, ctx);
        const run = await findRun(args.workflow_id, args.run_id, ctx);
        const detail = await readRun(args.workflow_id, run, { outputs: false }, ctx);
        // A block that failed and was retried already has a newer execution; only
        // the most recent execution of each block is a retry candidate.
        const newest = {};
        for (const s of detail.steps) newest[s.block_id] = s;
        const failed = Object.values(newest).filter((s) => s.status === 'failed');
        let target;
        if (args.execution_id) {
          target = detail.steps.find((s) => s.execution_id === args.execution_id);
          if (!target) throw new Error(`Execution ${args.execution_id} is not in run ${args.run_id}.`);
          if (target.status !== 'failed') throw new Error(`Execution ${args.execution_id} is ${target.status}, not failed.`);
        } else if (failed.length === 1) {
          target = failed[0];
        } else if (!failed.length) {
          throw new Error(`Run #${run.sequence_number} has no failed block to retry (status ${run.status}).`);
        } else {
          throw new Error(`Run #${run.sequence_number} has ${failed.length} failed blocks. Pass execution_id: ` +
            failed.map((s) => `${s.execution_id} (${s.block || s.block_id}: ${s.error || s.failure_reason})`).join('; '));
        }
        const preview = {
          workspace: ctx.slug, workflow_id: wf.workflow_id, title: wf.title || wf.ai_title || null, run: runSummary(run),
          retry: { block_id: target.block_id, block: target.block, description: target.description, execution_id: target.execution_id, error: target.error || target.failure_reason },
        };
        if (args.confirm !== true) {
          return { ...preview, retried: false, note: 'Preview only. Retrying re-runs this block and every block after it for real. Pass confirm:true once the human agrees.' };
        }
        const R = `/workflows/${args.workflow_id}/versions/${run.workflow_version_id}/runs/${run.workflow_version_run_id}`;
        const res = await api(`${R}/frames/${target.frame_id}/block-executions/${target.execution_id}/retry`, {
          method: 'POST', ctx,
          body: { retry_workflow_version_run_frame_id: randomUUID(), retry_workflow_version_run_frame_block_execution_id: randomUUID() },
        });
        return {
          ...preview, retried: true,
          run_status: res.workflow_version_run && res.workflow_version_run.status,
          retry_frame_id: res.retry_workflow_version_run_frame && res.retry_workflow_version_run_frame.workflow_version_run_frame_id,
          note: 'Retry started. Read the result with get_workflow_run in a few seconds.',
        };
      },
    },
  };
}

module.exports = { makeRunTools };
