# Attio Workflows from Claude Code — Setup and Working Guide

Companion to `attio-workflow-api-reference.md`. The reference is the language-agnostic spec; this is how to actually drive it from Claude Code through the bundled MCP server.

> The reference is the source of truth for API behaviour. If the two ever disagree, believe the reference.

---

## 1. What this gets you

Build, read, modify and clone Attio workflows from a Claude Code session, with no browser automation.

**It cannot publish.** There is deliberately no publish or activate tool, so nothing here can make a workflow start firing on real data. Publishing stays a human action in the Attio UI. Deactivation *is* available, because turning something off is a safety valve.

Editing a **live** workflow is allowed and safe: every write targets the draft version, and the running automation uses the active version, so edits never change what is currently executing. Deleting a live workflow requires an explicit `confirm_delete_live: true`.

---

## 2. Credentials

You need **two**, and they do different jobs. This trips everyone up once.

| Credential | Where it goes | Covers |
|---|---|---|
| Session cookie | `~/.attio-session` | Workflows, objects, attributes, snapshots |
| API key | `~/.attio-apikey` | Select/status **option ids**, workspace members, lists |

An Attio API key returns `401` on the internal API, and the cookie is useless on the public one. Any workflow that branches on a status or select field needs both.

### 2.1 Capture the session cookie

In Chrome, logged into Attio:

1. DevTools → **Network**
2. **Clear the filter box** — a leftover filter is the usual reason nothing appears
3. Click **Fetch/XHR**
4. Click into any workflow so requests fire
5. Click any request to `app.attio.com/api/common/...`
6. **Headers → Request Headers → `Cookie:`** → copy the entire value

```bash
printf '%s\n' 'PASTE_THE_COOKIE_HERE' > ~/.attio-session
chmod 600 ~/.attio-session
```

Only `attio-session`, `attio-app-session` and `attio-session-id` matter. The rest is analytics noise.

**Watch out:** the bare UUID that's easy to grab first is `attio-session-id`, which does **not** authenticate. The credential is the `attio-session` JWT, a long `eyJ...` string.

**It expires every 30 days.** `check_session` reports exactly how long is left.

### 2.2 Add the API key

```bash
printf '%s\n' 'YOUR_ATTIO_API_KEY' > ~/.attio-apikey
chmod 600 ~/.attio-apikey
```

Or set `ATTIO_API_KEY`. Without it, `preflight` still returns objects and attributes but skips option ids and members, and says so in `warnings`.

### 2.3 Multiple workspaces and multiple accounts

**A cookie authenticates a *user*, not a workspace.**

- **Several workspaces on one account** → one cookie covers all. Pass `workspace_slug` on any call. No restart.
- **A workspace on a *different* account** → that account needs its own cookie, stored as a profile:

```bash
printf '%s\n' 'PASTE_COOKIE' > ~/.attio-session-clientco
printf '%s\n' 'CLIENT_API_KEY' > ~/.attio-apikey-clientco
chmod 600 ~/.attio-session-clientco ~/.attio-apikey-clientco
```

Then pass `profile: "clientco"` alongside `workspace_slug`.

Run `list_workspaces` to see exactly what a cookie can reach. If you target a workspace it can't see, the error names what it *can* reach rather than leaving you guessing.

---

## 3. Register with Claude Code

**Do not hand-edit `~/.claude.json`.** Claude Code owns that file and rewrites it on start and exit, silently discarding manual edits.

```bash
claude mcp add attio-admin -s user \
  -e ATTIO_WORKSPACE_SLUG=your-workspace \
  -- node /absolute/path/to/attio-admin-mcp/server.js
```

Verify with `claude mcp list` → `attio-admin: ✔ Connected`.

**Then restart Claude Code.** Tools load at session start, so they only appear in the *next* session. Registering and testing in the same session always looks like a failure.

No credential goes into any config file; the server reads the files itself.

---

## 4. Verify before trusting it

```bash
ATTIO_WORKSPACE_SLUG=your-workspace node test-full.js
```

Creates only `ZZ-SELFTEST-` workflows, never publishes, and deletes everything it creates. Existing workflows are read-only apart from being cloned.

Expect **40+ passed, 0 failed**. Some checks skip when a workspace has nothing to exercise them (no live workflow, no legacy workflow, no multi-block workflow to clone).

---

## 5. The working order

This is the part worth internalising. Configs reference everything by uuid and never by name, so resolution comes first.

### Step 1 — Resolve the workspace

```
preflight()
```

Scrapes objects, attributes, option ids, lists and members in one pass and caches to `~/.attio-admin-cache/<slug>.json`. Roughly 25 seconds on a mid-sized workspace. Pass `refresh: true` after schema changes.

### Step 2 — Turn names into ids

```
resolve(object: "deals", attribute: "stage", option: "Contacted")
```

Returns `object_node`, `attribute_node` and `value_node` ready to drop into a config, plus `variable_path_segment` for reading that attribute inside a variable path. **You should never type a uuid by hand.**

### Step 3 — Find the right block

```
list_blocks()
```

The workspace's live catalog, correct even on a brand-new account.

> **Use the provider slug, not the catalog slug.** `list_blocks` reports `system_block_type`; configs use a different name for about a dozen blocks (`outbound-webhook` is `send-http-request`, `foreach` is `for-each`). Reference §6.4 has the full table. Getting this wrong returns **200** and then renders as "Unsupported block" in the editor, with no API error at all. The same is true of an invalid `system_block_version`.

### Step 4 — Build

```
create_workflow → add_block (trigger) → add_block (steps) → connect_blocks
```

### Step 5 — Wire one step's output into the next

```
list_available_variables(workflow_id, block_id)     # block_id = the CONSUMER
```

The variable picker, headless. It walks every upstream block and returns paste-ready `variable` nodes with `block_instance_id`, `outcome`, `operations` and a matcher id already filled in. Drop the `node` into the consuming block's config and write it with `set_block_config`.

Add `expand_attributes_for: "companies"` to expand record-valued fields into one path per attribute, so you get `entity_instance.name` instead of a raw uuid hop.

Connect the blocks first — a block with nothing upstream can reference nothing.

### Step 6 — Publish yourself

In the Attio UI, deliberately.

---

## 6. What the server knows about block outputs

`list_available_variables` can only offer fields it knows a block emits, and Attio does not serve that for modern workflows (the picker is entirely client-side). So the server ships two catalogs:

| File | Source | Trust |
|---|---|---|
| `block-outputs.json` | Harvested from real modern workflows | Real config keys, usable directly |
| `legacy-block-schemas.json` | `schema.outputs` on legacy snapshot nodes | Server-provided, but legacy naming |

`list_block_outputs` returns both and flags where they diverge. They genuinely do: legacy `on-record-updated` exposes `record`, modern exposes `entity_instance`. Where they agree (`find-records` → `records`, `match_count`) confidence is high.

**Both are observational.** A block missing from them means "not yet seen", never "has no outputs".

**They improve with use.** Any workflow anyone builds using an unknown block teaches it permanently:

```bash
node harvest-variables.js       > /tmp/corpus.json        # modern workflows
node harvest-legacy-schemas.js  > /tmp/legacy.json        # legacy snapshots
```

Both accept `--profile <name>` and sweep every workspace the cookie reaches.

---

## 7. Legacy workflows

Older workspaces are full of pre-modern workflows: `is_modern: false`, no version records, invisible to the version endpoints. They are still live and still firing.

`get_workflow` detects them and reads their snapshot instead, returning `legacy: true` plus the snapshot list. Nothing special is required of you.

**Writing to them is not supported.** The safe pattern is to read the legacy definition, rebuild it as a modern workflow, verify, then retire the old one in the UI.

Worth knowing before an audit: in one client workspace, 8 of 11 workflows were legacy. Any tool that only speaks the modern API will silently under-report what a client actually has running.

---

## 8. Tool reference

Every tool takes optional `workspace_slug` (defaults to `ATTIO_WORKSPACE_SLUG`) and `profile` (defaults to `~/.attio-session`).

| Tool | Purpose |
|---|---|
| `preflight` | **Start here on a new account.** Objects, attributes, option ids, lists, members. Cached |
| `resolve` | Names → uuids and ready config nodes |
| `list_workspaces` | Every workspace a cookie can reach, plus available profiles |
| `check_session` | Validate the cookie, report JWT expiry |
| `list_objects` | Objects with their uuids |
| `list_attributes` | One object's attributes with their uuids |
| `list_blocks` | The workspace's live block catalog |
| `list_block_outputs` | What a block emits, modern and legacy |
| `list_available_variables` | The variable picker, headless |
| `list_workflows` | id, title, status |
| `get_workflow` | Full definition; handles legacy transparently |
| `create_workflow` | Always sets `is_modern: true` |
| `add_block` | Add a trigger or step |
| `set_block_config` | Update an existing block's config |
| `connect_blocks` | Create an edge |
| `clone_workflow` | Clone with id remapping, self-verifying |
| `deactivate_workflow` | Take a live workflow to `paused` |
| `delete_workflow` | Delete and confirm gone |

---

## 9. Traps worth knowing before you start

These cost the most time. Full detail in the reference.

- **`Origin: https://app.attio.com` on every non-GET.** Without it, `403`, which reads like a permissions problem. Browsers set it invisibly; your client must not.
- **`is_modern: true` when creating.** Without it no draft version is provisioned and the workflow is unusable.
- **`PUT` on an existing block returns `409`.** It's create-only. Use `set_block_config`.
- **Config keys differ per block and aren't guessable.** `on-record-created` uses `object`; `find-records` uses `entity` plus a required `limit`.
- **Wrong slug or wrong version fails silently.** 200 on write, "Unsupported block" in the editor.
- **`400` bodies are empty.** No validation detail whatsoever. Work the §9 table in order.
- **The UI picker's field counts are filtered by the target input's type.** "No data" means nothing matched that field type, not that the block has no outputs.
- **Confirm the workspace slug before any write.** One slug separates a sandbox from production.

---

## 10. Security

- **Never commit a session cookie or API key.** They grant full access as you. `.gitignore` covers the obvious names, but keeping them in `~` is the real safeguard.
- The cookie is **per-user and unscopeable**. Everything done through it carries your permissions and appears as you in `created_by`.
- mitmproxy `.flows` captures and `.har` exports contain live cookies. Both are gitignored; don't share them.
