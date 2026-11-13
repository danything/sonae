# sonae

地震・津波の情報を家のサーバーで受けて、ブラウザで見たり、Web Push で通知を受けたりするアプリ。
いまは持ち主 1 人で使う (ログインで閉じる。Entra のアプリロールで絞り、既定は `admin`。家族と共有するときは family 用のロールに替える)。ホスト名は `s.doany.io`。

**まだ作っている途中です。** 作りは [docs/design.md](docs/design.md)、画面は [docs/ui.md](docs/ui.md)、地図の層と出典は [docs/map.md](docs/map.md) に書いてある。

- 名前は「備え」から。地震を待つのではなく、来たときに慌てないためのもの。
- [Zero Quake](https://github.com/0Quake/Zero-Quake) の機能を参考にした。コードは読んでも写してもいない (一から書いている)。
- 地震・津波・火山 (噴火速報・噴火警報) の情報を気象庁 (防災情報 XML)・P2P地震情報・Wolfx Project から、海外の地震を USGS・EMSC・GeoNet・中央氣象署 (台湾、授権碼があるとき) から、太平洋の津波の参考情報を PTWC (米国) と気象庁ホームページ (国際津波関連情報) から受け、画面には必ず出典と「公式の情報を優先してください」という注意文を出す。気象庁の情報は加工して出しているので、その旨も書く。

## 開発

依存はホストに入れず、コンテナの中で動かす。

```sh
docker compose up            # https://sonae.localhost (genkan 経由)
docker compose run --rm sonae bun run lint    # oxlint・整形の確かめ (bun fmt --check)
docker compose run --rm sonae bun run check   # 型 (svelte-check --tsgo)
docker compose run --rm sonae bun test tests
docker compose run --rm sonae bun run build
```

docker の代わりに `wslc-compose` でもよい。

手元ではログインを飛ばす (`AUTH_DISABLED=1`、compose.yml)。本番のログインの設定は [docs/entra.md](docs/entra.md)。
Web Push は VAPID の鍵が無ければ切って動く。鍵の作り方と入れ方は [docs/push.md](docs/push.md)。

起動すると気象庁・P2P地震情報・Wolfx・USGS・PTWC・EMSC・気象庁ホームページ (国際津波)・GeoNet (と、授権碼があれば中央氣象署) に実際につなぐ。台湾の中央氣象署の授権碼の取り方は [docs/cwa.md](docs/cwa.md)。画面だけ触りたいときは `SONAE_RECEIVE=off` で止める。

## ライセンス

[AGPL-3.0](LICENSE)
