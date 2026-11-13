# Entra ID の設定

sonae のログインは doany.io の Entra ID の**共用のアプリ登録 `Main`** (アプリケーション ID `b0fa498f-7e6a-4fe1-a1c6-16fbbb6f397e`) を使い回す。新しくアプリは登録しない。

- リダイレクト URI `https://s.doany.io/auth/callback` は、gitops の `pulumi/entra.ts` で `Main` に足してある (ashi と同じパス)。
- 通すロールは `OIDC_ROLE` で決め、既定は `admin` (`Main` のアプリロールはいま `admin` だけ)。

## sonae に渡す環境変数

| 変数                 | 値                                                                             | 秘密か |
| -------------------- | ------------------------------------------------------------------------------ | ------ |
| `OIDC_ISSUER`        | `https://login.microsoftonline.com/<テナント ID>/v2.0`                         | いいえ |
| `OIDC_CLIENT_ID`     | `b0fa498f-7e6a-4fe1-a1c6-16fbbb6f397e`                                         | いいえ |
| `OIDC_CLIENT_SECRET` | `Main` の共用のクライアントシークレット                                        | はい   |
| `OIDC_ROLE`          | 通すロール。既定 `admin`                                                       | いいえ |
| `OIDC_ROLE_CLAIM`    | ロールを読む claim。既定は空 (`roles` と `groups` の両方)                      | いいえ |
| `OIDC_SCOPE`         | 既定 `openid profile`                                                          | いいえ |
| `PUBLIC_URL`         | `https://s.doany.io`。リダイレクト URI はここから組む (要求の Host を信じない) | いいえ |

クラスタに載せるときは、共用のシークレットを `deploy/secrets.sops.yaml` に入れる (ほかのアプリと同じ値。ローテーションしたら全部を直す)。

## 家族と共有するとき (あとで)

1. `Main` に family 用のアプリロールを足す (gitops の `pulumi/entra.ts`)。
2. 家族を B2B のゲストとして招待し、エンタープライズ アプリケーション → `Main` → ユーザーとグループで、そのロールを割り当てる。テナントに P1 が無いので、グループではなく人ごとに割り当てる。
3. sonae の `OIDC_ROLE` をそのロールの値にする。持ち主にも同じロールを割り当てる (sonae が通すロールは 1 つ)。

コードの変更は要らない。

## 確かめ方

1. sonae を開くと `/auth/login` から Microsoft のサインインへ送られる。
2. サインインすると `https://s.doany.io/auth/callback` に戻り、トップが出る。
3. 戻ったところで「AADSTS50011 (リダイレクト URI が合わない)」が出たら gitops の `pulumi/entra.ts` を、「ロール admin を持っていません」が出たら割り当てを見直す。
