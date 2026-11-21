# 立てる

Mac と Windows でインストーラがすることと置き場は [install-mac.md](install-mac.md) と [install-windows.md](install-windows.md)。Kubernetes (Helm chart) は [README](../README.md#kubernetes-に立てる-helm-chart)。

## 1 行で入れる

**clone は要りません。** 立ち上がるとブラウザが開きます (Linux は画面のあるときだけ。`--no-open`・`-NoOpen` を付けると開かない)。

```sh
curl -fsSL https://raw.githubusercontent.com/danything/sonae/main/install.sh | bash        # Linux
curl -fsSL https://raw.githubusercontent.com/danything/sonae/main/install.sh | sudo bash   # Mac (管理者で)
```

```powershell
irm https://raw.githubusercontent.com/danything/sonae/main/install.ps1 | iex   # Windows (管理者の PowerShell)
```

| OS                              | 動かし方                                                                                                                       | 開く URL                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **Linux** (x86_64)              | Docker Compose で sonae と VOICEVOX のエンジン (公式のイメージ) を動かす。compose.prod.yml を `~/sonae/compose.yml` として置く | <http://sonae.localhost> (genkan) か `http://<IP>:3030` |
| **Mac** (Apple Silicon・Intel)  | コンテナを使わず、そのまま。sonae 本体 (配布物の bun とアプリ) と VOICEVOX のエンジンを root の LaunchDaemon に載せる          | <http://localhost:3030>                                 |
| **Windows** (x64。10 1809 以降) | コンテナを使わず、そのまま。同じ 2 つを、タスク スケジューラの「起動したら起こす」タスク (SYSTEM) に載せる                     | <http://localhost:3030>                                 |

- **もう一度流せば、最新のリリースに上げ直します。** DB・設定・VAPID の鍵はそのまま。VOICEVOX のエンジン (2 GB ほど) は、バージョンが変わったときだけ取り直します
- **外すときは `--uninstall`** (Windows は `-Uninstall`)。止めて、入れたプログラムを外します (Linux はコンテナを止めて消すだけで、compose のファイルとイメージ・genkan は残します)。**DB と設定 (sonae.env) は残します**

  ```sh
  curl -fsSL https://raw.githubusercontent.com/danything/sonae/main/install.sh | bash -s -- --uninstall        # Linux
  curl -fsSL https://raw.githubusercontent.com/danything/sonae/main/install.sh | sudo bash -s -- --uninstall   # Mac
  ```

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/danything/sonae/main/install.ps1))) -Uninstall
  ```

- **Docker は入れません** (Linux)。無ければ入れ方 (<https://get.docker.com>) を示して止まります
- **入口は [genkan](https://github.com/danything/genkan)** (Linux。ホスト名でコンテナに振り分けるリバースプロキシ)。
  動いていればそれを使い、無ければ 80 と 443 が空いているときだけ `~/genkan` に入れて <http://sonae.localhost> で開きます。
  `*.localhost` はブラウザが安全な文脈として扱うので、そのマシンのブラウザなら Web Push も使えます。LAN のほかの機器からは `http://<IP>:3030`
- ポートは **3030** (denpa などがよく使う 3000 と重ねない)。どの OS でも LAN に開きます (Linux は Docker が公開するので ufw などのファイアウォールを素通りし、Windows はプライベートとドメインのネットワークだけ開ける)。誰が開けるかは下の「ログイン」。VOICEVOX のエンジンは外に出しません (Linux は compose のネットワークの中だけ、Mac と Windows はループバックの 50121。VOICEVOX のアプリの 50021 とも重ねない)
- イメージの `ghcr.io/danything/sonae` は amd64 だけなので、Linux は x86_64 だけです

### 置き場

| OS      | 場所                                                                      | 中身                                                                                                           |
| ------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Linux   | `~/sonae` (`SONAE_HOME` で変えられる)                                     | `compose.yml` (上げ直すたびに上書き)・`compose.override.yml` (手を入れるならここ。あれば触らない)・`sonae.env` |
|         | Docker のボリューム `sonae_sonae-data`                                    | DB (`sonae.db`)                                                                                                |
| Mac     | `/Library/Application Support/sonae/`                                     | `server/` (bun とアプリ)・`voicevox/` (エンジン)・`data/` (DB・`sonae.env`・起こす `sonae.sh`。root だけ)      |
|         | `/Library/LaunchDaemons/io.github.danything.{sonae,sonae-voicevox}.plist` | 起動したら起こし、落ちたら起こし直す                                                                           |
|         | `/Library/Logs/sonae/`                                                    | `sonae.log`・`voicevox.log`                                                                                    |
| Windows | `%ProgramFiles%\sonae\`                                                   | `server\` (bun とアプリ)・`voicevox\` (エンジン)                                                               |
|         | `%ProgramData%\sonae\`                                                    | DB・`sonae.env`・起こす `sonae.cmd`・`voicevox.cmd`・`logs\`。SYSTEM と管理者だけ                              |

### インストーラの環境変数

| 名前                                                                            | 中身                                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `SONAE_VERSION`                                                                 | 入れるバージョン (`v0.1.0`)。既定は最新のリリース。Linux は `main` などの git の ref も渡せる (イメージは `latest`) |
| `SONAE_HOME`                                                                    | Linux の置き場 (既定 `~/sonae`)                                                                                     |
| `SONAE_VAPID_SUBJECT`                                                           | Web Push の連絡先 (`mailto:…` か `https://…`)。初めて入れるときだけ使う。既定はこのリポジトリの URL                 |
| `SONAE_COMPOSE_FILE`・`SONAE_IMAGE`・`SONAE_SERVER_TARBALL`・`SONAE_SERVER_ZIP` | 手元の compose ファイル・イメージ・配布物を使う (CI と開発用)                                                       |

Mac で渡すときは `sudo -E` にします (sudo は環境変数を落とす)。

### 配布物を確かめる

インストーラが照らす `.sha256` は同じリリースに置いてあるので、分かるのはダウンロード中に壊れたことだけです (リリースごと差し替えられたら気づけない)。
Mac と Windows の配布物には、このリポジトリのリリースの workflow が作ったという出所の証明 (attestation) を付けてあるので、気になるときは確かめてから入れます。

```sh
gh attestation verify sonae-0.1.0-windows-x64.zip -R danything/sonae
```

VOICEVOX のエンジンは、sonae のリリースを作ったときに記録した sha256 (配布物の `voicevox.txt`) と照らすので、後から差し替えられても気づけます。
Linux の genkan は、[danything/genkan](https://github.com/danything/genkan) の `init.sh` を流して入れます (同じ持ち主のもの)。

## ログイン

**家の LAN (と、そのマシンのブラウザ) からは、ログインなしで開けます。** インストーラが `sonae.env` に `TRUSTED_NETWORKS` を書くためです (無いときだけ)。

| OS           | 書く `TRUSTED_NETWORKS`                                                 | 開き方                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux        | `192.168.0.0/16,10.0.0.0/8` と、genkan で開くなら genkan のゲートウェイ | <http://sonae.localhost> (genkan) か `http://<IP>:3030`。`http://localhost:3030` は Docker の中継で送信元が Docker の網に見え、通らないことがある |
| Mac・Windows | `127.0.0.0/8,::1/128,192.168.0.0/16,10.0.0.0/8`                         | <http://localhost:3030> か `http://<名前>:3030`                                                                                                   |

> [!WARNING]
> **このネットワークの中の誰でも、設定を変えられます** (読み上げの声・通知の条件・Web Push の購読。ログインしていないので、全員が「家のネットワーク」という 1 人の利用者になる)。
> 家の LAN に知らない人がいるなら、`TRUSTED_NETWORKS` を消して OIDC だけにします。`0.0.0.0/0` (全部) にはしないでください。インターネットに向けて開くのと同じです。

- **http の LAN の IP (`http://192.168.x.x:3030`) で開くと、Web Push は使えません。** ブラウザが安全な文脈 (https か localhost) でしか通知の登録を許さないためです。
  その端末で通知を受けるなら、そのマシンのブラウザで localhost (Linux は sonae.localhost) か、https の前段を置いて開きます
- **アドレスに加えて、名前も見ます** (DNS リバインディング除け。悪いサイトが自分の名前を LAN の sonae の IP に向け直しても通さない)。
  ログインなしで通すのは、IP の直書き・`localhost`・ドットの無い名前 (`nas:3030`)・家の中だけの名前 (`.localhost`・`.local`・`.lan`・`.home.arpa`・`.internal`) と、`ALLOWED_HOSTS` に書いた名前 (カンマ区切り。`.example.com` でその下も) だけです。
  自分のドメインや Tailscale の名前 (`.tail1234.ts.net`) で開くなら `ALLOWED_HOSTS` に書きます
- **Docker のネットワーク (`172.16.0.0/12`) は入れません。** 前段 (genkan など) 越しの人が全員当たってしまうためです。前段の後ろに置くなら、前段のアドレスを `TRUSTED_PROXIES` に書きます
  (直の相手がそこのときだけ `X-Forwarded-For` を読む)。genkan に登録したときは、install.sh が `compose.override.yml` に書きます。
  adapter-bun の `ADDRESS_HEADER` を書くと、信頼するネットワークは効きません (そのヘッダは誰でも名乗れるため)
- 断ったときは 403 と理由 (接続元のアドレス) を返します。LAN が別の範囲 (`172.16.0.0/12` など) なら、その範囲を足します

**家の外からも開くなら、ログイン (OIDC) を足します。** 3 つ (`OIDC_ISSUER`・`OIDC_CLIENT_ID`・`OIDC_CLIENT_SECRET`) が揃うと、信頼するネットワークの外の人はログインして開きます (中の人はログインなしのまま)。
`TRUSTED_NETWORKS` も OIDC も無ければ、画面は開かず `/health` だけ答えます (Helm chart の既定はこれで、OIDC だけ)。

1. IdP にクライアントを作り、リダイレクト URI `<開く URL>/auth/callback` を登録する (Entra ID なら [entra.md](entra.md))。
   ロール `admin` (`OIDC_ROLE` で替えられる) を持つ人だけが開ける
2. `sonae.env` の `# OIDC_ISSUER=` などの行の `#` を外して書く
3. インストーラを流し直す (Linux は `cd ~/sonae && docker compose up -d` でもよい)

## 環境変数を足す (`sonae.env`)

**手で書き足すのは `sonae.env` です。** インストーラは無いときだけ雛形を作り、あとは触りません (VAPID の鍵の行が無ければ足すだけ)。
秘密 (VAPID の鍵・OIDC のクライアントシークレット) が入るので、本人だけ (Linux)・root だけ (Mac)・SYSTEM と管理者だけ (Windows) が読めるようにしてあります。
1 行に `KEY=値` で、値は引用符で囲まずに書きます。**BOM の無い UTF-8** で保存します (Windows のメモ帳は「UTF-8」を選ぶ。「UTF-8 (BOM 付き)」だと 1 行目が読めない)。
Windows は cmd が読むので、値に `"`・`&`・`^`・`%` を入れると崩れることがあります (OIDC のクライアントシークレットに入っていたら、作り直すのが確か)。

置き場・ポート・VOICEVOX の宛先はインストーラが決めるので、書いても効きません (Linux は `compose.override.yml` で変えられる)。

| 名前                                                       | 中身                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUSTED_NETWORKS`・`ALLOWED_HOSTS`・`TRUSTED_PROXIES`     | ログインなしで開ける範囲 (上の「ログイン」)                                                                                                                                                                                                                                                           |
| `OIDC_ISSUER`・`OIDC_CLIENT_ID`・`OIDC_CLIENT_SECRET` など | ログイン ([entra.md](entra.md))                                                                                                                                                                                                                                                                       |
| `PUBLIC_URL`                                               | 外から https で開くときの URL。ログインの戻り先と Webhook の本文のリンクに使う                                                                                                                                                                                                                        |
| `VAPID_PRIVATE_JWK`・`VAPID_SUBJECT`                       | Web Push の鍵と連絡先 (下の「Web Push の鍵」と [push.md](push.md))                                                                                                                                                                                                                                    |
| `CWA_API_KEY`                                              | 台湾の中央氣象署の授権碼 ([cwa.md](cwa.md))。無ければ中央氣象署の受信だけを切る                                                                                                                                                                                                                       |
| `MSIL_API_KEY`                                             | 海しる (海上保安庁) の API のキー ([design.md の 2.11](design.md#211-海しるの点の層-海底地殻変動観測点海域火山))。無ければ海しるの点の層 (海底地殻変動観測点・海域火山) だけを出さない                                                                                                                |
| `SONAE_ROAD_GEOJSON`                                       | 災害時の通行止めの予備。国土交通省 道路局のページで自動で見つからない災害の「通れるマップ」の GeoJSON の URL (https の `*.go.jp`。カンマか空白で区切る)。見つけたものと合わせて、サーバーが 30 分ごとに取り、地図に出す。ふつうは書かなくてよい ([design.md の 2.12](design.md#212-災害時の通行止め)) |
| `SONAE_ROAD_DISCOVER=off`                                  | 災害時の通行止めを、国土交通省 道路局のトップページから自動で見つけない (既定は 3 時間ごとに読んで見つける)。`SONAE_ROAD_GEOJSON` も無ければ、通行止めは何もしない ([design.md の 2.12](design.md#212-災害時の通行止め))                                                                              |
| `SONAE_TRAINING=on`                                        | 緊急地震速報の訓練・試験も一覧と地図に出す。既定は出さない。出しても音・読み上げ・通知・Web Push・Webhook では知らせない ([design.md の 2.2](design.md#22-正規化したイベントのモデル))                                                                                                                |
| `SONAE_TREM=off`                                           | 台湾の観測点の揺れ (ExpTech の TREM-RTS) を受けない。商用で立てて ExpTech の同意が無いときは切る ([README の「ライセンス」](../README.md#ライセンス))                                                                                                                                                 |
| `SONAE_SEISJS=off`                                         | 有志の観測点の揺れ (Wolfx SeisJS) を受けない。受けると 1 日 800MB ほど使うので、回線の量が気になるときは切る ([design.md の 2.10](design.md#210-有志の観測点の揺れ-wolfx-seisjs))                                                                                                                     |
| `SONAE_TIDE_PROBE=off`                                     | 津波・大きな地震・波浪警報の間に、気象庁の潮位観測情報の遅れを測らない ([design.md の「情報源の判断」にある「測り直し」](design.md#情報源の判断))                                                                                                                                                     |
| `SONAE_RECEIVE=off`                                        | 情報源につながない (画面だけ触りたいとき)                                                                                                                                                                                                                                                             |

読み上げの声と通知の条件・Webhook は環境変数では決めず、画面の「通知」で選びます (声を選んでいなければ剣崎雌雄で読む)。
前の `VOICEVOX_SPEAKER` (chart の `sonae.voicevoxSpeaker`) は読みません。

## Web Push の鍵

**VAPID の鍵 (`VAPID_PRIVATE_JWK`) は、無ければインストーラが作ります** ([push.md](push.md) と同じ作り方。P-256 の ECDSA の秘密鍵を JWK に)。
Linux は sonae のイメージの bun で、Mac と Windows は配布物の bun で作るので、ほかに何も入れません。
**一度作ったら替えません** (替えると、どのブラウザの購読にも送れなくなる)。

連絡先 (`VAPID_SUBJECT`) は、既定ではこのリポジトリの URL を書きます。sonae は `VAPID_SUBJECT` が無ければ `PUBLIC_URL` を使いますが、`http://localhost` では配信サービスが受けないためです。
自分の `mailto:…` に替えてかまいません。

家の外やスマホで受けるなら、https の前段を置いて `PUBLIC_URL` を書きます (`http://<IP>:3030` では通知を登録できない。上の「ログイン」)。

## VOICEVOX

読み上げの声は、sonae と一緒に動かす [VOICEVOX](https://voicevox.hiroshiba.jp/) のエンジンで作ります ([design.md の 2.4 の「読み上げ」](design.md#読み上げ-voicevox))。
既定の声は「VOICEVOX:剣崎雌雄」で、画面で替えられます。エンジンが止まっているときは、ブラウザの読み上げで同じ文を読みます。

| OS      | 入れるもの                                                                                                          | 取り方                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Linux   | 公式のイメージ `voicevox/voicevox_engine:<バージョン>` (バージョンだけのタグは CPU 用)                              | `docker compose pull`                                                                                    |
| Mac     | 公式のエンジンの Mac 用 CPU 版 (`voicevox_engine-macos-arm64-<バージョン>.vvpp`、Intel は `macos-x64` の分けたもの) | [VOICEVOX/voicevox_engine のリリース](https://github.com/VOICEVOX/voicevox_engine/releases) から直に取る |
| Windows | 公式のエンジンの Windows 用 CPU 版 (`voicevox_engine-windows-cpu-<バージョン>.vvpp`)                                | 同じ                                                                                                     |

- **バージョンは 1 か所で決まります。** [compose.prod.yml](../compose.prod.yml) の `voicevox/voicevox_engine` のタグ (Renovate が上げる。compose.yml と chart の values.yaml もそろえる)。
  Mac と Windows の配布物を組むときに、そのバージョンの vvpp の名前と sha256 (GitHub がリリースの添付に付けている digest) を配布物の `voicevox.txt` に書き、
  インストーラはそれを見て取ってきて照らします。いまのバージョンは 0.26.2
- vvpp は VOICEVOX のプラグインの形で、中身はエンジン (`run`・`run.exe`) をそのまま zip にしたものです。2 GB ほどあり、開くのに 6 GB ほど空きが要ります
- **sonae は VOICEVOX を再配布しません。** 配布物にエンジンは入れず、利用者の機械が公式のリリースから直に取ります
- エンジンは CPU で合成します (GPU 版は使わない)。ユーザー辞書 (地名の読み) は sonae がつながるたびに足します

### ライセンスと規約

| もの                    | ライセンス・規約                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VOICEVOX ENGINE         | LGPL v3 と、ソースの公開の要らない別のライセンスのデュアルライセンス ([LICENSE](https://github.com/VOICEVOX/voicevox_engine/blob/master/LICENSE))。sonae は別のプロセスとして HTTP で使うだけ |
| VOICEVOX CORE           | MIT ([voicevox_core](https://github.com/VOICEVOX/voicevox_core))。エンジンの中に入っている                                                                                                    |
| VOICEVOX (ソフトウェア) | [利用規約](https://voicevox.hiroshiba.jp/term/)。商用・非商用を問わず使え、「VOICEVOX を利用したことがわかるクレジット表記が必要」。無断の再配布はできない                                    |
| 声 (音声ライブラリ)     | キャラクターごとの規約。既定の剣崎雌雄は [『VOICE VOX剣崎雌雄』利用規約](https://frontier.creatia.cc/fanclubs/413/posts/4507)。クレジットは「VOICEVOX:剣崎雌雄」                              |

sonae の画面は、出典と注意の窓に、読んでいる声のクレジット (「VOICEVOX:剣崎雌雄」など) を出します。
声を替えたときは、その声のキャラクターの規約に従ってください (VOICEVOX の [キャラクター一覧](https://voicevox.hiroshiba.jp/) から辿れます)。
エンジンに入っている各声の規約の要約は、エンジンの `/speakers` と `engine_manifest.json`・`licenses.json` (置き場の `voicevox/` の下) にもあります。

## うまくいかないとき

- Linux: `cd ~/sonae && docker compose logs sonae voicevox`
- Mac: `/Library/Logs/sonae/sonae.log`・`voicevox.log`。止める・起こすは `sudo launchctl kickstart -k system/io.github.danything.sonae`
- Windows: `%ProgramData%\sonae\logs\sonae.log`・`voicevox.log`。タスク スケジューラの `sonae`・`sonae-voicevox`
- 読み上げが端末の声になる: VOICEVOX のエンジンがまだモデルを読んでいる (起きてから 1 分ほど)。sonae は 60 秒ごとにつなぎ直す
