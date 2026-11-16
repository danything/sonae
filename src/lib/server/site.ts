/**
 * このサイトの origin。PUBLIC_URL (sonae を開く URL) があればそれを使い、無ければ要求の origin。
 * ログインの戻り先 (リダイレクト URI) を要求の Host から組むと、Host を書き換えた要求で
 * 別のドメインへ戻させられるので、本番では PUBLIC_URL を入れる。
 */
export function siteOrigin(url: URL): string {
  const fixed = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  return fixed ? new URL(fixed).origin : url.origin;
}

/**
 * 緊急地震速報の訓練・試験も一覧と地図に出すか (`SONAE_TRAINING=on`。既定は出さない)。
 * 出しても音・読み上げ・Web Push・Webhook では知らせない (`#lib/notify.ts` の noticeOf が外す)。
 * 前は画面のスイッチ (URL の `training=1`) で切り替えていた (持ち主の決定で環境変数に移した、2026-11-16)
 */
export function showTraining(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SONAE_TRAINING?.trim() === "on";
}
