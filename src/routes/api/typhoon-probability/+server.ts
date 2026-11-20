import { error, json } from "@sveltejs/kit";

import { app } from "#lib/server/receiver.ts";

/**
 * 台風の暴風域に入る確率 (VPTA50〜55) の、その台風のいちばん新しい報 (docs/design.md の 2.8)。
 * `?series=typhoon-TC2001` (台風解析・予報情報の series)。住んでいる地域はサーバーに送らず、画面が全部の地域から引く。
 * まだ受けていなければ `probability: null`
 */
export const GET = ({ url }) => {
  const series = url.searchParams.get("series") ?? "";
  if (!/^typhoon-TC\d+$/.test(series)) error(400, "series が正しくありません");
  return json(
    { probability: app().store.typhoonProbability(series) ?? null },
    { headers: { "cache-control": "private, max-age=60" } },
  );
};
