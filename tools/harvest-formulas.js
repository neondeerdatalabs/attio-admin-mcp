#!/usr/bin/env node
'use strict';
// Read-only: walk every workspace the session cookie can reach, read every
// formula attribute's active snapshot, and record how references are stored
// (annotation type, field, and the referenced attribute's type).
// Output: docs/captures/formula-shapes.json (shapes only: no workspace slugs, titles or ids).
//   node tools/harvest-formulas.js [profile]
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = 'https://app.attio.com/api/common';
const profile = process.argv[2];
const cookieFile = path.join(os.homedir(), profile ? `.attio-session-${profile}` : '.attio-session');
const rawCookie = fs.readFileSync(cookieFile, 'utf8').trim();
const cookie = /attio-session=/.test(rawCookie) ? rawCookie : `attio-session=${rawCookie}`;

async function get(url) {
  const res = await fetch(url, { headers: { cookie, origin: 'https://app.attio.com', accept: 'application/json' } });
  if (!res.ok) return { _status: res.status };
  return res.json();
}
const unwrap = (x) => (Array.isArray(x) ? x : x && (x.value || x.data || x.items)) || [];

(async () => {
  const wss = unwrap(await get(`${ROOT}/workspaces`));
  const fieldByType = {};        // referenced attr type -> {field: count}
  const annoTypes = {};          // annotation type -> example (ids stripped)
  const outputTypes = {};        // attribute type of formula attrs -> count
  const overrides = {};          // output_type_override values -> count
  const configs = {};            // output type -> config keys seen
  const keywords = {};           // bare words in plaintext not inside quotes
  let formulas = 0;
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (/_id$/.test(k) && typeof v === 'string' ? '<id>' : v)));
  for (const w of wss) {
    const slug = (w.workspace || w).slug;
    if (!slug) continue;
    const defs = unwrap(await get(`${ROOT}/workspaces/${slug}/entity-definitions`));
    const attrIndex = {};
    const perDef = {};
    for (const d of defs) {
      const attrs = unwrap(await get(`${ROOT}/workspaces/${slug}/entity-definitions/${d.entity_definition_id}/attribute-definitions`));
      perDef[d.entity_definition_id] = attrs;
      for (const a of attrs) attrIndex[a.attribute_definition_id] = a;
    }
    for (const [eid, attrs] of Object.entries(perDef)) {
      for (const a of attrs) {
        const snap = a.formula_configuration && a.formula_configuration.active_snapshot_id;
        if (!snap) continue;
        const s = await get(`${ROOT}/workspaces/${slug}/entity-definitions/${eid}/attribute-definitions/${a.attribute_definition_id}/formula-attribute-snapshots/${snap}`);
        if (s._status) continue;
        formulas++;
        outputTypes[a.type] = (outputTypes[a.type] || 0) + 1;
        overrides[String(s.output_type_override)] = (overrides[String(s.output_type_override)] || 0) + 1;
        const cfgKey = Object.keys(a).filter((k) => /_configuration$/.test(k) && k !== 'formula_configuration' && k !== 'ai_autofill_configuration' && a[k]);
        configs[a.type] = configs[a.type] || {};
        for (const k of cfgKey) configs[a.type][k] = strip(a[k]);
        const noStrings = (s.formula_plaintext || '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
        for (const m of noStrings.match(/\b[a-z_][A-Za-z_]*\b(?!\s*\()/g) || []) keywords[m] = (keywords[m] || 0) + 1;
        for (const an of s.formula_annotations || []) {
          annoTypes[an.type] = annoTypes[an.type] || strip(an);
          if (an.type === 'entity-variable' && an.path && an.path.length) {
            const last = an.path[an.path.length - 1];
            const t = (attrIndex[last.attribute_definition_id] || {}).type || 'unknown';
            const key = `${t}${an.path.length > 1 ? ' (via path)' : ''}`;
            fieldByType[key] = fieldByType[key] || {};
            fieldByType[key][an.field] = (fieldByType[key][an.field] || 0) + 1;
          }
        }
      }
    }
    console.error(`${slug}: done`);
  }
  const out = { _note: 'Shapes harvested from saved formula attributes. No slugs, titles or ids.', formulas, output_types: outputTypes,
    output_type_overrides: overrides, output_configs: configs, field_by_referenced_type: fieldByType, annotation_types: annoTypes, bare_words: keywords };
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'captures', 'formula-shapes.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 1));
})();
