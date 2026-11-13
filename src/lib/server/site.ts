/**
 * このサイトの origin。PUBLIC_URL (本番は https://s.doany.io) があればそれを使い、無ければ要求の origin。
 * ログインの戻り先 (リダイレクト URI) を要求の Host から組むと、Host を書き換えた要求で
 * 別のドメインへ戻させられるので、本番では PUBLIC_URL を入れる。
 */
export function siteOrigin(url: URL): string {
  const fixed = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  return fixed ? new URL(fixed).origin : url.origin;
}
