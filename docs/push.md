# Web Push の運用

作りと決めごとは [design.md の 2.4](design.md#24-web-push)。ここには鍵の作り方・入れ方と、確かめ方を書く。

## 鍵が無いとき

VAPID の鍵 (`VAPID_PRIVATE_JWK`) が無ければ、**Web Push だけを切って普通に動く**。
ヘッダーの「通知」(スマホの形は「その他」の「通知」)を開くと「鍵が入っていない」と出て、登録は受けない。受信・画面・SSE は変わらない。
起動の記録に `[push] VAPID の鍵 (VAPID_PRIVATE_JWK) が無いので、Web Push は切ってあります` と出る。

## 環境変数

| 名前                | 中身                                                                                     | 既定         |
| ------------------- | ---------------------------------------------------------------------------------------- | ------------ |
| `VAPID_PRIVATE_JWK` | VAPID の秘密鍵 (P-256 の ECDSA の秘密鍵を JWK にした JSON)。公開鍵はここの x・y から作る | 無し (切る)  |
| `VAPID_SUBJECT`     | 配信サービス (FCM・Mozilla・Apple) が困ったときの連絡先。`https://...` か `mailto:...`   | `PUBLIC_URL` |

鍵が読めない (JSON でない・P-256 でない)、または連絡先が https でも mailto でもないときも、理由を記録に出して切る。

## 鍵を作って入れる (持ち主がする)

鍵はリポジトリに平文で置かない。SOPS で暗号化した `deploy/secrets.sops.yaml` の `sonae-secrets` に入れる。
`deploy/deployment.yaml` はもう `vapid-private-jwk` を `optional: true` で読む形になっているので、マニフェストは直さなくてよい。

1. 鍵を作る (ホストに何も入れず、Bun のコンテナの中で WebCrypto を使う。出た 1 行が秘密鍵):

   ```sh
   wslc run --rm oven/bun:1.4.4 bun -e 'const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]); console.log(JSON.stringify(await crypto.subtle.exportKey("jwk", k.privateKey)))'
   ```

   `{"crv":"P-256","d":"...","ext":true,"key_ops":["sign"],"kty":"EC","x":"...","y":"..."}` の形が出る。

2. 管理者の鍵で `deploy/secrets.sops.yaml` を開き、`sonae-secrets` の `stringData` に足す (gitops の `tools/t sops edit` でもよい):

   ```sh
   sops edit deploy/secrets.sops.yaml
   ```

   ```yaml
   - name: sonae-secrets
     stringData:
       oidc-client-secret: ...
       vapid-private-jwk: '{"crv":"P-256","d":"...","ext":true,"key_ops":["sign"],"kty":"EC","x":"...","y":"..."}'
   ```

3. ブランチで commit して PR を作り、マージする。Argo CD が同期し、sops-secrets-operator が Secret を直し、
   Reloader が Pod を入れ替える。記録に `[push] Web Push を送ります` が出れば入っている:

   ```sh
   kubectl -n sonae logs deploy/sonae | grep '\[push\]'
   ```

4. <https://s.doany.io> を開き、ヘッダーの「通知」(スマホの形は「その他」の「通知」)→「このブラウザで受ける」→「試しに送る」で届くか見る。
   iPhone・iPad は、Safari の共有ボタンから「ホーム画面に追加」した sonae (iOS 16.4 以降) で開いてからにする。

手元で試すときは、`compose.override.yml` に `VAPID_PRIVATE_JWK` と `VAPID_SUBJECT` (`mailto:...`。手元の
`PUBLIC_URL` は https でないことが多い) を書く。

## 鍵を替えるとき

鍵を替えると、前の鍵で作った購読には送れなくなる (配信サービスが 401・403 を返す。消すのは 404・410 だけ
なので、購読は残る)。それぞれのブラウザで「通知」を開き直すと、公開鍵が違うことに気づいて購読を作り直す。
使わなくなった購読は、「通知」の「ほかのブラウザ」から解除する。

## 届かないとき

- 記録の `[push] 送れませんでした (<配信サービス>, <状態>)` を見る。404・410 は購読が切れたので、自分で消している。
- 受け付ける配信サービスは FCM (Chrome・Edge)・Mozilla (Firefox)・Apple (Safari)・WNS だけ (`src/lib/server/push.ts` の `PUSH_HOSTS`)。
  ほかのブラウザで「購読の形が違うか、知らない配信サービスです」と出たら、ここに足す。
- 端末の側で知らせが止められていないか (OS の集中モード・ブラウザのサイトの設定)。
