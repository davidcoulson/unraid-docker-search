#!/usr/bin/env bash
# Copy the webGUI stylesheets, fonts and container icons from an Unraid server into
# fixture/vendor/ (gitignored) so the fixture looks like the real page. Read-only on the server.
#
#   scripts/fetch-vendor.sh root@tower
#
# These files are Lime Technology's (GPL-2.0) and plugin authors'; they stay local.
set -euo pipefail

host=${1:?usage: fetch-vendor.sh user@host}
here=$(cd "$(dirname "$0")/.." && pwd)
dest="$here/fixture/vendor"
mkdir -p "$dest"

ssh -o BatchMode=yes "$host" 'cd /usr/local/emhttp && tar -cf - \
  webGui/styles \
  plugins/dynamix.docker.manager/sheets/DockerContainers.css \
  plugins/dynamix.docker.manager/images \
  $(ls -d plugins/folder.view2/styles 2>/dev/null) \
  $(ls -d state/plugins/dynamix.docker.manager/images 2>/dev/null)' | tar -xf - -C "$dest"

echo "vendor files in $dest"
du -sh "$dest"
