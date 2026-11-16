/**
 * `PUBLIC_URL` (sonae を開く URL) の origin。空か URL として読めなければ undefined。
 * ログインの戻り先・Webhook の本文に付ける URL に使う
 */
export function publicOrigin(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env.PUBLIC_URL?.trim();
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

/** `PUBLIC_URL` が入っているのに URL として読めない (起動したときに警告を出す) */
export const publicUrlBroken = (
  env: Record<string, string | undefined> = process.env,
): boolean => Boolean(env.PUBLIC_URL?.trim()) && !publicOrigin(env);

/**
 * このサイトの origin。PUBLIC_URL があればそれを使い、無ければ要求の origin。
 * ログインの戻り先 (リダイレクト URI) を要求の Host から組むと、Host を書き換えた要求で
 * 別のドメインへ戻させられるので、本番では PUBLIC_URL を入れる。入っているのに読めないときは、
 * 要求の Host に戻さずに失敗させる (起動したときに警告を出す)
 */
export function siteOrigin(url: URL): string {
  if (!process.env.PUBLIC_URL?.trim()) return url.origin;
  const fixed = publicOrigin();
  if (!fixed) throw new Error("PUBLIC_URL を URL として読めません");
  return fixed;
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
