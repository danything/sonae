#!/usr/bin/env bash
# Mac と Windows でそのまま動かす sonae 本体の配布物を組む (release.yml と installers.yml が呼ぶ)。
#
#   .github/bundle.sh <darwin-arm64|darwin-x64|windows-x64> <タグ (v1.2.3。CI は dev)> <出す先のフォルダ>
#
# 先に `bun run build` を済ませておく (build/ を使う)。中身:
#
# | 置き場                    | 中身                                                                                       |
# | ------------------------- | ------------------------------------------------------------------------------------------ |
# | `bun` / `bun.exe`         | bun の公式のリリース (バージョンは .bun-version。同じリリースの SHASUMS256.txt で照らす)    |
# | `app/`                    | package.json と build/ (実行時の依存は無い。Dockerfile と同じ)                             |
# | `voicevox.txt`            | VOICEVOX のエンジンの取り方 (下)                                                            |
# | `licenses/`               | sonae と bun のライセンス                                                                  |
#
# **VOICEVOX のエンジンは入れない** (2 GB ほどあり、再配布もしない)。インストーラが利用者の機械に、
# VOICEVOX/voicevox_engine の GitHub のリリースから直に取る。取るもの (vvpp。zip で、大きいものは分けてある) の名前と
# sha256 を voicevox.txt に書く。sha256 は GitHub がリリースの添付に付けている digest で、ダウンロードせずに読める。
# バージョンは compose.prod.yml の voicevox/voicevox_engine のタグ (Renovate が上げる。Linux と同じバージョンにそろう)。
#
#   version 0.26.2
#   part <sha256> voicevox_engine-windows-cpu-0.26.2.vvpp
set -euo pipefail

target=$1 tag=$2 out=$3
case "$target" in
  darwin-arm64) bun_zip=bun-darwin-aarch64.zip vv=macos-arm64 bun_name=bun ;;
  darwin-x64) bun_zip=bun-darwin-x64-baseline.zip vv=macos-x64 bun_name=bun ;;
  # baseline (AVX2 の無い CPU でも動くもの)。古い PC でも動くように
  windows-x64) bun_zip=bun-windows-x64-baseline.zip vv=windows-cpu bun_name=bun.exe ;;
  *) echo "知らない target: $target" >&2; exit 2 ;;
esac

test -f build/index.js || { echo "build/ がありません (先に bun run build)" >&2; exit 1; }

bun_version=$(tr -d ' \r\n' < .bun-version)
vv_version=$(sed -nE 's#^ *image: voicevox/voicevox_engine:([0-9][^ ]*)$#\1#p' compose.prod.yml | head -1)
test -n "$vv_version" || { echo "compose.prod.yml に voicevox/voicevox_engine のタグがありません" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
d="$work/sonae"
mkdir -p "$d/app" "$d/licenses"

base="https://github.com/oven-sh/bun/releases/download/bun-v${bun_version}"
curl -fsSL --retry 5 --retry-all-errors -o "$work/bun.zip" "$base/$bun_zip"
curl -fsSL --retry 5 --retry-all-errors -o "$work/SHASUMS256.txt" "$base/SHASUMS256.txt"
want=$(awk -v n="$bun_zip" '$2 == n { print $1 }' "$work/SHASUMS256.txt")
test -n "$want" || { echo "SHASUMS256.txt に $bun_zip がありません" >&2; exit 1; }
echo "$want  $work/bun.zip" | sha256sum -c -
unzip -q -j "$work/bun.zip" "*/$bun_name" -d "$d"
chmod 755 "$d/$bun_name"
curl -fsSL --retry 5 --retry-all-errors -o "$d/licenses/bun-LICENSE.md" "https://raw.githubusercontent.com/oven-sh/bun/bun-v${bun_version}/LICENSE.md"
cp LICENSE "$d/licenses/sonae-LICENSE"
cp package.json "$d/app/package.json"
cp -r build "$d/app/build"

# VOICEVOX の配布物の名前と sha256 (GitHub の API の digest)。1 つのもの (.vvpp) か、分けたもの (.001.vvppp, .002.vvppp …)
api="https://api.github.com/repos/VOICEVOX/voicevox_engine/releases/tags/$vv_version"
auth=()
if [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then auth=(-H "Authorization: Bearer ${GH_TOKEN:-$GITHUB_TOKEN}"); fi
curl -fsSL --retry 5 --retry-all-errors "${auth[@]}" -H "Accept: application/vnd.github+json" -o "$work/release.json" "$api"
prefix="voicevox_engine-$vv-$vv_version"
jq -r --arg one "$prefix.vvpp" --arg split "^$prefix\\.[0-9]{3}\\.vvppp$" '
  [.assets[] | select(.name == $one or (.name | test($split)))] | sort_by(.name)
  | if length == 0 then error("no vvpp") else . end
  | .[] | "part \(.digest | sub("^sha256:"; "")) \(.name)"' "$work/release.json" > "$work/parts"
# 1 つのものと分けたものの両方があれば、1 つのものだけ使う
if grep -q " $prefix.vvpp$" "$work/parts"; then grep " $prefix.vvpp$" "$work/parts" > "$work/parts.one" && mv "$work/parts.one" "$work/parts"; fi
grep -Eq '^part [0-9a-f]{64} ' "$work/parts" || { echo "VOICEVOX $vv_version の $vv の sha256 が読めません" >&2; cat "$work/parts" >&2; exit 1; }
{ echo "version $vv_version"; cat "$work/parts"; } > "$d/voicevox.txt"
cat "$d/voicevox.txt"

for f in "$bun_name" app/build/index.js app/package.json voicevox.txt licenses/sonae-LICENSE; do
  test -f "$d/$f" || { echo "$f がありません" >&2; exit 1; }
done

mkdir -p "$out"
case "$target" in
  windows-*)
    asset="sonae-${tag#v}-$target.zip"
    (cd "$d" && zip -qr9 "$work/$asset" .)
    ;;
  *)
    asset="sonae-${tag#v}-$target.tar.gz"
    tar -czf "$work/$asset" -C "$d" .
    ;;
esac
mv "$work/$asset" "$out/$asset"
(cd "$out" && sha256sum "$asset" > "$asset.sha256")
ls -la "$out/$asset"
