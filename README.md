# attio-admin-mcp

Configure an Attio workspace programmatically — **workflows, lists, views, select and status option colours, and record-page layouts**. Attio's public API exposes almost none of it.

Three things live here:

| | |
|---|---|
| **`docs/attio-workflow-api-reference.md`** | Language-agnostic API spec for Workflows. curl throughout. Read this if you're writing your own client. |
| **`docs/attio-internal-api-reference.md`** | The rest of the internal surface: views, filters, select options, record layouts. Same cookie, same `Origin` rule. |
| **`server.js`** | A zero-dependency MCP server for Claude Code, and the reference implementation of that spec. |

Reverse-engineered and verified against live workspaces, Aug 2026.

> **Named `attio-admin-mcp` as of v4.0.0** (was `attio-workflow-mcp`). It outgrew workflows. The registered server is `attio-admin`, so tools are `mcp__attio-admin__*`.

> **Unofficial and undocumented.** This is the internal API behind `app.attio.com`, not a supported product surface. Attio can change it without notice. It is not covered by their public API guarantees.

---

## Quick start (no coding experience needed)

This walks you through connecting the tools to Claude on your own computer in about 15 minutes. You'll copy and paste a few things; you don't need to write any code.

**Where it works:** the **Claude desktop app** (Mac or Windows) and **Claude Code**. It does **not** work on claude.ai in a web browser or on the phone app, because it runs on your computer and reads your Attio login from there.

### Step 1. Install Node.js

Node.js is the free program that runs these tools.

1. Go to [nodejs.org](https://nodejs.org) and download the **LTS** version.
2. Run the installer and accept the defaults.
3. Check it worked: open **Terminal** (Mac: press Cmd+Space, type Terminal) or **PowerShell** (Windows: Start menu, type PowerShell), then type `node --version` and press Enter. You should see something like `v22.x.x`.

### Step 2. Download this project

1. At the top of this GitHub page, click the green **Code** button, then **Download ZIP**.
2. Unzip it and move the folder somewhere permanent, such as your Documents folder. Don't leave it in Downloads, where it might get cleaned up.
3. Note the folder's full location. You'll need the path to the `server.js` file inside it, for example:
   - Mac: `/Users/yourname/Documents/attio-admin-mcp/server.js`
   - Windows: `C:\Users\yourname\Documents\attio-admin-mcp\server.js`

   Tip: on a Mac, drag `server.js` into a Terminal window and the full path appears. On Windows, hold Shift, right-click `server.js` and choose **Copy as path**.

### Step 3. Copy your Attio login (session cookie)

Attio API keys don't work for these tools. They use the same login your browser uses. This is personal to you, so treat it like a password and never share it.

1. In **Google Chrome**, log in to Attio and open any workflow.
2. Open the developer tools: Mac **Cmd+Option+I**, Windows **Ctrl+Shift+I**.
3. Click the **Network** tab. Make sure the filter box is empty, then click **Fetch/XHR**.
4. Click around in Attio (open another workflow) so items appear in the list.
5. Click any item whose name starts with something like `workflows` or `objects`. On the right, under **Headers**, scroll to **Request Headers** and find the line starting with **cookie:**.
6. Right-click the value next to **cookie:**, choose **Copy value**.

Now save it to a file. With the cookie still copied, paste **one** of these into Terminal / PowerShell and press Enter:

- **Mac:**
  ```bash
  pbpaste > ~/.attio-session && chmod 600 ~/.attio-session
  ```
- **Windows (PowerShell):**
  ```powershell
  Get-Clipboard | Set-Content "$HOME\.attio-session"
  ```

This creates a hidden file called `.attio-session` in your home folder. **It expires every 30 days.** When the tools start saying your session expired, repeat this step.

### Step 4. Find your workspace slug

Look at your Attio address bar: `app.attio.com/`**`your-workspace`**`/...`. The bold part is your workspace slug.

### Step 5. Connect it to Claude

**Claude desktop app:**

1. Open the Claude app, then **Settings → Developer → Edit Config**. This opens a file called `claude_desktop_config.json`.
2. Replace its contents with the block below (if the file already has other servers in `mcpServers`, add the `attio-admin` entry alongside them instead):

   ```json
   {
     "mcpServers": {
       "attio-admin": {
         "command": "node",
         "args": ["/Users/yourname/Documents/attio-admin-mcp/server.js"],
         "env": { "ATTIO_WORKSPACE_SLUG": "your-workspace" }
       }
     }
   }
   ```

3. Change the path to your `server.js` from Step 2, and `your-workspace` to your slug from Step 4.
   - **Windows:** write the path with double backslashes, e.g. `"C:\\Users\\yourname\\Documents\\attio-admin-mcp\\server.js"`.
4. Save the file, then **fully quit** Claude (Mac: Cmd+Q; Windows: right-click the tray icon, Quit) and open it again.

**Claude Code:** run this once, with your own path and slug, then start a new Claude Code session:

```bash
claude mcp add attio-admin -s user -e ATTIO_WORKSPACE_SLUG=your-workspace -- node /full/path/to/attio-admin-mcp/server.js
```

### Step 6. Try it

Start a new chat and ask: **"Check my Attio session."** Claude should report your login is valid and how many days are left. Then try **"List my Attio workflows."**

### If something goes wrong

| What you see | Fix |
|---|---|
| The tools don't appear in Claude | Fully quit and reopen Claude. Check the path to `server.js` is correct and the config file is valid JSON (every `"` and `,` in place). |
| "node" not found, or the server fails to start (Mac) | Run `which node` in Terminal and put that full path (e.g. `/usr/local/bin/node`) in place of `"node"` in the config. |
| Session expired / 401 errors | Your cookie is older than 30 days, or you logged out of Attio. Redo Step 3. |
| Workspace not reachable | The slug is wrong, or your login doesn't belong to that workspace. The error lists the workspaces your login can reach. |

Everything below is the detailed reference.

---

## What it does and doesn't do

**Does:** create, read, update, clone and delete workflows; add/configure/connect/delete blocks; wire one step's output into the next step's input; deactivate a live workflow. Also drives the rest of Attio's internal surface, almost none of which the public API exposes: **lists** (create, discover, delete), **views** (create, multi-hop columns, filters, delete — on objects *and* lists), **select and status option colours and order**, and **record-page layouts** (sections, fields, removal).

**Does not:** publish. There is deliberately no publish or activate tool. This builds and modifies **drafts only**, so nothing here can make a workflow start firing on real data. Publishing stays a human action in the Attio UI. Attio's `commit` + `activate` flow was fully mapped on 2026-08-24 and is written up in reference §5.4 — the tool's absence is a standing decision, not a gap. Do not add it without asking.

**Reads legacy workflows.** Pre-modern workflows have no version records and are invisible to most tooling. `get_workflow` detects them and reads their snapshot instead, so they show up like anything else. Writing to them is not supported.

**Doesn't replace the public API.** Records, objects and attributes are all better handled by Attio's public API or an `attio-mcp` server. Use those for data; use this for workspace configuration. (Lists are the exception that straddles both: creation is public-API only, deletion is internal-API only, so `create_list` and `delete_list` live here.)

---

## Requirements

- Node 18+ (uses built-in `fetch`). No dependencies to install.
- An Attio account with Workflows enabled.
- Your own session cookie — see below. **Credentials are per-user; you cannot use someone else's.**

---

## Setup

### 1. Capture your session cookie

Attio **API keys do not work** on this API (they return `401`). The only credential is a browser session cookie.

In Chrome, logged into Attio:

1. Open DevTools → **Network** tab.
2. **Clear any text in the filter box** (a leftover filter is the usual reason nothing appears).
3. Click **Fetch/XHR**.
4. Click into any workflow so requests fire.
5. Click any request to `app.attio.com/api/common/...`.
6. **Headers → Request Headers → `Cookie:`** → copy the entire value.

Save it as a single line:

```bash
printf '%s\n' 'PASTE_THE_COOKIE_HERE' > ~/.attio-session
chmod 600 ~/.attio-session
```

Only `attio-session`, `attio-app-session` and `attio-session-id` matter; the rest is analytics noise you can delete.

**This expires every 30 days.** `attio-session` is a JWT, so `check_session` reports exactly how long you have left. When it lapses, repeat this step.

### 2. Find your workspace slug

It's in your Attio URL: `app.attio.com/<workspace-slug>/...`

Run `list_workspaces` at any time to see every workspace your cookie can reach.

### 2b. Multiple workspaces and multiple accounts

**A cookie authenticates a *user*, not a workspace.** It reaches exactly the workspaces that user belongs to. This trips people up, so it's worth being precise:

- **Several workspaces on the same Attio account** → one cookie covers all of them. Pass `workspace_slug` on any tool call to switch. No restart, no re-registration.
- **A workspace on a *different* Attio account** (a separate login) → you need that account's cookie, stored as a **profile**.

To add a profile, capture the cookie while logged into that account and save it as `~/.attio-session-<name>`:

```bash
printf '%s\n' 'PASTE_COOKIE' > ~/.attio-session-clientco
chmod 600 ~/.attio-session-clientco
```

Then pass `profile: "clientco"` on any tool call, alongside `workspace_slug`.

If you target a workspace the cookie can't see, the error tells you what that cookie *can* reach rather than leaving you guessing.

### 3. Verify before wiring anything up

```bash
ATTIO_WORKSPACE_SLUG=your-workspace node test-full.js
```

This runs the whole suite against your workspace. It creates only `ZZ-SELFTEST-` workflows, never publishes, and deletes everything it creates. Existing workflows are read-only, apart from being cloned.

Expect `120+ passed, 0 failed`. Some checks skip if your workspace has no live, legacy, or multi-block workflow to exercise them.

### 4. Register with Claude Code

**Do not hand-edit `~/.claude.json`.** Claude Code owns that file and rewrites it on start/exit, silently discarding manual edits. Use the CLI:

```bash
claude mcp add attio-admin -s user \
  -e ATTIO_WORKSPACE_SLUG=your-workspace \
  -- node /absolute/path/to/attio-admin-mcp/server.js
```

Verify with `claude mcp list` → `attio-admin: ✔ Connected`.

**Then restart Claude Code.** Tools load at session start, so they only appear in the *next* session. Registering and checking in the same session always looks like a failure.

No credential goes into any config file; the server reads `~/.attio-session` itself. `ATTIO_SESSION_COOKIE` overrides it if you'd rather pass it in the environment.

---

## Tools

Every tool takes optional **`workspace_slug`** (defaults to `ATTIO_WORKSPACE_SLUG`) and **`profile`** (defaults to `~/.attio-session`).

| Tool | Purpose |
|---|---|
| `preflight` | **Run this first on any new account.** Resolves objects, attributes, option ids, lists and members in one pass, and caches them |
| `resolve` | Turn names into uuids: `deals` + `stage` + `Contacted` → a ready comparison node |
| `list_workspaces` | Every workspace a cookie can reach, plus available profiles. **Start here when access is wrong.** |
| `check_session` | Validate the cookie, report JWT expiry. **Run first.** |
| `list_objects` | Workspace objects with their UUIDs (configs reference objects by UUID, never slug) |
| `list_blocks` | The workspace's live catalog of **system** blocks, correct on a brand-new account. App blocks are not in it |
| `list_app_blocks` | Blocks from **installed apps** (Slack, lemlist, Neon Deer apps, …) with the live `app_id`, a ready `provider`, and portal prerequisites for mapped apps |
| `get_formula` / `create_formula_attribute` / `update_formula` | Formula attributes, which the public API can't touch. Readable syntax (`{Deal value}`, `{Associated company > Name}`, `{Deal stage: Won}`), read back after every save, and a check of computed values on sample records. See [docs/formulas.md](docs/formulas.md) |
| `generate_formula` | Ask Attio's own formula AI to write or fix a formula from a prompt. Writes nothing |
| `list_workflow_runs` | A published workflow's runs, newest first, with status filter, 7-day stats and total count. Read-only |
| `get_workflow_run` | One run step by step: each block's status, error, attempts, credits; `include_outputs` adds output values. Inputs are not exposed by Attio |
| `retry_workflow_run` | Retry a failed block, like the UI Retry button. Previews unless `confirm: true`; re-runs for real |
| `workflow_guide` | Context for building workflows: tested block references (inputs, outputs, example config, known gaps, evidence level), 5 recipes with the MCP tools that build them, guides and build rules. Search with `query`. Offline |
| `describe_app_block` | Full schema of a mapped app block: config keys, allowed values, outcomes, portal prerequisites, gotchas. Offline |
| `app_workflow_target` | Builds the encoded `workflow_id` that "Schedule a workflow run" and "Call a subflow" expect, from the target workflow |
| `list_attributes` | An object's attributes with their UUIDs. Needed for variable paths that read a record field |
| `list_block_outputs` | What a block type emits downstream, i.e. what you can build a variable from |
| `list_available_variables` | **The variable picker, headless.** Given a block, returns paste-ready variable nodes from every upstream block |
| `list_workflows` | id, title, status |
| `get_workflow` | Full definition: blocks + configs + paths |
| `create_workflow` | Always sets `is_modern: true` |
| `add_block` | Add a trigger or step |
| `set_block_config` | Update an existing block's config |
| `update_block` | Set a block's `description` and `position`. These are block-instance metadata, **not** config, so `set_block_config` cannot touch them |
| `connect_blocks` | Create an edge |
| `clone_workflow` | Clone with id remapping, self-verifying |
| `deactivate_workflow` | Take a live workflow to `paused` |
| `delete_workflow` | Delete and confirm gone |
| `list_views` | An object's or list's views |
| `get_view` | One view in full: columns (slugs resolved), sorts, stored filter blocks |
| `create_view` | Create a table or kanban view, with columns and filters in the same call. Kanban groups by a status attribute (Deal stage by default on deals) |
| `add_view_column` | Append a column; multi-hop paths read through a linked record |
| `set_view_filters` | Replace a view's filters (full replace; empty array clears). Kinds: actor, select, status (stage "is any of"), generic |
| `set_kanban_columns` | Choose which stage columns a kanban board shows (board settings toggle, not a filter) |
| `list_dashboards` | The workspace's report dashboards |
| `get_dashboard` | One dashboard's cells in order, with each report's type, source, grouping and filter |
| `preview_report` | **Read-only.** Compile a report from a spec, run Attio's own preview, and recount it independently through the public API. Needs a public API key for the workspace |
| `create_dashboard` | Build dashboards of reports from a spec. **Dry run by default**; `live: true` saves only reports whose preview matched the recount, then reads every write back. Create-only, ledgered, resumable |
| `delete_view` | Delete a view and confirm it is gone |
| `list_lists` | Every list in the workspace — **no API key needed**. Lists are absent from `list_objects` |
| `create_list` | Create a list. The one tool here that needs an **API key**: there is no internal create route |
| `delete_list` | Delete a list and everything in it. Verifies it is gone. Refuses objects |
| `add_select_options` | **Add** options to a select or status attribute, with colours. Needs an **API key**: creation is public-API only |
| `list_select_options` | A select **or status** attribute's option ids, titles, colours and order — **no API key needed** |
| `set_select_options` | Set option colours and/or order, for select and status alike. The public API can do neither |
| `list_layouts` | An object's record-page and Quick Add layouts |
| `get_layout` | A record page as a readable tree, attribute uuids resolved to slugs |
| `edit_layout` | Add sections, add fields, remove elements. Read-modify-write, supports `dry_run` |
| `set_layout` | Escape hatch: replace a layout's whole element tree |

There is no "organize blocks" endpoint. Laying out a canvas means giving each block distinct `{x,y}` via `add_block` or `update_block`, otherwise they stack on top of each other. The editor grid runs roughly `x: 160 / 430 / 700` by depth.

### Safety, enforced in code

- **No publish/activate tool exists.** Nothing here can make a workflow go live. As of 2026-08-24 the publish request shape *is* known and documented in the reference — its absence here is a deliberate decision, not a missing capability. Do not add it without asking.
- **Live workflows are safe to edit.** Every write targets the DRAFT version, while the running automation uses the ACTIVE version, so an edit never changes what is currently firing. Each write says so in its response.
- **Deleting a live workflow requires `confirm_delete_live: true`.**
- **Non-JSON `200` responses throw**, so Attio's SPA HTML fallback can't be mistaken for success.
- Attio's empty `400` is translated into a message naming the four real causes; an expired cookie is detected explicitly.

---

## Gotchas worth knowing before you start

These cost the most time during reverse-engineering. Full detail in the reference.

- **`Origin: https://app.attio.com` is required on every non-GET request.** Without it you get `403`, which reads like a permissions problem. Browsers set it invisibly; your client must send it.
- **`is_modern: true` is required when creating a workflow.** Without it no draft version is provisioned and you can't add anything.
- **`PUT` on an existing block returns `409`.** It's create-only. Use `set_block_config`, or `PATCH` the block.
- **Config keys differ per block and aren't guessable.** `on-record-created` uses `object`; `find-records` uses `entity` plus a required `limit`. There's no schema endpoint — add the block once in the UI and read it back.
- **Slugs don't match UI labels.** `If` → `branch`, `Filter` → `guard`, `Create or update record` → `assert-record`. Full catalog in reference §6.
- **`400` responses have an empty body.** No validation detail at all. Work through the troubleshooting table in reference §9.
- **Legacy snapshots are the only place Attio serves a block schema.** Each snapshot node carries real `inputs` and `outputs` slugs, captured in `legacy-block-schemas.json`. The catch: the legacy and modern engines do not always agree on names (legacy `record` is modern `entity_instance`), so it is authoritative for legacy and a strong hint for modern.
- **Nothing tells you what a step outputs.** There is no schema endpoint, so `list_block_outputs` ships a catalog harvested from real workflows. It is observational: a missing field means "not observed", not "invalid".
- **Select option ids are on the internal API** at `.../attribute-definitions/{attr}/select-options` — use `list_select_options`, no API key needed. Its envelope is `{values:[…]}`, plural, which is why an earlier probe concluded the route did not exist.
- **Status attributes are a second namespace.** They report type `pipeline`, live at `.../attribute-definitions/{attr}/pipeline-stages`, use `pipeline_stage_id`, and take `block_*` colours rather than `pastel_*`. Asking `select-options` for them returns a 400 that reads like a refusal but is really a wrong route. Both tools handle the switch for you.
- **The colour palette is twelve names**, the same twelve for both namespaces: red, orange, yellow, green, light-green, teal, blue, purple, violet, brown, magenta, grey. Pass a bare name and the right prefix is applied.
- **Adding an option is a two-API operation**, and `add_select_options` does both halves for you: it creates on the public API (which silently ignores any `color` you send; Attio assigns a random colour instead), then sets the colour on the internal one. It needs an API key for that reason; recolouring what already exists does not.
- **Kanban views group by a STATUS attribute, on every object.** `create_view` with `type: "kanban"` works on deals, people, companies, custom objects and lists. Deal stage is itself a status attribute, so deals default to `stage` and accept any other status attribute; everywhere else `group_by` is required, and an object with no status attribute is refused until one exists. Attio itself accepts a board grouped by a select attribute (HTTP 200), so the status-only rule is enforced by the tool. Card aggregations (count/sum) are not set: `PUT` drops them and only a count shape has been captured.
- **Workflow builds have a reference library.** `workflow_guide` serves Erik Wood's block references and recipes, each tagged with how well it was tested (`effect-verified` down to `documented`). `list_blocks`, `describe_app_block` and `list_block_outputs` now include that reference too, and the server sends its build rules to the client on connect. Rebuild the data with `node tools/build-workflow-context.js <toolkit>/attio`. See [docs/workflow-context.md](docs/workflow-context.md).
- **Reports are spec-driven and checked twice.** `preview_report` / `create_dashboard` take a JSON spec (see [docs/reports.md](docs/reports.md)). Every report is previewed with Attio's read-only dataset call AND recounted from raw records through the public API; `create_dashboard` saves only what matched. It never edits or deletes, and writes only to IDs it minted. Report tools need a **public API key** for the target workspace as well as the cookie: save it to `~/.attio-apikey-<workspace_slug>`. Ported from Erik Wood's `build_dashboard.py`.
- **Limiting a board to some stages is a column toggle, not a filter.** A Deal stage filter hides cards but every stage column still renders. Use `set_kanban_columns` (or `visible_stages` on `create_view`), which writes the board's per-stage `kanban-stage-characteristic` records.

---

## Starting on a new account

Configs reference objects, attributes and options by uuid, never by name, so the first thing to do in a workspace you have not built in is resolve them:

```
preflight()                                              # scrape + cache everything
resolve(object: "deals", attribute: "stage", option: "Contacted")
```

`resolve` hands back `object_node`, `attribute_node` and `value_node`, which drop straight into a config, plus `variable_path_segment` for reading that attribute inside a variable path. You should never be typing a uuid by hand.

### Two credentials, two jobs

| Credential | Used for |
|---|---|
| Session cookie (`~/.attio-session`) | Workflows, objects, attributes |
| API key (`~/.attio-apikey`) | Workspace **members**, **creating** a list (`create_list`), and **adding** select/status options (`add_select_options`). Nothing else — option ids and list *discovery* no longer need it, see `list_select_options` and `list_lists`. |

Option ids and members are only on Attio's public v2 API, so without a key `preflight` still returns objects and attributes but skips those, and it says so in `warnings`. Any condition on a status or select field needs them.

Both APIs use the **same uuids** (verified): the public API's `object_id`/`attribute_id` are the internal API's `entity_definition_id`/`attribute_definition_id`.

Per-profile keys go in `~/.attio-apikey-<profile>`, mirroring the cookie profiles.

---

## Wiring one step into the next

The thing most people hit first: a step produces something, and the next step needs it. That is a `variable` node, and you do **not** have to hand-write it.

```
list_available_variables(workflow_id, block_id)   # block_id = the step that CONSUMES
```

It walks every upstream block that can reach yours and returns, for each output field, a ready `node` with `block_instance_id`, `outcome`, `operations` and a generated matcher id already filled in. Paste that `node` into the consuming block's config and write it with `set_block_config`.

Add `expand_attributes_for: "companies"` to also expand record-valued fields into one path per attribute, so you get `entity_instance.name` rather than a raw UUID hop.

Connect the blocks first. A block with nothing upstream can reference nothing.

---

## Testing

```bash
node test-protocol.js                                   # MCP handshake only, no credentials needed
node test-reports.js                                    # report builder, offline, no credentials
node test-workflow-context.js                           # workflow_guide + block references, offline
node test-formulas.js                                   # formula syntax compile/render, offline
node test-runs.js                                       # run history paging, outputs, retry, offline
ATTIO_WORKSPACE_SLUG=your-workspace node test-full.js   # full suite against a real workspace
```

`test-full.js` discovers its own fixtures, so it runs in any workspace unedited. To clone a specific workflow instead of an auto-picked one:

```bash
CLONE_SOURCE_WORKFLOW_ID=<uuid> ATTIO_WORKSPACE_SLUG=your-workspace node test-full.js
```

146 checks. It creates only workflows and views prefixed `ZZ-SELFTEST-`, never publishes, and verifies at the end that it left none behind.

### App-block corpus (Neon Deer apps)

For Neon Deer's own apps, block schemas are read from the app source rather than harvested, so they cover blocks nobody has configured yet. `app-blocks.json` ships ready to use and is maintained by Neon Deer Data Labs.

Mapped today: Advanced Workflow Automations (`workflow-utilities`, 36 blocks), Email Notifications (`email-notifications`, 1 block), and Duplicate Detection & Merging (`check-for-duplicates`, guidance only). See [docs/neon-deer-apps.md](docs/neon-deer-apps.md). When an app ships, `app-blocks.json` is updated here. Run the suite against a workspace with the app installed: it fails if the live install exposes a block the corpus lacks, or vice versa.

### Harvesters

Attio serves no schema endpoint for blocks, so the repo carries three corpora built by reading configs Attio's own UI wrote. Re-run any of them to widen coverage.

```bash
node harvest-variables.js     > block-outputs.json          # what each block EMITS (variable references)
node harvest-config-keys.js   > config-keys.json            # what each block ACCEPTS (top-level config keys)
node harvest-legacy-schemas.js > legacy-block-schemas.json   # legacy engine only, from snapshot nodes
```

`config-keys.json` is the newest and the most direct answer to "what is this block's input called". Current corpus (2026-10-20): 191 workflows, 939 blocks, 118 signatures, including 243 app-block instances whose config keys have no other source. App **config keys** are portable; their `app_id` and connection ids are installation-specific and deliberately not recorded. It is **modern-engine only** — legacy blocks come back through the snapshot path in a different shape and harvest as "unknown".

---

## Security

- **Never commit your session cookie.** It grants full access to your Attio account as you. It belongs in `~/.attio-session` (mode `600`), outside this repo. `.gitignore` covers the obvious filenames, but the real safeguard is keeping it out of the working tree.
- The credential is **per-user and unscopeable**. Everything done through it carries your permissions and appears as you in `created_by`.
- mitmproxy `.flows` captures and `.har` exports contain live cookies. Both are gitignored; don't share them.
