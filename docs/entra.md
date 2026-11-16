# Entra ID の設定

持ち主の本番 (`s.doany.io`) のログインは、doany.io の Entra ID の**共用のアプリ登録 `Main`** (アプリケーション ID `b0fa498f-7e6a-4fe1-a1c6-16fbbb6f397e`) を使い回す。新しくアプリは登録しない。
自分の Entra ID で立てるなら、アプリを登録してリダイレクト URI `<開く URL>/auth/callback` とアプリロール `admin` を足し、下の表の値を自分のものに替える。

- リダイレクト URI `https://s.doany.io/auth/callback` は、gitops の `pulumi/entra.ts` で `Main` に足してある (ashi と同じパス)。
- `Main` のアプリロールはいま `admin` だけ。

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

## 家族と共有するとき

コードの変更は要らない。

1. 家族を B2B のゲストとして招待し、エンタープライズ アプリケーション → `Main` → ユーザーとグループで、sonae が通すロール (`OIDC_ROLE`) を割り当てる。テナントに P1 が無いので、グループではなく人ごとに割り当てる。
2. `admin` を家族に渡したくなければ、`Main` に family 用のアプリロールを足し (gitops の `pulumi/entra.ts`)、`OIDC_ROLE` をその値にする。sonae が通すロールは 1 つなので、持ち主にも同じロールを割り当てる。

## 確かめ方

1. sonae を開くと `/auth/login` から Microsoft のサインインへ送られる。
2. サインインすると `https://s.doany.io/auth/callback` に戻り、トップが出る。
3. 戻ったところで「AADSTS50011 (リダイレクト URI が合わない)」が出たら gitops の `pulumi/entra.ts` を、「ロール admin を持っていません」が出たら割り当てを見直す。
