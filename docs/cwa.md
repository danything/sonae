# 台湾の中央氣象署 (CWA) の授権碼

台湾付近の地震 (与那国・沖縄に近い) を、中央氣象署のオープンデータ「顯著有感地震報告」(E-A0015-001) から受ける。
このデータを取るには、会員登録で発行される授権碼 (API の鍵) が要る。
**授権碼が無ければ、CWA の受信だけを切って普通に動く** (状態の欄にも出ない。ログに「授権碼 (CWA_API_KEY) が無いので…」と出る)。

## 利用条件

- 政府資料開放授權條款 第 1 版 (https://data.gov.tw/license)。CC BY 4.0 と両立し、家族での利用・配り直し・公開のどれも可。
- 出典の表示が要る。画面の出典に「台湾付近の地震: 交通部中央氣象署 (政府資料開放授權條款 第 1 版)」と出している (`src/lib/notice.ts`)。

## 登録の手順 (持ち主がすること)

1. 中央氣象署 氣象資料開放平臺 (https://opendata.cwa.gov.tw/) を開き、右上の「登入/註冊」から会員登録する。
   メールアドレスで登録できる (Google などのアカウントでも入れる)。確かめのメールが届くので、リンクを開いて登録を終える。
2. ログインして、「取得授權碼」(授権碼を取る) を押す。表示された文字列 (`CWA-` で始まる) が授権碼。
3. 授権碼を Secret に入れる。`deploy/secrets.sops.yaml` の `sonae-secrets` に `cwa-api-key` を足す (ほかの鍵と同じく SOPS で暗号化する)。

   ```sh
   sops deploy/secrets.sops.yaml   # stringData に cwa-api-key: CWA-XXXX... を足して保存
   ```

4. main にマージすると Argo CD が反映し、Pod が作り直されると `CWA_API_KEY` が入って受信が始まる
   (`deploy/deployment.yaml` で `optional: true` で読んでいる)。状態の欄に「中央氣象署 (台湾)」が出れば動いている。
5. 手元で試すときは `compose.override.yml` の `environment` に `CWA_API_KEY=...` を書く。

登録のページの文言は 2026-11-14 には読めなかった (下調べのときにページの本文を取れなかった)。上の手順のボタンの名前は、
オープンデータの平臺の一般的な案内に合わせたもので、実際の画面と違うことがある。

## 取り方

- `https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0015-001?Authorization=<授権碼>&format=JSON&limit=10` を 2 分ごとに取る (`src/lib/server/sources/cwa.ts`)。
- 時刻 (`OriginTime`) は台湾の時刻 (UTC+8) で、時差の印が無いので +08:00 として読む。
- 授権碼が無いので、**実物の応答では確かめていない**。テストの fixture (`tests/fixtures/cwa/`) は仕様の項目の名前に合わせて作ったもの。
  授権碼を入れて動かしたら、実物を取って fixture を置き換え、読めることを確かめる。
