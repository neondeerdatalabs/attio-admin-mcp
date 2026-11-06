"""
mitmproxy addon: capture Attio internal-API JSON responses while you click
around the workflow editor, so we can find where block OUTPUT schemas come from.

Deliberately stores ONLY the request path and the response body. No request
headers are recorded, so no session cookie is ever written to disk.

Run:  mitmdump -s tools/capture_schema.py -p 8080
Out:  tools/capture/<sanitized-path>.json  (+ index.jsonl)
"""
import json, os, re, hashlib
from mitmproxy import http

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "capture")
os.makedirs(OUT, exist_ok=True)
INDEX = os.path.join(OUT, "index.jsonl")

# Field names we already know are real block outputs. If any response contains
# one, it is almost certainly the schema source we are hunting.
NEEDLES = ["match_count", "response_body", "selected_user", "previous_value",
           "entity_instance", "created_task", "answer_q1"]

count = 0
hits = 0
js_seen = 0
JSDIR = os.path.join(OUT, "js")
os.makedirs(JSDIR, exist_ok=True)


def _scan_js(flow, path):
    """Search JS bundles for known block-output field names and keep any that match."""
    global js_seen
    try:
        body = flow.response.get_text()
    except Exception:
        return
    if not body:
        return
    js_seen += 1
    found = [n for n in NEEDLES if n in body]
    if found:
        fn = os.path.join(JSDIR, os.path.basename(path))
        with open(fn, "w") as f:
            f.write(body)
        print(f"[JS HIT] {os.path.basename(path)}  -> {found}", flush=True)
    if js_seen % 25 == 0:
        print(f"[js] scanned {js_seen}", flush=True)


def response(flow: http.HTTPFlow) -> None:
    global count, hits
    if "app.attio.com" not in flow.request.pretty_host:
        return
    path = flow.request.path.split("?")[0]
    if "/api/" not in path:
        return
    ctype = flow.response.headers.get("content-type", "")
    if "javascript" in ctype or path.endswith(".js"):
        _scan_js(flow, path)
        return
    if "json" not in ctype:
        return
    try:
        body = flow.response.get_text()
    except Exception:
        return
    if not body:
        return

    count += 1
    found = [n for n in NEEDLES if n in body]
    if found:
        hits += 1

    short = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "{id}", path)
    short = short.replace("/api/common/workspaces/", "").strip("/")
    name = re.sub(r"[^A-Za-z0-9._-]", "_", short)[:120]
    if not name:
        name = "root"
    # keep every distinct response, even for a repeated path
    digest = hashlib.sha1(body.encode("utf-8", "replace")).hexdigest()[:8]
    fn = os.path.join(OUT, f"{name}.{digest}.json")
    if not os.path.exists(fn):
        with open(fn, "w") as f:
            f.write(body)

    with open(INDEX, "a") as f:
        f.write(json.dumps({
            "method": flow.request.method,
            "path": short,
            "bytes": len(body),
            "needles": found,
            "file": os.path.basename(fn),
        }) + "\n")

    mark = "  <== MATCH: " + ",".join(found) if found else ""
    print(f"[{count:4d}] {flow.request.method:6s} {short[:80]}{mark}", flush=True)
