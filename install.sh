#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# sonae を立てる。**Linux でも Mac でも 1 行で、ブラウザが開くところまで。**
#
#   curl -fsSL https://raw.githubusercontent.com/danything/sonae/main/install.sh | bash        Linux
#   curl -fsSL https://raw.githubusercontent.com/danything/sonae/main/install.sh | sudo bash   Mac (管理者で)
#   … | bash -s -- --no-open      ブラウザを開かない
#   … | bash -s -- --uninstall    止めて外す (DB と設定は残す)
#
# Windows は install.ps1 (同じ作りを PowerShell で。docs/install-windows.md)
#
# **Linux** は Docker Compose で、sonae と VOICEVOX のエンジンを動かす (compose.prod.yml をそのまま置く)。
# **Mac** (Apple Silicon・Intel) は、コンテナを使わず Mac の上でそのまま動かす。sonae 本体は配布物の bun とビルドしたアプリ
# (`sonae-<バージョン>-darwin-<arm64|x64>.tar.gz`)、VOICEVOX は公式のエンジンの Mac 用 (CPU 版。VOICEVOX/voicevox_engine の
# GitHub のリリース)。どちらも **root の LaunchDaemon** に載せるので、誰もログインしていなくても動き、地震を受けられる。
# そのために sudo で流す。
#
# **Docker は勝手に入れない** (Linux)。無い・起きていない・触る権限が無いときは、入れ方を案内して止まる。
# もう一度流せば、そのまま最新に上げ直す (Linux は pull して up -d、Mac は配布物を取り直して入れ替える。
# VOICEVOX は 2 GB ほどあるので、バージョンが変わったときだけ取り直す)。
# compose ファイルもイメージも**最新のリリースのバージョン**に揃える (取ってきた compose.yml のタグを書き換える)。
#
# **Web Push の VAPID の鍵は、無ければ作る** (docs/push.md と同じ作り方。P-256 の ECDSA の秘密鍵を JWK に)。
# 作るのは一度だけで、上げ直しても替えない (替えると、どのブラウザの購読にも送れなくなる)。
#
# **誰を通すか:** 家の LAN (と、このマシンのブラウザ) からはログインなしで開けるように、sonae.env に TRUSTED_NETWORKS を書く
# (無いときだけ。Linux は 192.168.0.0/16・10.0.0.0/8 と genkan のゲートウェイ、Mac はそれにループバック)。
# **その中の誰でも設定を変えられる。** 外からも開くなら OIDC を sonae.env に書く (docs/install.md の「ログイン」)。
#
# **入口は genkan** (Linux。https://github.com/danything/genkan。ホスト名でコンテナに振り分けるリバースプロキシ)。
# 動いていればそれを使い、無ければ 80 と 443 が空いているときだけ ~/genkan に入れて、
# http://sonae.localhost で開けるようにする (登録は compose.override.yml に書く)。ポート 3030 は残す。
#
# 置き場:
#   Linux        ~/sonae (SONAE_HOME で変えられる)    compose.yml (上げ直すたびに上書き)・compose.override.yml
#                                                     (手を入れるならここ。無いときだけ雛形を作り、あれば触らない)・
#                                                     sonae.env (秘密と手で足す環境変数。本人だけが読める。無いときだけ作る)
#                Docker のボリューム sonae_sonae-data  DB (sonae.db)
#   Mac          /Library/Application Support/sonae/  server/ (bun とアプリ)・voicevox/ (VOICEVOX のエンジン)・
#                                                     data/ (DB・sonae.env・本体を起こす sonae.sh。root だけが読み書きできる)
#                /Library/LaunchDaemons/io.github.danything.{sonae,sonae-voicevox}.plist  起動したら起こし、落ちたら起こし直す
#                /Library/Logs/sonae/{sonae,voicevox}.log                                  ログ
#
# 環境変数: SONAE_VERSION (v1.2.3 のように。既定は最新のリリース。main などの git の ref も渡せる (イメージは latest))、
# SONAE_HOME (Linux)、SONAE_COMPOSE_FILE (Linux: compose.prod.yml の代わりに置く手元のファイル。CI と開発用)、
# SONAE_IMAGE (Linux: sonae のイメージの代わりに使う手元で組んだイメージ。CI と開発用)、
# SONAE_SERVER_TARBALL (Mac: 手元で組んだ本体の tar.gz を絶対パスで。CI と開発用)、
# SONAE_VAPID_SUBJECT (Web Push の連絡先。mailto:… か https://…。既定はこのリポジトリの URL)。
# Mac で渡すときは sudo に -E を付ける (sudo は環境変数を落とす)
#
# macOS の bash は 3.2 なので、4 以降の書き方 (連想配列・mapfile など) は使わない。
# ---------------------------------------------------------------------------
set -euo pipefail

REPO=danything/sonae
PORT=3030
URL=http://localhost:$PORT
GENKAN_URL=http://sonae.localhost
SONAE_DIR="${SONAE_HOME:-$HOME/sonae}"
# install.sh が書いた compose.yml の 1 行目 (手で置いたものと見分けるので、文言は変えない)
MARK="# install.sh が置いた (版"
# Web Push の連絡先の既定 (docs/push.md)。配信サービス (FCM・Mozilla・Apple) が困ったときに見る。
# https でない URL (http://localhost) は受け付けないので、PUBLIC_URL に頼らずここで決める
VAPID_SUBJECT_DEFAULT="https://github.com/$REPO"

open_browser=yes uninstall=no
for arg in "$@"; do
  case "$arg" in
    --no-open) open_browser=no ;;
    --uninstall) uninstall=yes ;;
    *) echo "知らない引数: $arg (--no-open / --uninstall)" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mエラー:\033[0m %s\n' "$*" >&2; exit 1; }
# 時間の上限を付ける。繋がったまま止まる相手だと、付けなければいつまでも待つ。時間切れも --retry が試し直す
CURL_LIMITS=(--connect-timeout 20 --max-time 300)
fetch() { curl -fsSL --retry 3 "${CURL_LIMITS[@]}" -o "$2" "$1" || die "ダウンロードできません: $1"; }

# 入れるバージョン。compose ファイルはこのバージョン (git の ref) から取り、イメージは x.y.z の形式のときだけそのバージョンに
# 揃える (コミットやブランチなら latest)。API を使わず、latest の転送先からタグを読む (API は回数制限がある)。
# リリースがまだ無いと、転送先は /releases になる
version() {
  if [ -n "${SONAE_VERSION:-}" ]; then echo "$SONAE_VERSION"; return; fi
  tag=$(curl -fsSLI --connect-timeout 20 --max-time 60 -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") \
    || die "最新のリリースが分かりません"
  case "$tag" in
    */releases/tag/*) echo "${tag##*/}" ;;
    *) die "sonae にはまだリリースがありません (試すなら SONAE_VERSION=main を付けて流す。イメージは main の最新)" ;;
  esac
}
is_release() { printf '%s' "${1#v}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }
image_tag() { if is_release "$1"; then echo "${1#v}"; else echo latest; fi; }

# sonae.env に KEY= の行があるか (コメントにした行は数えない)
env_has() { [ -f "$1" ] && grep -q "^$2=" "$1"; }
# sonae.env に 1 行足す。最後が改行で終わっていなければ、前の行にくっつかないように改行を足してから
env_add() {
  if [ -s "$1" ] && [ -n "$(tail -c 1 "$1")" ]; then echo >> "$1"; fi
  printf '%s\n' "$2" >> "$1"
}

# sonae.env の雛形。**無いときだけ作り、あれば触らない** (手で書き足す場所)。本人だけが読めるように作る。
# $2 はログインなしで通すネットワーク (TRUSTED_NETWORKS。docs/install.md の「ログイン」)
env_template() {
  [ -f "$1" ] && return 0
  (
    umask 077
    printf '%s\n' \
      '# sonae の環境変数 (docs/install.md の「環境変数を足す」)。install.sh は無いときだけ作り、あとは触らない' \
      '# (VAPID の鍵の行が無ければ足すだけ)。直したら install.sh を流し直す。秘密が入るので人に見せない' \
      '#' \
      '# 誰を通すか (docs/install.md の「ログイン」)。このネットワークの中からは、ログインなしで開ける。' \
      '# **その中の誰でも、設定 (読み上げの声・通知の条件・Web Push の購読) を変えられる。** 家の LAN だけにし、0.0.0.0/0 にはしない。' \
      '# 外から開くなら OIDC (下) を使う。http の LAN の IP (http://192.168.x.x:3030) で開くと、Web Push は使えない (localhost か https で開く)' \
      "TRUSTED_NETWORKS=$2" \
      '# このほかの名前 (自分のドメイン・Tailscale の名前) で、ログインなしで開くなら書く (IP・localhost・.local などは要らない)' \
      '# ALLOWED_HOSTS=sonae.example.com' \
      '#' \
      '# ログイン (OIDC)。3 つ揃えば、上のネットワークの外からもログインして開ける (docs/entra.md)。IdP には <開く URL>/auth/callback を登録する' \
      '# OIDC_ISSUER=https://login.microsoftonline.com/<テナントの ID>/v2.0' \
      '# OIDC_CLIENT_ID=' \
      '# OIDC_CLIENT_SECRET=' \
      '# 通すロール (既定 admin)' \
      '# OIDC_ROLE=admin' \
      '# 外から https で開くなら、その URL (ログインの戻り先と Web Push の連絡先に使う)' \
      '# PUBLIC_URL=https://sonae.example.com' \
      '# 台湾の中央氣象署の授権碼 (docs/cwa.md)' \
      '# CWA_API_KEY=' > "$1"
  )
}

# VAPID の鍵 (P-256 の ECDSA の秘密鍵の JWK。docs/push.md) を作る JS。$1 は bun を呼ぶコマンド
VAPID_JS='const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]); console.log(JSON.stringify(await crypto.subtle.exportKey("jwk", k.privateKey)))'

# sonae.env ($1) に VAPID の鍵と連絡先が無ければ足す。鍵は $2 以降のコマンド (bun) で作る。
# **一度作ったら替えない** (替えると購読が全部送れなくなる。docs/push.md の「鍵を替えるとき」)
ensure_vapid() {
  file=$1
  shift
  if ! env_has "$file" VAPID_PRIVATE_JWK; then
    say "Web Push の鍵 (VAPID) を作ります"
    jwk=$("$@" | tail -n 1 | tr -d '\r') || die "VAPID の鍵を作れませんでした ($1)"
    printf '%s' "$jwk" | grep -q '"crv":"P-256"' || die "VAPID の鍵を作れませんでした"
    env_add "$file" "# Web Push の鍵 (install.sh が作った。替えると、どのブラウザの購読にも送れなくなる。docs/push.md)"
    env_add "$file" "VAPID_PRIVATE_JWK=$jwk"
  fi
  if ! env_has "$file" VAPID_SUBJECT; then
    env_add "$file" "# Web Push の配信サービスが困ったときの連絡先。自分の mailto:… に替えてよい"
    env_add "$file" "VAPID_SUBJECT=${SONAE_VAPID_SUBJECT:-$VAPID_SUBJECT_DEFAULT}"
  fi
}

say_login() {
  networks=$(sed -n 's/^TRUSTED_NETWORKS=//p' "$1" | tail -n 1)
  if [ -n "$networks" ]; then
    say "ログインなしで開けるのは $networks の中からです。その中の誰でも設定を変えられます (変えるなら $1 の TRUSTED_NETWORKS)"
  fi
  if ! env_has "$1" OIDC_CLIENT_SECRET; then
    say "外からも開くなら、$1 に OIDC_ISSUER・OIDC_CLIENT_ID・OIDC_CLIENT_SECRET を書いて、もう一度流してください (docs/install.md の「ログイン」)"
  fi
}

say_voicevox_terms() {
  say "読み上げの声は VOICEVOX で作ります。使うときは VOICEVOX の利用規約 (https://voicevox.hiroshiba.jp/term/) と"
  say "  声のキャラクターの規約に従ってください (既定の声は「VOICEVOX:剣崎雌雄」。docs/install.md の「VOICEVOX」)"
}

# ---------------------------------------------------------------------------
# Linux: compose.prod.yml を置いて Docker Compose で起こす
# ---------------------------------------------------------------------------

# Docker が使えるか。駄目なら理由と入れ方を言って 1 を返す (止めるかは呼ぶ側)
docker_ready() {
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    say "Docker (compose) が見当たりません。$1"
    return 1
  fi
  if docker info >/dev/null 2>&1; then return 0; fi
  if [ "$(id -u)" != 0 ] && ! id -nG | grep -qw docker; then
    say "Docker に触る権限がありません。sudo usermod -aG docker $(id -un) のあとログインし直して、もう一度流してください"
  else
    say "Docker が動いていません。$2"
  fi
  return 1
}

# genkan が入っているか。**genkan ネットワークがあれば入っている** (genkan だけが作る名前。止まっていても残る)。
# 止めてあるものは起こし直さない (意図して止めた人の genkan を、上げ直すたびに復活させない)
genkan_installed() { docker network inspect genkan >/dev/null 2>&1; }
genkan_running() {
  genkan_installed && docker ps --filter network=genkan --format '{{.Image}}' | grep -q caddy-docker-proxy
}
# そのポートで誰かが待ち受けているか。bash の /dev/tcp で繋いでみる
port_used() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# genkan を使えるようにする。使えれば 0。**80 か 443 が埋まっていれば入れない** (誰かのものを奪わない)
ensure_genkan() {
  genkan_running && return 0
  if genkan_installed; then
    say "genkan は入っていますが止まっています (起動すれば $GENKAN_URL で開けます)"
    return 1
  fi
  if port_used 80 || port_used 443; then
    say "80 か 443 が使われているので genkan は入れません (ポート $PORT で開きます)"
    return 1
  fi
  if ! command -v git >/dev/null 2>&1; then
    say "git が無いので genkan は入れません (ポート $PORT で開きます)"
    return 1
  fi
  say "genkan を $HOME/genkan に入れます ($GENKAN_URL で開けるように)"
  # イメージの取得は、レジストリが一時的に断ることがある。init.sh は何度流しても同じ結果になるので、間を空けて 3 回まで
  local try
  for try in 1 2 3; do
    if (cd "$HOME" && curl -fsSL "${CURL_LIMITS[@]}" https://raw.githubusercontent.com/danything/genkan/main/init.sh | sh -s); then
      genkan_running
      return
    fi
    if [ "$try" -lt 3 ]; then
      say "genkan を入れられませんでした。$((try * 10)) 秒後に試し直します"
      sleep $((try * 10))
    fi
  done
  say "genkan を入れられませんでした (ポート $PORT で開きます)"
  return 1
}

# genkan に sonae を登録する断片。http:// を付けるので HTTPS にせず、証明書の信頼も要らない
# (*.localhost はブラウザが安全な文脈として扱うので、Web Push もそのマシンのブラウザで使える)。
# **私設網の外から来たものは genkan で断る** (ほかのアプリのために 80 番を外へ開けていると、Host を偽るだけで素通りになる)
genkan_override() {
  printf '%s\n' 'services:' '  sonae:' '    labels:' \
    '      caddy: http://sonae.localhost' \
    '      caddy.@outside: not remote_ip private_ranges' \
    '      caddy.respond: "@outside 403"' \
    '      caddy.reverse_proxy: "{{upstreams 3000}}"'
  genkan_env
  printf '%s\n' '    networks: [default, genkan]' '' 'networks:' '  genkan:' '    external: true'
}

# genkan のネットワークの範囲とゲートウェイ ("172.20.0.0/16 172.20.0.1")。Docker が決めるので、ここで調べる。読めなければ空
genkan_net() {
  docker network inspect genkan -f '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{println}}{{end}}' 2>/dev/null \
    | grep -m1 '^[0-9.]*/[0-9]* [0-9.]*$' || true
}

# **genkan を前段として認める** (sonae の environment の断片)。genkan のネットワークを TRUSTED_PROXIES に書き、
# genkan が付ける X-Forwarded-For から本当の接続元を読ませる。genkan のネットワークそのものは TRUSTED_NETWORKS に入れない
# (入れると genkan 越しの人が全員当たる)。このマシンのブラウザ (http://sonae.localhost) はゲートウェイから来たように
# 見えるので、TRUSTED_NETWORKS にはゲートウェイだけを足す (linux_main)
genkan_env() {
  net=$(genkan_net)
  if [ -z "$net" ]; then
    say "genkan のネットワークの範囲が読めず、TRUSTED_PROXIES を書けませんでした。genkan 越しにログインなしで開くなら、docs/install.md を見て compose.override.yml に足してください" >&2
    return 0
  fi
  printf '%s\n' '    environment:' \
    '      # genkan を前段として認める (X-Forwarded-For から本当の接続元を読む。docs/install.md の「ログイン」)' \
    "      TRUSTED_PROXIES: ${net% *}"
}

# ~/sonae で docker compose。-f を付けないので compose.yml と compose.override.yml を Compose が自分で重ねる
compose() { (cd "$SONAE_DIR" && docker compose "$@"); }

# compose.prod.yml を ~/sonae/compose.yml に置く。**バージョンはタグで揃える** (取ってきたものの latest を書き換える)
place_compose() {
  ref=$1
  if [ -n "${SONAE_COMPOSE_FILE:-}" ]; then
    cp "$SONAE_COMPOSE_FILE" "$SONAE_DIR/compose.yml.new"
  else
    curl -fsSL --retry 3 "${CURL_LIMITS[@]}" -o "$SONAE_DIR/compose.yml.new" "https://raw.githubusercontent.com/$REPO/$ref/compose.prod.yml" \
      || die "$ref に compose.prod.yml がありません"
  fi
  # 手で置いたもの・手を入れたものは黙って上書きせず、compose.yml.bak に退けてそう言う。
  # install.sh が書いたものは 1 行目が印で、残りは前に書いた控え (.compose.yml.orig) と同じはず
  if [ -f "$SONAE_DIR/compose.yml" ] && ! { head -1 "$SONAE_DIR/compose.yml" | grep -q "^$MARK" \
    && tail -n +2 "$SONAE_DIR/compose.yml" | cmp -s - "$SONAE_DIR/.compose.yml.orig"; }; then
    mv "$SONAE_DIR/compose.yml" "$SONAE_DIR/compose.yml.bak"
    say "手を入れた $SONAE_DIR/compose.yml を compose.yml.bak に退避しました。変更は compose.override.yml に移してください"
  fi
  if [ -n "${SONAE_IMAGE:-}" ]; then
    sed "s#image: ghcr.io/danything/sonae:latest#image: $SONAE_IMAGE#" "$SONAE_DIR/compose.yml.new" > "$SONAE_DIR/.compose.yml.orig"
  else
    sed "s#\(image: ghcr.io/danything/sonae\):latest#\1:$(image_tag "$ref")#" "$SONAE_DIR/compose.yml.new" > "$SONAE_DIR/.compose.yml.orig"
  fi
  { echo "$MARK $ref。手を入れず、足すものは compose.override.yml に)"; cat "$SONAE_DIR/.compose.yml.orig"; } > "$SONAE_DIR/compose.yml"
  rm -f "$SONAE_DIR/compose.yml.new"
}

# compose.override.yml の雛形 (無いときだけ)。genkan に登録できれば登録も書く。genkan で開けるなら yes を返す ($genkan)
place_override() {
  override="$SONAE_DIR/compose.override.yml"
  # genkan の登録が残っているのに genkan ネットワークが無い (genkan を外した) と、up が分かりにくく落ちる
  if [ -f "$override" ] && grep -q 'sonae.localhost' "$override" && ! genkan_installed; then
    die "genkan が見当たりません。$override の genkan への登録 (labels・networks) を消すか、genkan を入れ直してから流し直してください"
  fi
  genkan=no
  # **登録するときだけ genkan を入れる** (雛形を作るときか、もう登録が書いてあるとき)
  if [ ! -f "$override" ] || grep -q 'sonae.localhost' "$override"; then
    ensure_genkan && genkan=yes
  fi
  if [ ! -f "$override" ]; then
    {
      echo "# 手元で足したい・変えたいものはここに書く。compose.yml は install.sh が更新のたびに"
      echo "# 上書きするが、このファイルには触らない (Compose が compose.yml に重ねて読む)。"
      echo "# 秘密 (OIDC のクライアントシークレットなど) は sonae.env に書く"
      if [ "$genkan" = yes ]; then
        echo "#"
        echo "# genkan ($GENKAN_URL) への登録は install.sh が書いた"
        genkan_override
      else
        echo "services: {}"
      fi
    } > "$override"
  elif ! grep -q 'sonae.localhost' "$override" && genkan_running; then
    say "compose.override.yml には触りません。genkan の $GENKAN_URL で開くなら、次を足して流し直してください:"
    genkan_override
  elif grep -q 'sonae.localhost' "$override" && ! grep -q 'TRUSTED_PROXIES' "$override" && genkan_running; then
    # 前のバージョンが書いた登録。genkan 越しにログインなしで開くには、前段として認める行が要る
    say "compose.override.yml には触りません。genkan 越しにログインなしで開くなら、sonae: の下に次を足して流し直してください:"
    genkan_env
  fi
}

# 答えるまで待って、開けるなら開く。LAN から入るときの住所も出す
wait_and_open() {
  say "sonae の応答を待ちます"
  for _ in $(seq 90); do
    if curl -fsS --max-time 5 -o /dev/null "$URL/health" 2>/dev/null; then
      # localhost は Docker の中継を通り、送信元が Docker のゲートウェイに見える (TRUSTED_NETWORKS に入れない) ので、
      # このマシンのブラウザでも LAN の IP で開く
      url=$URL
      if printf '%s' "$1" | grep -Eq '^[0-9.]+$'; then url="http://$1:$PORT"; fi
      # genkan 越しにも答えれば、そちらを開く (Caddy がラベルを読むまで少し掛かる)
      if [ "$2" = yes ]; then
        for _ in $(seq 15); do
          if curl -fsS --max-time 5 -o /dev/null --resolve sonae.localhost:80:127.0.0.1 "$GENKAN_URL/health" 2>/dev/null; then
            url=$GENKAN_URL
            break
          fi
          sleep 2
        done
      fi
      say "起動しました: $url (LAN のほかの機器からは http://$1:$PORT)"
      [ "$open_browser" = yes ] || return 0
      if command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
        xdg-open "$url" >/dev/null 2>&1 || true
      fi
      return 0
    fi
    sleep 2
  done
  die "sonae が応答しません。cd $SONAE_DIR && docker compose logs を見てください"
}

genkan_left() {
  [ -d "$HOME/genkan" ] || return 0
  say "  genkan $HOME/genkan (80・443。ほかのアプリも乗る。要らなければ cd ~/genkan && docker compose down)。"
  say "  genkan を外したら compose.override.yml の genkan への登録も消してください"
}

linux_main() {
  if [ "$uninstall" = yes ]; then
    if [ -f "$SONAE_DIR/compose.yml" ] && docker_ready "" ""; then compose down; fi
    say "止めました。残してあるもの (要らなければ手で消してください):"
    say "  compose と設定 (sonae.env) $SONAE_DIR / DB は docker volume rm sonae_sonae-data"
    genkan_left
    return 0
  fi

  # sonae のイメージは amd64 だけ (docker-publish.yml)
  [ "$(uname -m)" = x86_64 ] || die "Linux で対応しているのは x86_64 (amd64) だけです (ほかのイメージはありません)"
  docker_ready "https://get.docker.com の手順で入れてから、もう一度流してください" \
    "sudo systemctl start docker で起こしてから、もう一度流してください" || exit 1

  # LAN の IP は外へ出る経路の送信元から取る (hostname -I の先頭は docker0 の 172.17.0.1 のこともある)
  ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' || true)
  [ -n "$ip" ] || ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  ref=$(version)
  say "sonae $ref を $SONAE_DIR に置きます"
  mkdir -p "$SONAE_DIR"
  place_compose "$ref"
  place_override
  # 手元で組んだイメージ (SONAE_IMAGE) はレジストリに無いので、引けなくても進む
  if [ -n "${SONAE_IMAGE:-}" ]; then compose pull --ignore-pull-failures; else compose pull; fi
  envfile="$SONAE_DIR/sonae.env"
  # ログインなしで通すのは LAN (192.168.0.0/16・10.0.0.0/8) と、genkan で開くならそのゲートウェイ (このマシンのブラウザ)。
  # Docker のネットワーク (172.16.0.0/12) は入れない (前段越しの人が全員当たる)
  trusted="192.168.0.0/16,10.0.0.0/8"
  if [ "$genkan" = yes ]; then
    gw=$(genkan_net)
    gw=${gw#* }
    [ -z "$gw" ] || trusted="$trusted,$gw"
  fi
  env_template "$envfile" "$trusted"
  # 鍵は sonae のイメージの bun で作る (ホストに何も入れない。イメージは上で引いてある)
  image=$(sed -n 's/^ *image: \(ghcr.io\/danything\/sonae:.*\)$/\1/p' "$SONAE_DIR/compose.yml" | head -1)
  ensure_vapid "$envfile" docker run --rm --entrypoint /usr/local/bin/bun "$image" -e "$VAPID_JS"
  compose up -d --remove-orphans
  wait_and_open "${ip:-$(hostname)}" "$genkan"
  say_login "$envfile"
  say_voicevox_terms
}

# ---------------------------------------------------------------------------
# Mac: sonae 本体と VOICEVOX を root の LaunchDaemon で
# ---------------------------------------------------------------------------
SERVER_LABEL=io.github.danything.sonae
VOICEVOX_LABEL=io.github.danything.sonae-voicevox
PREFIX="/Library/Application Support/sonae"
# DB・sonae.env・本体を起こす sonae.sh。root だけが読み書きできる
DATA="$PREFIX/data"
SERVER_PLIST="/Library/LaunchDaemons/$SERVER_LABEL.plist"
VOICEVOX_PLIST="/Library/LaunchDaemons/$VOICEVOX_LABEL.plist"
LOGS=/Library/Logs/sonae
# VOICEVOX のエンジンが待ち受ける (ループバックだけ)。VOICEVOX のアプリ (50021) と重ならないように別にする
VOICEVOX_PORT=50121

# 止めて、消えるまで待つ (bootout は止まるのに時間の掛かるサービスだと待たずに返る)
mac_stop() {
  launchctl print "$1" >/dev/null 2>&1 || return 0
  say "動いている ${1##*/} を止めます"
  launchctl bootout "$1" 2>/dev/null || true
  for _ in $(seq 120); do
    launchctl print "$1" >/dev/null 2>&1 || return 0
    sleep 1
  done
  die "${1##*/} が 2 分たっても止まりません (sudo launchctl bootout $1 で止めてから、もう一度流してください)"
}

check() {
  [ "$(shasum -a 256 "$1" | awk '{print $1}')" = "$2" ] || die "$1 のハッシュが合いません (ダウンロード中に壊れた可能性があります。もう一度流してください)"
}

# sh の一重引用符で囲む (sonae.sh に置き場を書くため。"Application Support" に空白がある)
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# 本体の置き場 ($DATA)。DB・鍵・sonae.env があるので、root だけにする
mac_data_dir() {
  mkdir -p "$DATA"
  chown root:wheel "$DATA"
  chmod 700 "$DATA"
}

# LaunchDaemon に載せる (plist は root のもので、ほかの人が書けないこと。launchd がそうでないものを断る)
mac_bootstrap() {
  chown root:wheel "$1"
  chmod 644 "$1"
  plutil -lint "$1" >/dev/null
  launchctl bootstrap system "$1" || die "LaunchDaemon に載せられません。ログを見てください: $2 (載せ直すなら sudo launchctl bootstrap system \"$1\")"
}

# 本体の配布物を取って new/server に開く。VOICEVOX の取り方 (voicevox.txt) も中に入っている
mac_payload() {
  tarball="${SONAE_SERVER_TARBALL:-}"
  if [ -z "$tarball" ]; then
    is_release "$1" || die "Mac は配布物から入れるので、リリースのバージョン (v1.2.3 の形) を渡してください: $1"
    tarball="sonae-${1#v}-darwin-$ARCH.tar.gz"
    say "sonae $1 ($ARCH)"
    fetch "https://github.com/$REPO/releases/download/$1/$tarball" "$tarball"
    fetch "https://github.com/$REPO/releases/download/$1/$tarball.sha256" "$tarball.sha256"
    check "$tarball" "$(awk '{print $1}' "$tarball.sha256")"
  fi
  mkdir -p new/server && tar -xzf "$tarball" -C new/server
  for f in bun app/build/index.js app/package.json voicevox.txt; do
    [ -f "new/server/$f" ] || die "sonae の tar.gz に $f が入っていません"
  done
}

# VOICEVOX のエンジンを new/voicevox に揃える。**入っているものと同じバージョンなら取らない** (2 GB ほどある)。
# 取り方は配布物の voicevox.txt (1 行目が `version <版>`、続く `part <sha256> <名前>` を順につなぐと vvpp (zip) になる)。
# 取ってくるのは VOICEVOX/voicevox_engine の GitHub のリリースからで、ハッシュは sonae のリリースを作ったときに
# GitHub が示していたもの。取ってきたら $1 (yes/no) で取ったかを返す ($vv_new)
mac_voicevox() {
  manifest=new/server/voicevox.txt
  vv_version=$(awk '$1 == "version" { print $2 }' "$manifest")
  [ -n "$vv_version" ] || die "voicevox.txt に version がありません"
  vv_new=no
  if [ -f "$PREFIX/voicevox/VERSION" ] && [ "$(cat "$PREFIX/voicevox/VERSION")" = "$vv_version" ] && [ -x "$PREFIX/voicevox/run" ]; then
    say "VOICEVOX $vv_version は入っています"
    return 0
  fi
  free=$(df -Pk "$PWD" | awk 'NR == 2 { print $4 }')
  [ "${free:-0}" -gt 6000000 ] || die "VOICEVOX を開くのに 6 GB ほど要ります ($(df -Ph "$PWD" | awk 'NR == 2 { print $4 }') しか空いていません)"
  say "VOICEVOX のエンジン $vv_version を取ってきます (2 GB ほど。数分かかります)"
  : > engine.zip
  parts=0
  while read -r sum name; do
    fetch "https://github.com/VOICEVOX/voicevox_engine/releases/download/$vv_version/$name" part
    check part "$sum"
    cat part >> engine.zip
    rm -f part
    parts=$((parts + 1))
  done < <(awk '$1 == "part" { print $2, $3 }' "$manifest")
  [ "$parts" -gt 0 ] || die "voicevox.txt に part がありません"
  say "VOICEVOX を開きます"
  mkdir -p new/voicevox
  unzip -q engine.zip -d new/voicevox || die "VOICEVOX の zip を開けません"
  rm -f engine.zip
  [ -f new/voicevox/run ] || die "VOICEVOX の zip に run が入っていません"
  chmod 755 new/voicevox/run
  echo "$vv_version" > new/voicevox/VERSION
  vv_new=yes
}

mac_register_voicevox() {
  cat > "$VOICEVOX_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$VOICEVOX_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$PREFIX/voicevox/run</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>$VOICEVOX_PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$PREFIX/voicevox</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/voicevox.log</string>
  <key>StandardErrorPath</key><string>$LOGS/voicevox.log</string>
</dict>
</plist>
EOF
  mac_bootstrap "$VOICEVOX_PLIST" "$LOGS/voicevox.log"
}

# sonae 本体を起こす sonae.sh と plist。**置き場・ポート・VOICEVOX の宛先はここで決め、sonae.env より勝たせる**
# (sonae.env は手で直すところ)。sonae.env は起こすたびに読み直す
mac_register_server() {
  server="$PREFIX/server"
  # 一重引用符の中の $ は sonae.sh が展開する (ここでは展開しない)
  # shellcheck disable=SC2016
  {
    echo '#!/bin/sh'
    echo '# Written by install.sh (sonae). Re-run the installer instead of editing this file.'
    echo "env_file=$(quote "$DATA/sonae.env")"
    # 1 行ずつ KEY=値 として読む (sh として読まない。値の空白や記号 (VAPID の鍵の JSON) をそのまま渡す)
    echo 'if [ -f "$env_file" ]; then'
    echo '  while IFS= read -r line || [ -n "$line" ]; do'
    # 名前が識別子でない行 (手で書いた打ち間違い) は飛ばす。export が失敗すると sh ごと終わり、launchd が起こし直し続けるため。
    # Windows のメモ帳で保存した CRLF の \r も落とす
    printf '%s\n' '    line=$(printf "%s" "$line" | tr -d "\r")'
    echo '    case "$line" in "" | "#"*) continue ;; [A-Za-z_]*=*) ;; *) continue ;; esac'
    echo '    name=${line%%=*}'
    echo '    case "$name" in *[!A-Za-z0-9_]*) continue ;; esac'
    echo '    export "$name=${line#*=}"'
    echo '  done < "$env_file"'
    echo 'fi'
    for kv in \
      "NODE_ENV=production" \
      "TZ=Asia/Tokyo" \
      "SONAE_DATA=$DATA" \
      "PORT=$PORT" \
      "HOST=0.0.0.0" \
      "VOICEVOX_URL=http://127.0.0.1:$VOICEVOX_PORT" \
      "CONNECTION_IDLE_TIMEOUT=255" \
      "SHUTDOWN_TIMEOUT=5" \
      "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0"; do
      echo "export ${kv%%=*}=$(quote "${kv#*=}")"
    done
    echo "cd $(quote "$server/app") || exit 1"
    echo "exec $(quote "$server/bun") ./build/index.js"
  } > "$DATA/sonae.sh"
  chmod 700 "$DATA/sonae.sh"
  cat > "$SERVER_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVER_LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$DATA/sonae.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/sonae.log</string>
  <key>StandardErrorPath</key><string>$LOGS/sonae.log</string>
</dict>
</plist>
EOF
  mac_bootstrap "$SERVER_PLIST" "$LOGS/sonae.log"

  say "sonae の応答を待ちます"
  for _ in $(seq 90); do
    if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null; then
      host="$(scutil --get LocalHostName 2>/dev/null || hostname).local"
      say "起動しました: $URL (LAN のほかの機器からは http://$host:$PORT)"
      return 0
    fi
    sleep 2
  done
  die "sonae が応答しません。ログを見てください: $LOGS/sonae.log"
}

mac_main() {
  [ "$(id -u)" = 0 ] || die "Mac は管理者で流してください: curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sudo bash (sonae と VOICEVOX を、ログインしなくても動く LaunchDaemon に載せるためです)"

  if [ "$uninstall" = yes ]; then
    mac_stop "system/$SERVER_LABEL"
    mac_stop "system/$VOICEVOX_LABEL"
    rm -f "$SERVER_PLIST" "$VOICEVOX_PLIST" "$DATA/sonae.sh"
    rm -rf "${PREFIX:?}/server" "${PREFIX:?}/voicevox"
    say "外しました。残してあるもの (要らなければ手で消してください):"
    say "  DB と sonae.env $DATA / ログ $LOGS"
    return 0
  fi

  case "$(uname -m)" in
    arm64) ARCH=arm64 ;;
    x86_64) ARCH=x64 ;;
    *) die "対応しているのは Apple Silicon (arm64) と Intel (x86_64) の Mac だけです" ;;
  esac

  work=$(mktemp -d /tmp/sonae-install.XXXXXX)
  trap 'rm -rf "$work"' EXIT
  cd "$work"

  ref=""
  [ -n "${SONAE_SERVER_TARBALL:-}" ] || ref=$(version)
  # --- 揃えてから止める (取ってこられなかったら、動いているものに触らない) ---
  mac_payload "$ref"
  mac_voicevox
  # 置き場と sonae.env (VAPID の鍵は取ってきた bun で作る) も、止める前に済ませる
  mkdir -p "$PREFIX"
  chown root:wheel "$PREFIX"
  chmod 755 "$PREFIX"
  mac_data_dir
  envfile="$DATA/sonae.env"
  # この Mac のブラウザ (ループバック) と LAN。Mac の上でそのまま動かすので、前段は無い
  env_template "$envfile" "127.0.0.0/8,::1/128,192.168.0.0/16,10.0.0.0/8"
  printf '%s\n' "$VAPID_JS" > vapid.mjs
  ensure_vapid "$envfile" "$work/new/server/bun" vapid.mjs
  chmod 600 "$envfile"
  mac_stop "system/$SERVER_LABEL"
  [ "$vv_new" = no ] || mac_stop "system/$VOICEVOX_LABEL"
  mkdir -p "$PREFIX" "$LOGS"
  chown root:wheel "$PREFIX"
  chmod 755 "$PREFIX"
  parts=server
  [ "$vv_new" = no ] || parts="$parts voicevox"
  # 前のものは .old に退けてから入れ替え、入ってから消す (途中で落ちても、前のものが残る)
  for part in $parts; do
    rm -rf "${PREFIX:?}/$part.old"
    if [ -e "$PREFIX/$part" ]; then mv "$PREFIX/$part" "$PREFIX/$part.old"; fi
    mv "new/$part" "$PREFIX/$part" || { mv "$PREFIX/$part.old" "$PREFIX/$part"; die "$PREFIX/$part に置けません"; }
    chown -R root:wheel "$PREFIX/$part"
    rm -rf "${PREFIX:?}/$part.old"
  done

  # VOICEVOX は入れ替えたときと、載っていないときだけ起こし直す (モデルを読むのに時間が掛かる)
  if ! launchctl print "system/$VOICEVOX_LABEL" >/dev/null 2>&1; then mac_register_voicevox; fi
  mac_register_server
  say_login "$envfile"
  say_voicevox_terms
  # sudo の中から開くとブラウザまで root で動くので、ログインしている人として開く
  if [ "$open_browser" = yes ]; then
    user=$(stat -f %Su /dev/console)
    if [ -n "$user" ] && [ "$user" != root ]; then
      launchctl asuser "$(id -u "$user")" sudo -u "$user" open "$URL" || true
    fi
  fi
}

case "$(uname -s)" in
  Linux) linux_main ;;
  Darwin) mac_main ;;
  *) die "対応しているのは Linux と macOS だけです" ;;
esac
