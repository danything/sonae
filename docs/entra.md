# Entra ID の設定 (持ち主の操作)

sonae のログインは doany.io の Entra ID の共有のアプリ登録 `Main` を使う (ほかのアプリと同じ)。
アプリの側は環境変数を読むだけで、Entra の側の登録は持ち主が Entra 管理センターか `az` で行う。
ここに書いたことが済むまで、sonae は画面を開かない (`/health` だけ答える)。

## 1. リダイレクト URI を足す

`Main` → 認証 → Web のリダイレクト URI に次を足す。

- `https://s.doany.io/login/callback` (本番)
- `https://sonae.localhost/login/callback` (手元で genkan 越しに試すとき。要らなければ足さない)

`az` で足すときは、**`az ad app update --web-redirect-uris` が一覧を丸ごと置き換える**ので、今の一覧を読んでから全部を渡す。

```sh
az ad app show --id <Main のクライアント ID> --query web.redirectUris -o tsv
az ad app update --id <Main のクライアント ID> --web-redirect-uris <今の一覧…> https://s.doany.io/login/callback
```

## 2. アプリ ロール `family` を作る

`Main` → アプリ ロール → アプリ ロールの作成。

| 項目               | 値                                                       |
| ------------------ | -------------------------------------------------------- |
| 表示名             | `family` (分かれば何でもよい)                            |
| 許可されたメンバー | ユーザー/グループ                                        |
| 値                 | `family` (sonae の `OIDC_ROLE` の既定。変えたら合わせる) |
| 説明               | sonae を使える人                                         |
| 有効にする         | オン                                                     |

`Main` には既に `admin` があるが、sonae は `admin` だけでは通さない (家族に `admin` を渡さずに済むように、ロールを分けている)。
別の名前にしたいときは、ロールの値と sonae の `OIDC_ROLE` を同じにする。

## 3. 自分にロールを割り当てる

エンタープライズ アプリケーション → `Main` → ユーザーとグループ → 割り当ての追加 → 自分 → ロール `family`。

- **いまは持ち主 1 人だけ。** 家族は、あとで B2B のゲストとして招待し、同じロールを割り当てる (アプリの側は変えなくてよい)。
- テナントに P1 が無いので、グループには割り当てられない。人ごとに割り当てる。
- ロールは ID トークンの `roles` に載る (scope は `openid profile` のままでよい)。ロールが無い人は「ロール family を持っていません」で 403 になる。

## 4. sonae に渡す環境変数

| 変数                 | 値                                                                                      | 秘密か |
| -------------------- | --------------------------------------------------------------------------------------- | ------ |
| `OIDC_ISSUER`        | `https://login.microsoftonline.com/<テナント ID>/v2.0`                                  | いいえ |
| `OIDC_CLIENT_ID`     | `Main` のクライアント ID (ashi の `deploy/deployment.yaml` の `ENTRA_CLIENT_ID` と同じ) | いいえ |
| `OIDC_CLIENT_SECRET` | `Main` のクライアントシークレット (gitops の auth の `oidc-client-secret` と同じ値)     | はい   |
| `OIDC_ROLE`          | 通すロール。既定 `family`                                                               | いいえ |
| `OIDC_ROLE_CLAIM`    | ロールを読む claim。既定は空 (`roles` と `groups` の両方)                               | いいえ |
| `OIDC_SCOPE`         | 既定 `openid profile`                                                                   | いいえ |
| `PUBLIC_URL`         | `https://s.doany.io`。リダイレクト URI はここから組む (要求の Host を信じない)          | いいえ |

秘密 (`OIDC_CLIENT_SECRET`) は、クラスタに載せるときに `deploy/secrets.sops.yaml` に入れる。
シークレットをローテーションしたら、ほかのアプリと同じく全部を直す。

## 確かめ方

1. sonae を開くと `/login` から Microsoft のサインインへ送られる。
2. サインインすると `https://s.doany.io/login/callback` に戻り、トップが出る。
3. 戻ったところで「AADSTS50011 (リダイレクト URI が合わない)」が出たら 1 を、「ロール family を持っていません」が出たら 2・3 を見直す。
