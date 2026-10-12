#!/usr/bin/env python3
"""Serve the fixture with the same URL paths as the real webGUI.

    python3 -I scripts/serve.py [port]       then open http://localhost:8765/

  /plugins/docker.search/include/data.php  -> fixture/data.json
  /plugins/docker.search/...               -> src/docker.search/...
  /fixture/...                             -> fixture/...
  anything else                            -> fixture/vendor/... (from scripts/fetch-vendor.sh)
"""
import http.server
import os
import posixpath
import sys
import urllib.parse

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = posixpath.normpath(urllib.parse.unquote(urllib.parse.urlsplit(path).path))
        if path in ('/', '/.'):
            return os.path.join(ROOT, 'fixture', 'index.html')
        if path == '/plugins/docker.search/include/data.php':
            return os.path.join(ROOT, 'fixture', 'data.json')
        if path.startswith('/plugins/docker.search/'):
            rel = path[len('/plugins/docker.search/'):]
            return os.path.join(ROOT, 'src', 'docker.search', rel)
        if path.startswith('/fixture/'):
            return os.path.join(ROOT, path.lstrip('/'))
        return os.path.join(ROOT, 'fixture', 'vendor', path.lstrip('/'))

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def guess_type(self, path):
        if path.endswith('.json'):
            return 'application/json'
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        if '404' in (fmt % args):
            sys.stderr.write(fmt % args + '\n')


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
