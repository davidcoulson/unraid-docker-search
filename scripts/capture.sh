#!/usr/bin/env bash
# Capture the Docker page data from an Unraid server, read-only, for building the test fixture.
#
#   scripts/capture.sh root@tower /tmp/capture
#
# Writes rows.raw (DockerContainers.php output), data.json (this plugin's data.php run from stdin,
# nothing is copied to the server), folders.json (folder.view2 config, if present).
# The output contains your container names, IPs and paths: scrub it with make-fixture.py
# before committing anything.
set -euo pipefail

host=${1:?usage: capture.sh user@host outdir}
out=${2:?usage: capture.sh user@host outdir}
here=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$out"

ssh -o BatchMode=yes "$host" 'cd /usr/local/emhttp && php plugins/dynamix.docker.manager/include/DockerContainers.php' > "$out/rows.raw"
ssh -o BatchMode=yes "$host" 'cd /usr/local/emhttp && php' < "$here/src/docker.search/include/data.php" > "$out/data.json"
ssh -o BatchMode=yes "$host" 'cat /boot/config/plugins/folder.view2/docker.json 2>/dev/null || echo "{}"' > "$out/folders.json"

echo "captured to $out:"
ls -l "$out"
