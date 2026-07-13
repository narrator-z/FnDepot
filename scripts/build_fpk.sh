#!/usr/bin/env bash
#
# build_fpk.sh — Reproducible FnOS .fpk packer for FnDepot
#
# Usage:
#   scripts/build_fpk.sh <app_dir> <output_dir> [arch]
#
# Rebuilds `{app_name}_{arch}.fpk` from the application source directory.
# The .fpk is a gzip-compressed tar (per FnDepot spec 1.1.1) containing:
#   app.tgz                     tar.gz of the `app/` subtree (app/ prefix stripped)
#   cmd/                        lifecycle scripts
#   config/                     privilege + resource
#   ICON.PNG                    (mandatory, uppercase)
#   ICON_256.PNG                (optional)
#   manifest
#   wizard/                     install/config/uninstall/upgrade definitions
#
# Expected app_dir layout:
#   <app_dir>/ICON.PNG
#   <app_dir>/ICON_256.PNG        (optional)
#   <app_dir>/manifest
#   <app_dir>/app/{docker,ui,config}/...
#   <app_dir>/cmd/...
#   <app_dir>/config/{privilege,resource}
#   <app_dir>/wizard/...
#
set -euo pipefail

APP_DIR="${1:-}"
OUT_DIR="${2:-}"
ARCH="${3:-all}"

if [[ -z "$APP_DIR" || -z "$OUT_DIR" ]]; then
  echo "Usage: $0 <app_dir> <output_dir> [arch]" >&2
  exit 2
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "error: app directory not found: $APP_DIR" >&2
  exit 1
fi

APP_NAME="$(basename "$APP_DIR")"

# --- sanity checks ---------------------------------------------------------
missing=()
[[ -f "$APP_DIR/manifest" ]]   || missing+=("manifest")
[[ -f "$APP_DIR/ICON.PNG" ]]   || missing+=("ICON.PNG")
[[ -d "$APP_DIR/app" ]]        || missing+=("app/")
[[ -d "$APP_DIR/cmd" ]]        || missing+=("cmd/")
[[ -d "$APP_DIR/config" ]]     || missing+=("config/")
[[ -d "$APP_DIR/wizard" ]]     || missing+=("wizard/")
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "error: ${APP_NAME} is missing required files: ${missing[*]}" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
WORK="$(mktemp -d)"
STAGE="$WORK/stage"
APP_TGZ="$WORK/app.tgz"
mkdir -p "$STAGE"

# files we never want inside a package
EXCLUDE=(--exclude='.DS_Store' --exclude='._*' --exclude='.git' --exclude='__MACOSX')

# 1) build app.tgz from the contents of app/ (no "./" prefix on entries)
( cd "$APP_DIR/app" && tar -czf "$APP_TGZ" "${EXCLUDE[@]}" $(ls -A) )

# 2) assemble the outer package layout
cp "$APP_TGZ"                 "$STAGE/app.tgz"
cp -r "$APP_DIR/cmd"          "$STAGE/cmd"
cp -r "$APP_DIR/config"       "$STAGE/config"
cp -r "$APP_DIR/wizard"       "$STAGE/wizard"
cp "$APP_DIR/ICON.PNG"        "$STAGE/ICON.PNG"
[[ -f "$APP_DIR/ICON_256.PNG" ]] && cp "$APP_DIR/ICON_256.PNG" "$STAGE/ICON_256.PNG"
cp "$APP_DIR/manifest"        "$STAGE/manifest"

# strip junk that may have slipped in
find "$STAGE" \( -name '.DS_Store' -o -name '._*' -o -name '.git' -o -name '__MACOSX' \) -prune -exec rm -rf {} + 2>/dev/null || true

# 3) produce the final .fpk (gzip tar, normalized ownership, no "./" prefix)
FPK="$OUT_DIR/${APP_NAME}_${ARCH}.fpk"
( cd "$STAGE" && tar -czf "$FPK" "${EXCLUDE[@]}" --owner=0 --group=0 --numeric-owner $(ls -A) )

echo "built: $FPK ($(stat -c%s "$FPK") bytes)"
rm -rf "$WORK"
