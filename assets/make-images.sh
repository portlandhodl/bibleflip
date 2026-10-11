#!/usr/bin/env bash
# Renders the SVG sources here into the PNG/ICO files served from static/.
# Needs rsvg-convert (librsvg), ImageMagick, and the Noto Serif font.
set -euo pipefail
cd "$(dirname "$0")"
out=../static
rsvg-convert -w 1200 -h 630 og-image.svg -o "$out/og-image.png"
cp icon.svg "$out/icons/favicon.svg"
for size in 180 192 512; do
  rsvg-convert -w $size -h $size icon.svg -o "$out/icons/icon-$size.png"
done
mv "$out/icons/icon-180.png" "$out/icons/apple-touch-icon.png"
rsvg-convert -w 256 -h 256 icon.svg -o /tmp/bibleflip-icon-256.png
magick /tmp/bibleflip-icon-256.png -define icon:auto-resize=48,32,16 "$out/favicon.ico"
rm /tmp/bibleflip-icon-256.png
echo "Wrote og-image.png, favicon.ico, icons/"
