# Web Push の運用

作りと決めごとは [design.md の 2.4](design.md#24-web-push)。ここには鍵の作り方・入れ方と、確かめ方を書く。Discord・Slack などへ送る [Webhook](#webhook) も、ここに書く。

## 鍵が無いとき

VAPID の鍵 (`VAPID_PRIVATE_JWK`) が無ければ、**Web Push だけを切って普通に動く**。
ヘッダーの「通知」(スマホの形は下のタブの「通知」)を開くと「鍵が入っていない」と出て、登録は受けない。受信・画面・SSE は変わらない。
起動の記録に `[push] VAPID の鍵 (VAPID_PRIVATE_JWK) が無いので、Web Push は切ってあります` と出る。

## 環境変数

| 名前                | 中身                                                                                     | 既定         |
| ------------------- | ---------------------------------------------------------------------------------------- | ------------ |
| `VAPID_PRIVATE_JWK` | VAPID の秘密鍵 (P-256 の ECDSA の秘密鍵を JWK にした JSON)。公開鍵はここの x・y から作る | 無し (切る)  |
| `VAPID_SUBJECT`     | 配信サービス (FCM・Mozilla・Apple) が困ったときの連絡先。`https://...` か `mailto:...`   | `PUBLIC_URL` |

鍵が読めない (JSON でない・P-256 でない)、または連絡先が https でも mailto でもないときも、理由を記録に出して切る。

## 鍵を作って入れる (持ち主がする)

1 行で入れたとき (install.sh・install.ps1) は、インストーラが同じ作り方で鍵を作って `sonae.env` に書く ([install.md の「Web Push の鍵」](install.md#web-push-の鍵))。ここに書くのは Helm chart で立てたときの手順。

鍵はリポジトリに平文で置かない。SOPS で暗号化した `deploy/secrets.sops.yaml` の `sonae-secrets` に入れる。
Helm chart (`charts/sonae`) はもう `vapid-private-jwk` を `optional: true` で読む形になっているので、マニフェストは直さなくてよい。

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

4. <https://s.doany.io> を開き、ヘッダーの「通知」(スマホの形は下のタブの「通知」)→「このブラウザで受ける」→「試しに送る」で届くか見る。
   iPhone・iPad は、Safari の共有ボタンから「ホーム画面に追加」した sonae (iOS 16.4 以降) で開いてからにする。

手元で試すときは、`compose.override.yml` に `VAPID_PRIVATE_JWK` と `VAPID_SUBJECT` (`mailto:...`。手元の
`PUBLIC_URL` は https でないことが多い) を書く。

## 住んでいる地域

「通知」の「住んでいる地域」で、市町村を 1 つ選ぶ。種類ごとの範囲 (「全国のものを知らせる」/「住んでいる地域と現在地のものだけ」/「知らせない」) の「住んでいる地域」に、どの種類にも使う (地震・緊急地震速報は細分区域、津波は沿岸の津波予報区、火山は市町村、気象は市町村と府県予報区・一次細分区域で照らす)。決まりと、範囲ごとに何を知らせるかの表は [design.md の 2.4](design.md#24-web-push)。

- Web Push と Webhook はタブを閉じていても届くので、サーバーが購読の条件として市町村を覚える。覚えるのは市町村等のコードと名前、そこから引いた地震情報／細分区域・府県予報区・一次細分区域・沿岸の津波予報区だけ
- 「現在地から選ぶ」は端末の位置を 1 回だけ取り、端末の中で入る市町村を探す。緯度・経度はサーバーに送らない
- 地図を右クリック (スマホは長押し) して「ここを住んでいる地域にする」でも選べる。押した所が入る市町村を同じ道 (`#lib/push-client.ts` の `homeAt`) で探し、同じ関数 (`saveHome`。端末に覚え、Web Push に登録してあればサーバーへ順に送る) で覚える。海の上や日本の外では変えない ([map.md](map.md) の「地図のメニュー」)
- 決まった住んでいる地域は、地図で水色の破線で縁取る
- 選んでいないと、「住んでいる地域と現在地のものだけ」は開いている画面の現在地だけで見る。Web Push と Webhook には、どこに出ても知らせるもの (大津波警報・噴火警報 (居住地域)・気象の特別警報・電文に地域の無い緊急地震速報の予報など) だけが届く
- 気象の注意報は、住んでいる地域のものを購読ごとに日本時間の 1 日 1 回まで送る。数えた日は購読の控え (`push_log`) に持つ。開いている画面は住んでいる地域と現在地を別に数え、住んでいる地域の数え方は Web Push と同じ ([design.md の 2.4](design.md#24-web-push) の気象の項)
- 開いている間は、地図の現在地 (既定でオン) が入る市町村も「住んでいる地域と現在地」に使う。別の市町村に入ったら、そこにもう出ている警報・津波・噴火警報を 1 度知らせ、出た市町村の気象の通知も解除・続報で置き換える。現在地は端末の中で市町村にするだけで、サーバーに送らない。Web Push と Webhook には使わない ([design.md の 2.4](design.md#24-web-push) の「範囲の「現在地」」)
- 2026-11-16 より前に選んだ住んでいる地域は、津波予報区を持たない (その間は、津波はどの予報区でも当たるとみなす)。各ブラウザで「通知」を開くと、表から引き直してサーバーと Webhook にも送り直す
- 前の「現在地 (地震情報の地域)」は読まないので、更新した後は各ブラウザで選び直す (条件は選んだときに覚える)
- 市町村の表と面は気象庁のデータから作る (`tools/areas/build-weather.sh`、[map.md](map.md))。沿岸の津波予報区は気象庁の「津波予報区に対応する沿岸の市町村対応表」を書き写したもの (`tools/areas/tsunami-cities.tsv`)。気象庁が区域や対応表を変えたら作り直す

## 開いているときの通知と二重に鳴らさないこと

sonae を開いている間は、画面も SSE で受けて OS の通知を出す (「通知」の「開いているとき」の「OS の通知を出す」。通知の許可があれば既定でオン)。
このブラウザが Web Push にも登録してあると、同じ事象が SSE と Web Push の両方で届き、どちらも同じ tag・見出し・本文の通知を出そうとする。
後から出すほうが `getNotifications({ tag })` で同じ中身の通知がもう出ていないかを見て、出ていれば Service Worker は鳴らさずに置き換え (`renotify: false`・`silent: true`)、画面は出さない。
決めた理由と、2 度鳴ることが残る場合は [design.md の 2.4](design.md#24-web-push) の「Web Push と二重に鳴らさない」。

## Webhook

Discord や Slack の Incoming Webhook へも、Web Push と同じ報を同じ見出しと本文で送る。作りと決めごとは [design.md の 2.4](design.md#24-web-push) の「Webhook」。
VAPID の鍵は要らない (鍵が無くて Web Push を切っているときも送る)。環境変数も要らないが、`PUBLIC_URL` があれば本文の末尾に、押すとその報を開く URL を付ける。

1. 送り先で URL を作る。
   - Discord: チャンネルの設定 →「連携サービス」→「ウェブフック」→「新しいウェブフック」→「ウェブフック URL をコピー」(`https://discord.com/api/webhooks/...`)
   - Slack: Slack のアプリを作り、「Incoming Webhooks」をオンにして、送るチャンネルを選ぶ (`https://hooks.slack.com/services/...`)
   - ほか (Home Assistant など): JSON の POST を受ける URL。http でもよい (家の中の送り先のため)
2. sonae の「通知」を開き、「Webhook (Discord・Slack など)」に URL を入れて「追加」を押す。
3. 「試しに送る」で届くか見る。「直近の結果」に、最後に送った結果 (「成功」か、HTTP の状態や「時間切れです」) が出る。

- **条件は「通知」の条件を使う。** 足したときの条件で送り、その後に「通知」の条件を変える (地図のメニューで住んでいる地域を変えるのも同じ) と、その人の Webhook 全部にも使う。ブラウザごとに条件が違うときは、最後に変えたブラウザの条件になる
- **URL は秘密** (知っていれば誰でも投稿できる)。足した後は、画面にも記録にも送り先のホスト (`discord.com` など) だけを出す。URL を見返す道は無いので、替えるときは足し直して前のものを「解除」する
- 送り先は 1 人 10 まで。「試しに送る」は 1 人 10 分に 5 回まで
- 送り直しはしない。送れなかったら、次の続報を初めての通知として送る (Web Push と同じ)
- 気象の注意報だけの通知は、Webhook ごとに日本時間の 1 日 1 回まで (Web Push の購読ごとと同じ数え方)。前に送った注意報の続報 (種類が増えた・見出しが変わった) は、新しい投稿になって 1 日 1 回を超えるので送らない。警報以上に上がったものと解除は送る ([design.md の 2.4](design.md#24-web-push) の気象の項)

送る本文:

| 送り先                                 | 本文                                                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord (`/api/webhooks/{id}/{token}`) | `content` に見出し・本文・URL の 3 行。URL は `<...>` で囲んでページの見本を出さない。2,000 字で切り詰め、`@everyone` などのメンションは飛ばさない (`allowed_mentions`)                 |
| Slack (`hooks.slack.com`)              | `text` に同じ 3 行。`&` `<` `>` を Slack の書き方で逃がし、URL は `<...>` のリンクにする                                                                                                |
| ほか                                   | `text` (同じ 3 行) と、機械が読む `title`・`body`・`tag` (同じ事象の続報は同じ値)・`url`・`timestamp` (事象の時刻)・`sentAt`。Discord の末尾が `/slack` の URL もこちら (`text` を読む) |

届かないときは、記録の `[webhook] 送れませんでした (<ホスト>): <理由>` を見る。3xx は追わない (送り先の URL が転送されていないか確かめる)。404 は URL が消された (Discord のウェブフックを消した) ので、足し直す。

## 鍵を替えるとき

鍵を替えると、前の鍵で作った購読には送れなくなる (配信サービスが 401・403 を返す。消すのは 404・410 だけ
なので、購読は残る)。それぞれのブラウザで「通知」を開き直すと、公開鍵が違うことに気づいて購読を作り直す。
使わなくなった購読は、「通知」の「ほかのブラウザ」から解除する。

## 使えないブラウザ

Web Push を使えないブラウザでは、「通知」の Web Push の節に、何ができないかと代わりの道を出す (`#lib/push-support.ts`)。
「このブラウザで受ける」を黙って押せないままにしない。決めるのはできるだけ機能の有無と、ブラウザが返した購読の宛先で、ブラウザの名前は文に添える一言にだけ使う。

- **機能が無い** (Service Worker・`PushManager`・`Notification` のどれか): 無いものの名前と、Chrome・Firefox・Safari・パソコンの Edge で開くことを出す。ボタンは出さない
- **iPhone・iPad の Safari で、ホーム画面に追加せずに開いている** (`navigator.standalone` が false): 「ホーム画面に追加」を案内する
- **登録はできたが、届かない宛先を返した** (受け付ける配信サービスの https でない): サーバーに送らず、購読を消し、宛先の名前と、Chrome で開くことを出す。ページを開いている間は覚え、窓を開き直してもボタンを出さない。前に作った購読が届かない宛先だったときも、窓を開いたときに同じように消して出す
  - **Android の Edge** がこれに当たる。2025-12 (Edge 143) から、許可は `granted` になり `pushManager.subscribe()` も成功するが、endpoint が `https://permanently-removed.invalid/...` になり、届かないと報告されている
    ([Microsoft Q&A「Edge on Android and push subscription」](https://learn.microsoft.com/en-us/answers/questions/5686199/edge-on-android-and-push-subscription)。モデレーターの回答 "push messages cannot be delivered on Edge for Android in this scenario"。2026-11-15 に確かめた)。
    それより前は登録の途中で例外になることもあった ([同じ件の別の質問](https://learn.microsoft.com/en-us/answers/questions/5781524/))。Microsoft の正式な告知や、直ったという記載は見つからない。
    caniuse と MDN の互換表には Edge for Android の列が無い
  - 文は「このブラウザ (Android の Edge) は…」と名前を添え、Android の Chrome で開く (アプリとして入れるときも Chrome から) ことを案内する。Edge が直って正しい宛先を返せば、そのまま登録できる
- **登録が例外で止まった** (配信サービスにつながらない など): 例外の名前と、ほかのブラウザで試すことを出す
- どれでも、開いている間の OS の通知・音・読み上げ (「開いているとき」) は Web Push と別なので使える、と添える。
- **Android の Edge は、サイトの通知そのものが使えない** (2026-11-15、Android 10・Edge 157 の実機で確かめた)。
  `Notification.permission`・`permissions.query`・`pushManager.permissionState` がどれも `denied` で、
  `requestPermission()` は窓を出さずに断る。Edge の設定にも、サイトの通知を許す項目が無い
  (「サイトの設定」は「サイトのアクセス許可」と背景の音だけ、「通知」は Edge 自身のお知らせだけ)。
  なので開いている間の OS の通知も出ない。許可が無いときの文は、設定の道筋ではなく「対応していない。Android の Chrome で開く。Edge のままでも開いている間の音と読み上げは使える」を出す
  (`permissionDeniedText`)。「通知」の窓の下の「ブラウザの通知の状態」で、ブラウザが返す値をそのまま見られる

## 届かないとき

- 記録の `[push] 送れませんでした (<配信サービス>, <状態>)` を見る。404・410 は購読が切れたので、自分で消している。
- 受け付ける配信サービスは FCM (Chrome・Edge)・Mozilla (Firefox)・Apple (Safari)・WNS だけ (`src/lib/push.ts` の `PUSH_HOSTS`。画面も登録の前に同じ決まりで見る)。
  ほかのブラウザで「購読の形が違うか、知らない配信サービスです」と出たら、ここに足す。
- 端末の側で通知が止められていないか (OS の集中モード・ブラウザのサイトの設定)。
