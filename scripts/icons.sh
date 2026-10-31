#!/usr/bin/env bash
# Regenerate the committed desktop PNG and ICNS from the editable SVGs.
# Packaging consumes these assets directly; librsvg is only needed to redraw.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ $(uname -s) == Darwin ]] || { echo "ICNS generation requires macOS iconutil." >&2; exit 1; }
command -v rsvg-convert >/dev/null || { echo "Install librsvg (brew install librsvg) to regenerate icons." >&2; exit 1; }

icon_tmp=$(mktemp -d "${TMPDIR:-/tmp}/desktop-icons.XXXXXX")
trap 'rm -rf "$icon_tmp"' EXIT
iconset="$icon_tmp/app.iconset"
mkdir -p "$iconset"

for size in 16 32 128 256 512; do
  for scale in 1 2; do
    pixels=$((size * scale))
    suffix=""
    [[ "$scale" == 2 ]] && suffix="@2x"
    source=desktop/assets/icon.svg
    # Small physical pixels use the flat, optically adjusted favicon, which
    # omits shadows, rim highlights and the secondary panes' status marks.
    [[ "$pixels" -le 32 ]] && source=web/public/icon.svg
    rsvg-convert -w "$pixels" -h "$pixels" "$source" -o "$iconset/icon_${size}x${size}${suffix}.png"
  done
done

cp "$iconset/icon_512x512@2x.png" desktop/assets/icon.png
iconutil -c icns "$iconset" -o desktop/assets/icon.icns
echo "Updated desktop/assets/icon.png and icon.icns"
