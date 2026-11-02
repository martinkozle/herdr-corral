#!/bin/sh
# Copies the repo's mods into Herdr and checks them.
# Herdr's hot reload doesn't follow a symlinked mod folder (herdr-app 0.1.12), so a real copy is needed.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
for m in "$root"/mods/*/; do
  name=$(basename "$m")
  [ -L "$dest/$name" ] && rm "$dest/$name"
  rsync -a --delete --exclude RECIPE.md --exclude preview.png --exclude gpui-kit.d.ts "$m" "$dest/$name/"
  herdr-app check "$dest/$name"
done
