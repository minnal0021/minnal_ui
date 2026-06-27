#!/usr/bin/env python3
"""
Minnal UI — static file server + API proxy.

Serves the HTML/CSS/JS from its own directory and transparently proxies
any request whose path starts with /stores or /admin to the backend API.
No third-party packages needed — stdlib only.

Config (environment variables):
  API_UPSTREAM   backend base URL   (default: http://localhost:8080)
  PORT           port to listen on  (default: 3000)
"""

import http.server
import urllib.request
import urllib.error
import os
import sys

# ── Config ────────────────────────────────────────────────────────────────────

API_UPSTREAM = os.environ.get("API_UPSTREAM", "http://localhost:8080").rstrip("/")
PORT         = int(os.environ.get("PORT", "3000"))

# Paths forwarded to the backend — everything else is served as a static file.
API_PREFIXES = ("/kv-stores", "/stores", "/admin")

# ── Request handler ───────────────────────────────────────────────────────────

class Handler(http.server.SimpleHTTPRequestHandler):

    def _is_api(self):
        return any(self.path.startswith(p) for p in API_PREFIXES)

    # Route each method: API paths → proxy, everything else → static file
    def do_GET(self):
        if self._is_api(): self._proxy()
        else: super().do_GET()

    def do_HEAD(self):
        if self._is_api(): self._proxy()
        else: super().do_HEAD()

    def do_POST(self):
        if self._is_api(): self._proxy()
        else: self.send_error(405)

    def do_PUT(self):
        if self._is_api(): self._proxy()
        else: self.send_error(405)

    def do_DELETE(self):
        if self._is_api(): self._proxy()
        else: self.send_error(405)

    def do_PATCH(self):
        if self._is_api(): self._proxy()
        else: self.send_error(405)

    # ── Proxy ─────────────────────────────────────────────────────────────────

    def _proxy(self):
        url    = API_UPSTREAM + self.path
        length = int(self.headers.get("Content-Length", 0))
        body   = self.rfile.read(length) if length else None

        req = urllib.request.Request(url, data=body, method=self.command)
        if ct := self.headers.get("Content-Type"):
            req.add_header("Content-Type", ct)

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                self._forward(resp.status, resp.headers, resp.read())
        except urllib.error.HTTPError as e:
            self._forward(e.code, e.headers, e.read())
        except Exception as e:
            msg = f'{{"error": "proxy error: {e}"}}'.encode()
            self._forward(502, {}, msg)

    def _forward(self, status, headers, body):
        self.send_response(status)
        skip = {"transfer-encoding", "connection", "keep-alive"}
        for k, v in headers.items():
            if k.lower() not in skip:
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ── Logging ───────────────────────────────────────────────────────────────

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()}  {fmt % args}", flush=True)

# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Serve files relative to this script's directory
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    with http.server.HTTPServer(("0.0.0.0", PORT), Handler) as httpd:
        print("─────────────────────────────────────────")
        print("  Minnal UI")
        print(f"  Listening on  http://0.0.0.0:{PORT}")
        print(f"  API upstream  {API_UPSTREAM}")
        print("─────────────────────────────────────────")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
            sys.exit(0)
