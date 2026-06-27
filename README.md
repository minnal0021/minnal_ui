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
| **Schema** | Create, view, amend, and delete document stores and KV stores; manage field indices and embedding fields. |
| **Documents** | Browse, get, put, and delete documents; range scans and prefix scans with pagination. |
| **Query** | Run predicate queries against field indices, plus semantic search and filtered semantic search. |
| **Admin** | Server health and uptime, storage stats, ops metrics, WAL/LSM/value-log inspection, GC and compaction triggers, and vector index queue management. |

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

## Project layout

```
minnal_ui/
├── index.html      # Single-page app shell (tabs, modal, toasts)
├── css/style.css   # Styles
├── js/
│   ├── api.js      # Thin async wrapper over the minnal REST API
│   └── app.js      # UI logic, rendering, event handling
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
