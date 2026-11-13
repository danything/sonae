#!/bin/sh
# ホーム画面のアイコン (PNG) を static/favicon.svg から作る (docs/design.md の 2.4)。
# ホストには何も入れず、コンテナの中の rsvg-convert (librsvg) で描く:
#
#   wslc run --rm -v "$PWD:/w" -w /w debian:trixie-slim sh tools/icons/build.sh
#
# (docker でも同じ。favicon.svg を変えたら作り直してコミットする)
#
# 作るもの (static/icons/):
#   icon-192.png・icon-512.png        purpose any。白い地に、印を 4 分の 3 の大きさで
#   icon-maskable-512.png             purpose maskable。端まで白い地で、印を安全な円 (直径 80%) に収まる 55% に
#   apple-touch-icon.png (180×180)    iOS のホーム画面。透かさない (iOS は透けた所を黒く塗る)
set -eu

if ! command -v rsvg-convert >/dev/null 2>&1; then
  apt-get update -qq >/dev/null
  apt-get install -y -qq --no-install-recommends librsvg2-bin >/dev/null
fi

SRC=static/favicon.svg
OUT=static/icons
BG="#ffffff"
mkdir -p "$OUT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# favicon.svg の中身 (外側の <svg> を除いたもの)。viewBox は 0 0 32 32
inner=$(sed -e 's/^<svg[^>]*>//' -e 's#</svg>[[:space:]]*$##' "$SRC")

# 印を、32 の箱の中で scale の大きさにして真ん中に置いた SVG を作る
wrap() {
  scale=$1
  out=$2
  offset=$(awk "BEGIN { print 16 - 16 * $scale }")
  cat >"$out" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><rect width="32" height="32" fill="$BG"/><g transform="translate($offset $offset) scale($scale)">$inner</g></svg>
SVG
}

wrap 0.75 "$TMP/any.svg"
wrap 0.55 "$TMP/maskable.svg"

rsvg-convert -w 192 -h 192 -o "$OUT/icon-192.png" "$TMP/any.svg"
rsvg-convert -w 512 -h 512 -o "$OUT/icon-512.png" "$TMP/any.svg"
rsvg-convert -w 512 -h 512 -o "$OUT/icon-maskable-512.png" "$TMP/maskable.svg"
rsvg-convert -w 180 -h 180 -o "$OUT/apple-touch-icon.png" "$TMP/any.svg"
ls -l "$OUT"
