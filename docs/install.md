# 立てる

README の「1 行で入れる」の細かいところ。OS ごとの入れ方と置き場、上げ方と外し方、ログイン・環境変数・VOICEVOX のこと。
Mac と Windows の中身は [install-mac.md](install-mac.md) と [install-windows.md](install-windows.md) に。Kubernetes (Helm chart) は [README](../README.md#kubernetes-に立てる-helm-chart)。

## 1 行で入れる

**clone は要りません。** 立ち上がるとブラウザが開きます (`--no-open`・`-NoOpen` を付けると開かない)。

```sh
curl -fsSL https://raw.githubusercontent.com/danything/sonae/main/install.sh | bash        # Linux
curl -fsSL https://raw.githubusercontent.com/danything/sonae/main/install.sh | sudo bash   # Mac (管理者で)
```

```powershell
irm https://raw.githubusercontent.com/danything/sonae/main/install.ps1 | iex   # Windows (管理者の PowerShell)
```

| OS                              | 動かし方                                                                                                              | 開く URL                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Linux** (x86_64)              | Docker Compose で sonae と VOICEVOX のエンジン (公式のイメージ) を動かす。`~/sonae` に compose.prod.yml を置く        | <http://sonae.localhost> (genkan) か `http://<IP>:3030` |
| **Mac** (Apple Silicon・Intel)  | コンテナを使わず、そのまま。sonae 本体 (配布物の bun とアプリ) と VOICEVOX のエンジンを root の LaunchDaemon に載せる | <http://localhost:3030>                                 |
| **Windows** (x64。10 1809 以降) | コンテナを使わず、そのまま。同じ 2 つを、タスク スケジューラの「起動したら起こす」タスク (SYSTEM) に載せる            | <http://localhost:3030>                                 |

- **もう一度流せば、最新のリリースに上げ直します。** DB・設定・VAPID の鍵はそのまま。VOICEVOX のエンジン (2 GB ほど) は、バージョンが変わったときだけ取り直します
- **外すときは `--uninstall`** (Windows は `-Uninstall`)。止めて、入れたプログラムを外します。**DB と設定 (sonae.env) は残します**

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
- ポートは **3030** (denpa などがよく使う 3000 と重ねない)。どの OS でも LAN に開きます (Linux は Docker が公開するので ufw などのファイアウォールを素通りし、Windows はプライベートとドメインのネットワークだけ開ける)。ログイン (OIDC) を書くまでは `/health` しか答えません。VOICEVOX のエンジンは外に出しません (Linux は compose のネットワークの中だけ、Mac と Windows はループバックの 50121。VOICEVOX のアプリの 50021 とも重ねない)
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

| 名前                                                             | 中身                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `SONAE_VERSION`                                                  | 入れるバージョン (`v0.1.0`)。既定は最新のリリース。Linux は `main` などの git の ref も渡せる (イメージは `latest`) |
| `SONAE_HOME`                                                     | Linux の置き場 (既定 `~/sonae`)                                                                                     |
| `SONAE_VAPID_SUBJECT`                                            | Web Push の連絡先 (`mailto:…` か `https://…`)。初めて入れるときだけ使う。既定はこのリポジトリの URL                 |
| `SONAE_COMPOSE_FILE`・`SONAE_SERVER_TARBALL`・`SONAE_SERVER_ZIP` | 手元の compose ファイル・配布物を使う (CI と開発用)                                                                 |

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

**ログイン (OIDC) の 3 つ (`OIDC_ISSUER`・`OIDC_CLIENT_ID`・`OIDC_CLIENT_SECRET`) が揃うまで、画面は開きません**
(「ログインの設定 (OIDC) がまだです」と出て、`/health` だけ答える)。インストーラはここを決めないので、`sonae.env` に書いてから流し直します。

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
使える名前は [charts/sonae/values.yaml](../charts/sonae/values.yaml) のコメントと [push.md](push.md)・[cwa.md](cwa.md)・[entra.md](entra.md)。

## Web Push の鍵

**VAPID の鍵 (`VAPID_PRIVATE_JWK`) は、無ければインストーラが作ります** ([push.md](push.md) と同じ作り方。P-256 の ECDSA の秘密鍵を JWK に)。
Linux は sonae のイメージの bun で、Mac と Windows は配布物の bun で作るので、ほかに何も入れません。
**一度作ったら替えません** (替えると、どのブラウザの購読にも送れなくなる)。

連絡先 (`VAPID_SUBJECT`) は、既定ではこのリポジトリの URL を書きます。`PUBLIC_URL` が `http://localhost` のままだと配信サービスが受けないためです。
自分の `mailto:…` に替えてかまいません。

Web Push はブラウザが安全な文脈 (https か localhost) でないと使えません。LAN のほかの機器から `http://<IP>:3030` で開いても、通知の登録はできません。
家の外やスマホで受けるなら、https の前段を置いて `PUBLIC_URL` を書きます。

## VOICEVOX

読み上げの声は、sonae と一緒に動かす [VOICEVOX](https://voicevox.hiroshiba.jp/) のエンジンで作ります ([design.md の 2.4](design.md))。
既定の声は「VOICEVOX:剣崎雌雄」で、画面で替えられます。エンジンが止まっているときは、ブラウザの読み上げで同じ文を読みます。

| OS      | 入れるもの                                                                                                  | 取り方                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Linux   | 公式のイメージ `voicevox/voicevox_engine:<版>` (バージョンだけのタグは CPU 用)                              | `docker compose pull`                                                                                    |
| Mac     | 公式のエンジンの Mac 用 CPU 版 (`voicevox_engine-macos-arm64-<版>.vvpp`、Intel は `macos-x64` の分けたもの) | [VOICEVOX/voicevox_engine のリリース](https://github.com/VOICEVOX/voicevox_engine/releases) から直に取る |
| Windows | 公式のエンジンの Windows 用 CPU 版 (`voicevox_engine-windows-cpu-<版>.vvpp`)                                | 同じ                                                                                                     |

- **版は 1 か所で決まります。** [compose.prod.yml](../compose.prod.yml) の `voicevox/voicevox_engine` のタグ (Renovate が上げる。compose.yml と chart の values.yaml もそろえる)。
  Mac と Windows の配布物を組むときに、その版の vvpp の名前と sha256 (GitHub がリリースの添付に付けている digest) を配布物の `voicevox.txt` に書き、
  インストーラはそれを見て取ってきて照らします。いまの版は 0.26.2
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
