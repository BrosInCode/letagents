#!/bin/sh
# Builds this branch's desktop main (tsc) and renderer (vite) into ./.build, a folder that
# mirrors the repo layout with links to the repo's node_modules. Nothing else is written.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
OUT="$HERE/.build"
rm -rf "$OUT"
mkdir -p "$OUT/apps/desktop"
ln -s "$REPO/shared" "$OUT/shared"
ln -s "$REPO/node_modules" "$OUT/node_modules"
ln -s "$REPO/brand" "$OUT/brand"
ln -s "$REPO/apps/desktop/node_modules" "$OUT/apps/desktop/node_modules"
cp "$REPO/apps/desktop/package.json" "$OUT/apps/desktop/package.json"
cp "$REPO/package.json" "$OUT/package.json"
cd "$REPO/apps/desktop"
node node_modules/typescript/bin/tsc -p tsconfig.electron.json --outDir "$OUT/apps/desktop/dist-electron"
node node_modules/vite/bin/vite.js build --logLevel warn --outDir "$OUT/apps/desktop/dist-renderer" --emptyOutDir
echo "built into $OUT"
