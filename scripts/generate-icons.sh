#!/usr/bin/env bash
# Regenerates every launcher / splash PNG from the SVG sources in assets/brand/.
# Requires: rsvg-convert (brew install librsvg) and ImageMagick 7 (brew install imagemagick).
set -euo pipefail
cd "$(dirname "$0")/.."
B=assets/brand
RES=android/app/src/main/res
TMP=$(mktemp -d)

# Expo assets (1024 px): full-bleed icon + adaptive foreground / monochrome layers
rsvg-convert -w 1024 -h 1024 $B/icon.svg                     -o assets/icon.png
rsvg-convert -w 1024 -h 1024 $B/icon-adaptive-foreground.svg -o assets/adaptive-icon.png
rsvg-convert -w 1024 -h 1024 $B/icon-adaptive-monochrome.svg -o assets/adaptive-icon-monochrome.png

# Android: adaptive layers (108 dp), legacy launcher icons (48 dp), splash logo (288 dp)
for entry in mdpi:1 hdpi:1.5 xhdpi:2 xxhdpi:3 xxxhdpi:4; do
  d=${entry%%:*}; s=${entry##*:}
  a=$(python3 -c "print(round(108*$s))"); l=$(python3 -c "print(round(48*$s))"); sp=$(python3 -c "print(round(288*$s))")
  rsvg-convert -w $a -h $a $B/icon-adaptive-foreground.svg -o $RES/drawable-$d/ic_launcher_foreground.png
  rsvg-convert -w $a -h $a $B/icon-adaptive-monochrome.svg -o $RES/drawable-$d/ic_launcher_monochrome.png
  rsvg-convert -w $sp -h $sp $B/splash-logo.svg            -o $RES/drawable-$d/splashscreen_logo.png
  # legacy (pre-Android 8): rounded square and circle cut from the full-bleed icon
  rsvg-convert -w $l -h $l $B/icon.svg -o $TMP/full_$l.png
  r=$(python3 -c "print(round($l*0.2))")
  magick $TMP/full_$l.png \( +clone -alpha extract -fill black -colorize 100 -fill white -draw "roundrectangle 0,0,$((l-1)),$((l-1)),$r,$r" \) -alpha off -compose CopyOpacity -composite $RES/mipmap-$d/ic_launcher.png
  magick $TMP/full_$l.png \( +clone -alpha extract -fill black -colorize 100 -fill white -draw "circle $((l/2)),$((l/2)) $((l/2)),0" \) -alpha off -compose CopyOpacity -composite $RES/mipmap-$d/ic_launcher_round.png
done
rm -rf "$TMP"
echo "icons regenerated"
