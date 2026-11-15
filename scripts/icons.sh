#!/usr/bin/env bash
# Regenerate the committed desktop icons from the editable SVGs: icon.png
# (1024 px, Linux and the development Dock icon), icon.icns (macOS) and
# icon.ico (Windows). Packaging consumes these assets directly; librsvg and
# macOS iconutil are only needed to redraw.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ $(uname -s) == Darwin ]] || { echo "ICNS generation requires macOS iconutil." >&2; exit 1; }
command -v rsvg-convert >/dev/null || { echo "Install librsvg (brew install librsvg) to regenerate icons." >&2; exit 1; }

icon_tmp=$(mktemp -d "${TMPDIR:-/tmp}/desktop-icons.XXXXXX")
trap 'rm -rf "$icon_tmp"' EXIT
iconset="$icon_tmp/app.iconset"
mkdir -p "$iconset"

# Small physical pixels use the flat, optically adjusted favicon, which
# omits shadows, rim highlights and the secondary panes' status marks.
render() {
  local source=desktop/assets/icon.svg
  [[ "$1" -le 32 ]] && source=web/public/icon.svg
  rsvg-convert -w "$1" -h "$1" "$source" -o "$2"
}

for size in 16 32 128 256 512; do
  for scale in 1 2; do
    suffix=""
    [[ "$scale" == 2 ]] && suffix="@2x"
    render $((size * scale)) "$iconset/icon_${size}x${size}${suffix}.png"
  done
done
cp "$iconset/icon_512x512@2x.png" desktop/assets/icon.png
iconutil -c icns "$iconset" -o desktop/assets/icon.icns

# The ICO holds PNG images (Windows Vista and later read them) of the sizes
# Explorer, the taskbar and the installer use.
ico=()
for size in 16 24 32 48 64 128 256; do
  render "$size" "$icon_tmp/ico-$size.png"
  ico+=("$icon_tmp/ico-$size.png")
done
node -e '
const fs = require("node:fs");
const [out, ...files] = process.argv.slice(1);
const images = files.map((f) => fs.readFileSync(f));
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((png, i) => {
  const size = png.readUInt32BE(16); // the IHDR width; the images are square
  const entry = 6 + 16 * i;
  header.writeUInt8(size >= 256 ? 0 : size, entry); // 0 is 256
  header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
  header.writeUInt16LE(1, entry + 4); // planes
  header.writeUInt16LE(32, entry + 6); // bits per pixel
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
fs.writeFileSync(out, Buffer.concat([header, ...images]));
' desktop/assets/icon.ico "${ico[@]}"
echo "Updated desktop/assets/icon.png, icon.icns and icon.ico"
