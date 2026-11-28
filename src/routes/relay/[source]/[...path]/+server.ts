import { relay } from "#lib/server/relay.ts";

import type { RequestHandler } from "./$types";

/**
 * 外のもの (地図のタイル・時刻の表など) の中継 (docs/design.md の 2.14)。ログインの後ろ (hooks) にあり、
 * どの源のどの道を通すかは `#lib/server/relay.ts` の表が決める。要求の道や問い合わせはログに出さない。
 * 見る人が要求を取り消したら (地図を動かして要らなくなったタイルなど)、まだ取りに行っていなければやめる
 */
export const GET: RequestHandler = ({ params, url, request }) =>
  relay().handle(
    params.source,
    params.path,
    url.searchParams,
    request.headers,
    request.signal,
  );
