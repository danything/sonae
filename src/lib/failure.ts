/**
 * 画面に出す失敗の文 (「通知」の窓・地図のメニュー)。ブラウザが投げる例外の英語 (「TypeError: Failed to fetch」)
 * をそのまま出さない。
 *
 * - `fetch` はサーバーにつながらないとき `TypeError` を投げる (文はブラウザごとに違う。Chromium は
 *   「Failed to fetch」、Firefox は「NetworkError when attempting to fetch resource.」、Safari は「Load failed」)。
 *   これは決まった文「つながりません」にする (声の保存の「保存できませんでした (つながりません)」と同じ)
 * - 応答の JSON を読めない (`SyntaxError`) ときは「応答を読めません」
 * - ほかのブラウザの例外 (`DOMException` など) は名前だけ (`NotAllowedError`)。sonae が自分で投げた `Error` は文のまま
 */

/** サーバーにつながらなかった失敗か (`fetch` の失敗は `TypeError`) */
export const unreachable = (err: unknown): boolean => err instanceof TypeError;

/** 失敗の訳 (括弧の中に入れる短い言葉) */
export function failureReason(err: unknown): string {
  if (unreachable(err)) return "つながりません";
  if (err instanceof SyntaxError) return "応答を読めません";
  if (err instanceof Error)
    return err.name === "Error" ? err.message : err.name;
  return String(err);
}

/** 「<何が>できませんでした (<訳>)」の形の文 */
export const failureText = (what: string, err: unknown): string =>
  `${what} (${failureReason(err)})`;
