# Mac に入れる

**sonae 本体も VOICEVOX のエンジンも、Mac の上でそのまま動かします** (コンテナも Docker も使わない)。Apple Silicon と Intel の両方で動きます。

```sh
curl -fsSL https://raw.githubusercontent.com/danything/sonae/main/install.sh | sudo bash
```

管理者のパスワードを聞かれます。誰もログインしていなくても動くように、**root の LaunchDaemon** に載せるためです。
終わると <http://localhost:3030> が開きます。もう一度流せば最新のリリースに上げ直し、`sudo bash -s -- --uninstall` で外します (DB と設定は残す)。
共通のこと (ログイン・環境変数・VAPID の鍵・VOICEVOX の規約) は [install.md](install.md)。

## していること

1. 最新のリリースの `sonae-<バージョン>-darwin-<arm64|x64>.tar.gz` と `.sha256` を取って照らす。中身は bun (公式のリリース)・ビルドしたアプリ・VOICEVOX の取り方 (`voicevox.txt`)・ライセンス
2. `voicevox.txt` の版の VOICEVOX のエンジン (Mac の CPU 版の vvpp。Apple Silicon は 1 つ、Intel は 2 つに分けたもの) を
   [VOICEVOX/voicevox_engine のリリース](https://github.com/VOICEVOX/voicevox_engine/releases) から取り、sha256 を照らして開く (2 GB ほど。入っている版と同じなら取らない)
3. **揃ってから止める** (取ってこられなかったら、動いているものに触らない)。`server/` (と、取り直したときは `voicevox/`) を入れ替える
4. `data/sonae.env` が無ければ雛形を作り、VAPID の鍵が無ければ配布物の bun で作る
5. LaunchDaemon を載せて、`/health` が答えるまで待つ。ログインしている人のブラウザで開く

| 場所                                                              | 中身                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `/Library/Application Support/sonae/server/`                      | `bun`・`app/` (package.json と build/)・`voicevox.txt`・`licenses/`               |
| `/Library/Application Support/sonae/voicevox/`                    | VOICEVOX のエンジン (`run` と model/ など)・入れた版 (`VERSION`)                  |
| `/Library/Application Support/sonae/data/`                        | `sonae.db`・`sonae.env`・本体を起こす `sonae.sh`。root だけが読み書きできる (700) |
| `/Library/LaunchDaemons/io.github.danything.sonae.plist`          | sonae 本体 (`sonae.sh`)。起動したら起こし、落ちたら起こし直す                     |
| `/Library/LaunchDaemons/io.github.danything.sonae-voicevox.plist` | VOICEVOX のエンジン (`run --host 127.0.0.1 --port 50121`)                         |
| `/Library/Logs/sonae/`                                            | `sonae.log`・`voicevox.log`                                                       |

- 本体は `0.0.0.0:3030` で待ち受けます (LAN のほかの機器からは `http://<名前>.local:3030`)。VOICEVOX はループバックの 50121 だけ
- VOICEVOX のエンジンのユーザーデータ (辞書) は root のホームの下 (`/var/root/Library/Application Support/`) にできます。sonae がつながるたびに足すので、消えても困りません
- curl で取ったファイルには「インターネットから来た」印が付かないので、Gatekeeper に止められません

## 環境変数を足す (`sonae.env`)

```sh
sudo nano "/Library/Application Support/sonae/data/sonae.env"
# 書いたら流し直す (または sudo launchctl kickstart -k system/io.github.danything.sonae)
```

置き場 (`SONAE_DATA`)・ポート・VOICEVOX の宛先は `sonae.sh` が決めるので、書いても効きません。書き方は [install.md](install.md#環境変数を足す-sonaeenv)。

## Linux と違うところ

- ポートの 3030 は Mac が直に開けます (genkan は使わない)。そのマシンのブラウザは <http://localhost:3030> で、Web Push も使えます
- 本体は root で動きます (denpa の Mac 版と同じ。誰もログインしていなくても動かすため)

## 確かめたこと

CI (`.github/workflows/installers.yml` の `install-macos`。GitHub の macOS のランナー、Apple Silicon) で、リリースと同じ組み方の配布物を渡して流し、
`/health` が答える・OIDC が無いと画面は 503・VAPID の鍵ができて Web Push が有効になる・VOICEVOX のエンジンが既定の声 (剣崎雌雄) で合成できる・
sonae がエンジンにつながる・上げ直しても鍵が替わらない・外しても DB と `sonae.env` が残る、までを見ています。
Intel の Mac と、実機の Mac ではまだ流していません。
