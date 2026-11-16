# Windows に入れる

**sonae 本体も VOICEVOX のエンジンも、Windows の上でそのまま動かします** (WSL も Docker Desktop も使わない)。x64 の Windows 10 1809 / Windows Server 2019 以降で動きます。

```powershell
irm https://raw.githubusercontent.com/danything/sonae/main/install.ps1 | iex
```

**管理者の PowerShell で流します** (スタートボタンを右クリックして「ターミナル (管理者)」)。誰もログインしていなくても動くように、
タスク スケジューラの「起動したら起こす」タスクに **SYSTEM で**載せるためです。終わると <http://localhost:3030> が開きます。

引数を渡すときはこの書き方です。`-NoOpen` (ブラウザを開かない)・`-Uninstall` (止めて外す。DB と設定は残す)。

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/danything/sonae/main/install.ps1))) -Uninstall
```

もう一度流せば最新のリリースに上げ直します。共通のこと (ログイン・環境変数・VAPID の鍵・VOICEVOX の規約) は [install.md](install.md)。

## していること

1. 最新のリリースの `sonae-<バージョン>-windows-x64.zip` と `.sha256` を取って照らす。中身は bun (公式のリリースの baseline。AVX2 の無い CPU でも動く)・ビルドしたアプリ・VOICEVOX の取り方 (`voicevox.txt`)・ライセンス
2. `voicevox.txt` のバージョンの VOICEVOX のエンジン (`voicevox_engine-windows-cpu-<バージョン>.vvpp`) を
   [VOICEVOX/voicevox_engine のリリース](https://github.com/VOICEVOX/voicevox_engine/releases) から取り、sha256 を照らして開く (2 GB ほど。入っているバージョンと同じなら取らない)
3. **揃ってから止める** (取ってこられなかったら、動いているものに触らない)。`server\` (と、取り直したときは `voicevox\`) を入れ替える
4. `%ProgramData%\sonae` を SYSTEM と管理者だけにし、`sonae.env` が無ければ雛形を作り、VAPID の鍵が無ければ配布物の bun で作る
5. タスク (`sonae`・`sonae-voicevox`) を載せ、ファイアウォールでポート 3030 をプライベートとドメインのネットワークにだけ開ける。`/health` が答えるまで待って、ログインしている人のブラウザで開く

| 場所                             | 中身                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `%ProgramFiles%\sonae\server\`   | `bun.exe`・`app\` (package.json と build\)・`voicevox.txt`・`licenses\`                     |
| `%ProgramFiles%\sonae\voicevox\` | VOICEVOX のエンジン (`run.exe` と model\ など)・入れたバージョン (`VERSION`)                |
| `%ProgramData%\sonae\`           | `sonae.db`・`sonae.env`・起こす `sonae.cmd` と `voicevox.cmd`・`logs\`。SYSTEM と管理者だけ |

- `.cmd` は落ちたら 5 秒置いて起こし直します。`sonae.env` は起こすたびに読み直します
- 本体は `0.0.0.0:3030` で待ち受けます (LAN のほかの機器からは `http://<PC の名前>:3030`。開けないときは、この PC のネットワークを「プライベート」に)。VOICEVOX はループバックの 50121 だけ
- VOICEVOX のエンジンのユーザーデータ (辞書) は SYSTEM のプロファイルの下にできます。sonae がつながるたびに足すので、消えても困りません

## 環境変数を足す (`sonae.env`)

管理者のメモ帳で `%ProgramData%\sonae\sonae.env` を開いて書き、install.ps1 を流し直すか Windows を再起動します。
置き場・ポート・VOICEVOX の宛先は `sonae.cmd` が決めるので、書いても効きません。書き方は [install.md](install.md#環境変数を足す-sonaeenv)。

## 確かめたこと

CI (`.github/workflows/installers.yml` の `install-windows`。GitHub の Windows のランナー) で、リリースと同じ組み方の配布物を渡して Windows PowerShell 5.1 で流し、
`/health` が答える・ループバックからはログインなしで開け、知らない名前では 403・VAPID の鍵ができて Web Push が有効になる・VOICEVOX のエンジンが既定の声 (剣崎雌雄) で合成できる・
sonae がエンジンにつながる・上げ直しても鍵が替わらない・外しても DB と `sonae.env` が残る、までを見ています。
実機の Windows ではまだ流していません。
