# Minnal UI

A lightweight, dependency-free web console for [**minnal**](https://github.com/minnal0021/minnal) (மின்னல் — *lightning* in Tamil), the embedded document database written in Rust. It gives you a browser-based interface to manage stores, browse and edit documents, run predicate and semantic queries, and inspect server diagnostics — all backed by minnal's REST API.

> The UI is pure static HTML/CSS/JS served by a tiny Python stdlib server that also acts as a reverse proxy to the minnal backend. **No npm, no build step, no third-party packages.**

---

## Table of Contents

- [What it does](#what-it-does)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [How it connects to minnal](#how-it-connects-to-minnal)
- [Running with the start script](#running-with-the-start-script)
- [Running with Docker](#running-with-docker)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [The minnal server](#the-minnal-server)
- [Troubleshooting](#troubleshooting)

---

## What it does

The interface is organised into four tabs, each mapping onto a part of the minnal REST API:

| Tab | Purpose |
|---|---|
| **Schema** | Create, view, amend, and delete document stores and KV stores; manage field indices and embedding fields; view a semantic-search store's vector-index settings and change its search and maintenance settings (see [Vector-index settings](#vector-index-settings)). |
| **Documents** | Browse, get, put, and delete documents; range scans and prefix scans with pagination. |
| **Query** | Run predicate queries against field indices, plus semantic search and filtered semantic search. |
| **Admin** | Five sub-tabs. **Storage**: server health, storage stats, WAL/LSM/value-log inspection, schema import. **Ops Metrics**: engine-wide and per-store counters, including the field-index write buffer. **Field Indexes**: builds, health and repair, waste, blob and row-map stats, reindex and drop. **Vector Indexes**: every vector store, and one store in detail, including whether a partition rebuild would help (see [Vector Indexes](#vector-indexes)). **System Maintenance**: the server-wide actions — value-log GC, WAL GC, LSM compaction, field index checkpoint and clearing the query-embedding cache — each with what it does; they cover every namespace, whatever the sidebar selects. |

**The sidebar picks the store everywhere.** The store selected in the sidebar is
the one every per-store section shows, including in Admin; nothing in Admin has a
store picker of its own. With no store selected (clear it with the × on the
selected entry), Admin shows its all-stores views. With one selected, Field Indexes
and Vector Indexes show only that store, or say it has no index of that kind. Under **System** (collapsed
by default) the sidebar also lists the engine's own namespaces: the embedding
queue, the query-embedding cache and the partition history. A system namespace
opens in Admin only; Schema, Documents and Query do not apply to it, and the
Field Indexes sub-tab and the System Maintenance → Field Index Checkpoint button
are greyed out because system namespaces have no field indexes.

---

## Prerequisites

- **Python 3** (3.7+; uses the standard library only — nothing to install).
- A running **minnal server** to connect to — see [The minnal server](#the-minnal-server) below. By default the UI expects it at `http://localhost:8080`.
- *(Optional)* **Docker**, if you prefer to run the UI in a container.

---

## Quick start

From this directory (`minnal_ui/`):

```bash
# 1. Make sure the minnal server is running (default: http://localhost:8080)
#    See "The minnal server" section below.

# 2. Start the UI
./start.sh

# 3. Open the UI in your browser
#    http://localhost:3000
```

That's it. The console loads, and you can either use the proxied connection or type a different API URL into the **API URL** box at the top and click **Connect**.

You can also run the server directly without the wrapper script:

```bash
python3 server.py
```

---

## How it connects to minnal

There are **two** ways the UI talks to the backend, and it's worth understanding the difference:

1. **Via the Python proxy (recommended).** Any request whose path starts with `/stores`, `/kv-stores`, or `/admin` is transparently forwarded by `server.py` to the upstream minnal API (`API_UPSTREAM`, default `http://localhost:8080`). Everything else is served as a static file. This avoids browser CORS issues entirely because the browser only ever talks to the UI's own origin.

2. **Direct from the browser.** The **API URL** field at the top of the page sets the base URL that the browser's `fetch` calls use directly. This is handy for pointing at a remote minnal instance, but the remote server must permit cross-origin requests.

```
Browser ──▶ Minnal UI (server.py, :3000) ──▶ minnal REST API (:8080)
              static files + /stores,/kv-stores,/admin proxy
```

---

## Running with the start script

`start.sh` is a thin wrapper that sets the environment and launches `server.py`:

```bash
# Defaults: API_UPSTREAM=http://localhost:8080, PORT=3000
./start.sh

# Point at a different backend and/or port
API_UPSTREAM=http://localhost:9090 PORT=8000 ./start.sh
```

---

## Running with Docker

`build.sh` builds the image and runs it with `--network host` so the container can reach a minnal server on the host's `localhost:8080`:

```bash
./build.sh
```

Or build and run manually:

```bash
docker build -t minnal-ui .

# UI on :3000, backend reachable at API_UPSTREAM
docker run -p 3000:3000 -e API_UPSTREAM=http://my-api-host:8080 minnal-ui
```

When the minnal API runs as another container on the same Docker network named `minnal_api`, the default `API_UPSTREAM=http://minnal_api:8080` (set in the `Dockerfile`) just works.

Useful container commands:

```bash
docker logs -f minnal-ui     # follow logs
docker rm -f minnal-ui       # stop and remove
```

---

## Configuration

Both `server.py` and the scripts are configured through environment variables:

| Variable | Default | Description |
|---|---|---|
| `API_UPSTREAM` | `http://localhost:8080` | Base URL of the minnal REST API the proxy forwards to. |
| `PORT` | `3000` | Port the UI server listens on. |

For Docker, `build.sh` additionally honours `IMAGE_NAME` and `CONTAINER_NAME`.

---

## Vector-index settings

A store with semantic search has a `vector_index` block in its schema. It holds
four groups of settings, all shown under **Schema → Vector Index Settings**:

| Group | Settings | Can change? |
|---|---|---|
| Embedding and chunking | `embedding_model`, `embedding_dim`, `chunking.window_size`, `chunking.sliding_size` | Set when semantic search is enabled, then fixed |
| Quantisation | `pass1_bits`, `pass2_bits`, `pass2_centre`, `rotation_seed` | Read-only; `rotation_seed` can be given at enable time |
| Search defaults | `max_probes` (postings, or clusters, each search reads: its nearest this many), `min_probes` (a floor for overrides), `first_pass_top_k`, `top_k` | Any time; each search can also override them |
| Partition maintenance | `target_posting_size`, `reassign_range`, `merge_ratio`, `skip_uncertain_moves`, `split_*` | Any time; later splits and merges use them |

**Edit Search & Maintenance** changes the last two groups (it sends only the
values you changed). When you create a store with semantic search, or add a
vector index to an existing store, the form also takes the settings: pick the
model (from the server's allowed models), and leave any other field empty to use
the server's default. The server saves the filled-in values, so the schema always
shows what is in force. The model, dimension and chunking cannot be changed
later; to change them, drop the vector index and add it again.

**Export Schema** downloads the store's full schema, `vector_index` included, and
importing that file recreates the store with the same settings.

## Vector Indexes

Under **Admin → Vector Indexes**. With no store selected in the sidebar,
the tab lists every vector store (indexing progress, queue backlog, corrupt
entries skipped, and the rebuild verdict in a word — hover it for the reason)
with the queue totals and the browser for retried queue entries. **Open →** on a row
(or selecting the store in the sidebar) shows that store; *All vector stores*
goes back.

A store with semantic search keeps its vectors in **postings** (clusters) that
split and merge as data arrives. The store view answers one question above all:
**would rebuilding its partition help, and did the last one?**

- **Overview** — the rebuild verdict in one line, the store's embedding queue,
  indexing progress and corruption counters, its actions (reindex one document or
  all, retry exhausted entries, drop the vector index) and its queue entries.
- **Rebuild decision** — a plain-language verdict and the evidence behind it,
  plus the two actions:
  - *Recall check*: searches sampled real queries (from the query-embedding
    cache, so no embedding calls) twice, reading the store's `max_probes`
    nearest postings and reading every posting, and reports how much of the full read the normal
    search found (overlap@10 … @100).
  - *Rebuild*: re-fits the postings on everything stored. The verdict tells you
    to check again with the same seed afterwards, and compares the two.
  A store with no more postings than `max_probes` is read in full by every
  search and needs no rebuild; the verdict says so without a check.
- **Partition** — postings, entries, chunks, size percentiles against the split
  and merge limits (with a histogram), maintenance counters, corruption counters
  and the last rebuild.
- **Code metrics** — centre drift, foreign and zero-centre share, error band and
  the re-encode candidates, with what each means. Drift measures code precision
  and calls for re-embedding (vector reindex-all), never for a rebuild; a rebuild
  raises it.
- **Postings** — every posting, sortable, with its code metrics on request.
- **History** — recall checks and rebuilds as a timeline, with the change in
  overlap@10 between comparable checks (same seed, query source and `max_probes`).
- **Settings** — the store's `vector_index` settings beside the server's
  defaults (differences highlighted), and the server-wide `[semantic_search]`
  values.

Every label has a tooltip. The store view needs a minnal server built from its
`dynamic-rabitq-index` branch (the partition, recall-check, rebuild, history and
settings endpoints).

---

## Project layout

```
minnal_ui/
├── index.html      # Single-page app shell (tabs, modal, toasts)
├── css/style.css   # Styles
├── js/
│   ├── api.js      # Thin async wrapper over the minnal REST API
│   ├── app.js      # UI logic, rendering, event handling
│   ├── vector_ops.js # Admin → Vector Indexes
│   └── vector_settings.js # A store's vector-index settings: Schema tab, create/enable forms, edit
├── img/logo.svg    # மின்னல் logo
├── server.py       # Static file server + /stores,/kv-stores,/admin proxy
├── start.sh        # Run server.py with sensible env defaults
├── build.sh        # Build & run the Docker image (--network host)
└── Dockerfile      # python:3.12-alpine, stdlib only
```

---

## The minnal server

The UI is a front-end for the **minnal** document database. Its full source, architecture, and API reference live in the sibling repository:

- **Repo / docs:** [github.com/minnal0021/minnal](https://github.com/minnal0021/minnal) — see its [`README.md`](https://github.com/minnal0021/minnal/blob/main/README.md) for the complete architecture and REST API reference.

To start the minnal server (run from the minnal workspace root):

```bash
# Development: debug build and run directly
cargo run -p minnal_doc_store_api -- config/sample.toml

# Release (recommended): build optimised binaries, then start
./service/scripts/release.sh
./work/bin/start.sh
```

The server listens on `0.0.0.0:8080` by default (configurable via `[api] listen_addr` in the TOML config). Stop it with `Ctrl-C` (SIGINT) or SIGTERM.

> **Semantic search** additionally requires an external embedding service (default `http://localhost:8001`). Store, document, index, and predicate-query features all work without it — only semantic search endpoints depend on it. See the minnal README's [Semantic Search](https://github.com/minnal0021/minnal/blob/main/README.md#semantic-search) section.

---

## Troubleshooting

- **"Network error" / badge stays `unknown`** — the minnal server isn't reachable. Confirm it's running (`curl http://localhost:8080/admin/storage/health`) and that `API_UPSTREAM` (or the API URL field) points at it.
- **CORS errors in the browser console** — you're connecting *directly* to a remote server instead of through the proxy. Either route through `server.py` (use a path-relative API URL / the proxy) or enable CORS on the backend.
- **`502 proxy error`** — `server.py` reached but could not contact the upstream API; check `API_UPSTREAM` and that minnal is up.
- **Port already in use** — change the UI port with `PORT=8000 ./start.sh`.
```
