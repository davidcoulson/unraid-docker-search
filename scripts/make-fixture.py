#!/usr/bin/env python3
"""Turn a capture from scripts/capture.sh into the committed, scrubbed test fixture.

    python3 -I scripts/make-fixture.py CAPTURE_DIR [--renames renames.json] [--out fixture]
        [--drop-folder NAME ...] [--drop NAME ...]

--drop-folder leaves out every container in that folder.view2 folder (and the folder itself);
--drop leaves out single containers. Dropped containers vanish from every fixture file.

renames.json (keep it outside the repo) maps private strings to public ones, applied
everywhere, longest first:  {"my-private-app": "sample-app", "/mnt/user/me": "/mnt/user/share1"}

On top of that every capture gets: host paths under /mnt rewritten (pools other than
user/cache become poolN; shares outside a short list of generic names become shareN
with everything below them dropped), private and CGNAT IPv4 addresses mapped into
192.168.0.0/16 / 100.64.0.0/24 (Docker's own 172.16/12 addresses are kept), MAC
addresses replaced, e-mail addresses replaced, Tailscale tooltips emptied, and labels
cut down to a short allowlist (traefik rules and compose paths name hosts and folders).
"""
import argparse
import hashlib
import json
import os
import re
import sys

LABEL_ALLOW = {
    'net.unraid.docker.managed',
    'org.opencontainers.image.title',
    'org.opencontainers.image.source',
    'org.opencontainers.image.version',
    'org.opencontainers.image.licenses',
    'org.opencontainers.image.vendor',
    'com.docker.compose.project',
    'com.docker.compose.service',
}


# Shares whose names (and sub-folders) are generic enough to keep as they are.
SHARE_ALLOW = {'appdata', 'media', 'downloads', 'downloads-nzb', 'isos', 'system', 'domains'}
POOL_ALLOW = {'user', 'cache'}


def scrub_mnt_paths(s):
    """Rewrite host paths under /mnt, then replace every private name found there wherever it
    appears as a path segment (container paths often mirror host folders, e.g. /data/<share>)."""
    private = {}  # original segment -> replacement

    def label(seg, kind):
        if seg not in private:
            n = sum(1 for v in private.values() if v.startswith(kind)) + 1
            private[seg] = '%s%d' % (kind, n)
        return private[seg]

    def one(m):
        pool, share, rest = m.group(1), m.group(2), m.group(3) or ''
        if pool not in POOL_ALLOW:
            pool = label(pool, 'pool')
        if share is None:
            return '/mnt/' + pool
        if share not in SHARE_ALLOW:
            for seg in rest.split('/'):
                if seg:
                    label(seg, 'dir')
            return '/mnt/%s/%s' % (pool, label(share, 'share'))
        return '/mnt/%s/%s%s' % (pool, share, rest)
    # A path ends at whitespace, a quote, markup or an arrow icon.
    s = re.sub(r"/mnt/([^/\s'\"<>]+)(?:/([^/\s'\"<>]+))?((?:/[^/\s'\"<>]*)*)", one, s)
    for seg in sorted(private, key=len, reverse=True):
        s = re.sub(r"(?<=/)%s(?=[/\s'\"<>]|$)" % re.escape(seg), private[seg], s)
    return s


def scrub_text(s, renames):
    for k in sorted(renames, key=len, reverse=True):
        s = s.replace(k, renames[k])
    s = scrub_mnt_paths(s)

    def ip(m):
        a, b, c, d = (int(x) for x in m.groups())
        if a == 10:
            return '192.168.%d.%d' % (c, d)
        if a == 192 and b == 168:
            return m.group(0)
        if a == 100 and 64 <= b <= 127:
            return '100.64.0.%d' % d
        return m.group(0)
    s = re.sub(r'(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])', ip, s)

    def mac(m):
        h = hashlib.sha1(m.group(0).lower().encode()).hexdigest()
        return '02:42:%s:%s:%s:%s' % (h[0:2], h[2:4], h[4:6], h[6:8])
    s = re.sub(r'\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b', mac, s)
    s = re.sub(r'[\w.+-]+@[\w-]+(?:\.[\w-]+)+', 'maintainer@example.com', s)
    s = re.sub(r'data-tstitle="[^"]*"', 'data-tstitle="Tailscale"', s)
    s = re.sub(r'\bf[cd][0-9a-f]{2}:[0-9a-f:]+', 'fd00::1', s, flags=re.I)
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('capture')
    ap.add_argument('--renames')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'fixture'))
    ap.add_argument('--drop-folder', action='append', default=[], metavar='NAME')
    ap.add_argument('--drop', action='append', default=[], metavar='NAME')
    a = ap.parse_args()

    renames = {}
    if a.renames:
        with open(a.renames, encoding='utf-8') as f:
            renames = json.load(f)

    with open(os.path.join(a.capture, 'rows.raw'), encoding='utf-8') as f:
        parts = f.read().split('\0')
    rows, pushes = parts[0], parts[1] if len(parts) > 1 else ''

    with open(os.path.join(a.capture, 'data.json'), encoding='utf-8') as f:
        data = json.load(f)
    for c in data.get('containers', []):
        c['labels'] = {k: v for k, v in (c.get('labels') or {}).items() if k in LABEL_ALLOW}

    folders = {}
    fpath = os.path.join(a.capture, 'folders.json')
    if os.path.exists(fpath):
        with open(fpath, encoding='utf-8') as f:
            folders = json.load(f) or {}
    drop = set(a.drop)
    for fo in folders.values():
        if fo.get('name') in a.drop_folder:
            drop.update(fo.get('containers', []))
    if drop:
        def keep_row(chunk):
            m = re.search(r"<span class='appname[^']*'>(?:<a[^>]*>)?([^<]+)", chunk)
            return not (m and m.group(1).strip() in drop)
        rows = ''.join(c for c in re.split(r"(?=<tr class=)", rows) if keep_row(c))
        pushes = ''.join(c for c in re.split(r"(?=docker\.push\()", pushes)
                         if not re.match(r"docker\.push\(\{name:'(%s)'" % '|'.join(map(re.escape, drop)), c))
        data['containers'] = [c for c in data.get('containers', []) if c.get('name') not in drop]

    # Only what the fixture's folder stub needs.
    slim = {}
    for fid, fo in folders.items():
        if fo.get('name') in a.drop_folder:
            continue
        slim[fid] = {
            'name': fo.get('name', ''),
            'containers': [c for c in fo.get('containers', []) if c not in drop],
            'settings': {k: fo.get('settings', {}).get(k) for k in ('preview', 'expand_tab')},
        }

    os.makedirs(a.out, exist_ok=True)
    out = {
        'rows.html': rows.strip() + '\n',
        'docker-push.js': pushes.replace(';docker.push', ';\ndocker.push').strip() + '\n',
        'data.json': json.dumps(data, indent=1, ensure_ascii=False) + '\n',
        'folders.json': json.dumps(slim, indent=1, ensure_ascii=False) + '\n',
    }
    for name, text in out.items():
        with open(os.path.join(a.out, name), 'w', encoding='utf-8') as f:
            f.write(scrub_text(text, renames))
        print('wrote', os.path.join(a.out, name), file=sys.stderr)


if __name__ == '__main__':
    main()
