# 台湾の中央氣象署 (CWA) の授権碼

台湾付近の地震 (与那国・沖縄に近い) を、中央氣象署のオープンデータ「顯著有感地震報告」(E-A0015-001) から受ける。
このデータを取るには、会員登録で発行される授権碼 (API の鍵) が要る。
**授権碼が無ければ、CWA の受信だけを切って普通に動く** (受信の状態に「中央氣象署 (台湾)」が「オフ (授権碼がありません)」と出る)。

## 利用条件

- 政府資料開放授權條款 第 1 版 (https://data.gov.tw/license)。CC BY 4.0 と両立し、家族での利用・配り直し・公開のどれも可。
- 出典の表示が要る。画面の出典に「台湾付近の地震: 交通部中央氣象署 (政府資料開放授權條款 第 1 版)」と出している (`src/lib/notice.ts`)。

## 授権碼を取って入れる

1. 中央氣象署 氣象資料開放平臺 (https://opendata.cwa.gov.tw/) を開き、右上の「登入/註冊」から会員登録する。
   メールアドレスで登録できる (Google などのアカウントでも入れる)。確かめのメールが届くので、リンクを開いて登録を終える。
2. ログインして、「取得授權碼」(授権碼を取る) を押す。表示された文字列 (`CWA-` で始まる) が授権碼。
3. 授権碼を sonae に渡す。
   - 1 行のインストーラで入れたなら、`sonae.env` に `CWA_API_KEY=CWA-XXXX...` を書いて流し直す ([install.md](install.md#環境変数を足す-sonaeenv))
   - Helm chart なら、`secrets.name` の Secret に `cwa-api-key` を足す (chart は `optional: true` で読む)
   - 持ち主の本番は `deploy/secrets.sops.yaml` の `sonae-secrets` に `cwa-api-key` を足し (`sops edit deploy/secrets.sops.yaml`。[push.md](push.md#鍵を作って入れる-helm-chart) と同じ)、main にマージする
   - 手元の開発は `compose.override.yml` の `environment` に `CWA_API_KEY=...` を書く
4. 受信の状態の「中央氣象署 (台湾)」が「受信中」になれば動いている。

上の手順のボタンの名前は、オープンデータの平臺の一般的な案内に合わせたもので、実際の画面と違うことがある (2026-11-14 の下調べでは、登録のページの本文を取れなかった)。

## 取り方

- `https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0015-001?Authorization=<授権碼>&format=JSON&limit=10` を 2 分ごとに取る (`src/lib/server/sources/cwa.ts`)。
- 時刻 (`OriginTime`) は台湾の時刻 (UTC+8) で、時差の印が無いので +08:00 として読む。
- 持ち主の本番は 2026-11-15 に授権碼を入れて受信している。テストの fixture (`tests/fixtures/cwa/`) はまだ仕様の項目の名前に合わせて作ったもので、実物の応答に置き換えていない。
