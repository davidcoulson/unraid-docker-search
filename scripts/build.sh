#!/usr/bin/env bash
# Build archive/docker.search-VERSION.txz from src/docker.search and stamp the version
# and MD5 into docker.search.plg.
#
#   scripts/build.sh            # version = today's date, YYYY.MM.DD
#   scripts/build.sh 2026.10.12a
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
name=docker.search
version=${1:-$(date +%Y.%m.%d)}
pkg="$here/archive/$name-$version-noarch-1.txz"

cd "$here"
node --test test/*.test.js >/dev/null

find "src/$name" -type d -exec chmod 755 {} +
find "src/$name" -type f -exec chmod 644 {} +
mkdir -p archive
rm -f "$pkg"

# bsdtar (macOS) and GNU tar spell the "owned by root, no extras" options differently.
if tar --version 2>/dev/null | grep -q bsdtar; then
  COPYFILE_DISABLE=1 tar -C src --no-mac-metadata --no-xattrs --no-fflags \
    --uid 0 --gid 0 --uname root --gname root \
    -s ",^$name,usr/local/emhttp/plugins/$name," \
    -cJf "$pkg" "$name"
else
  tar -C src --owner=0 --group=0 --sort=name \
    --transform "s,^$name,usr/local/emhttp/plugins/$name," \
    -cJf "$pkg" "$name"
fi

if command -v md5sum >/dev/null; then md5=$(md5sum "$pkg" | cut -d' ' -f1); else md5=$(md5 -q "$pkg"); fi
sed -i.bak -E \
  -e "s|(<!ENTITY version +\")[^\"]*\"|\1$version\"|" \
  -e "s|(<!ENTITY md5 +\")[^\"]*\"|\1$md5\"|" \
  "$name.plg"
rm -f "$name.plg.bak"

echo "built $pkg"
echo "md5 $md5"
tar -tvJf "$pkg"
