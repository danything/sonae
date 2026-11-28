import { error, json } from "@sveltejs/kit";

import { app } from "#lib/server/receiver.ts";

/**
 * 台風のこれまでの経路 (受けた台風解析・予報情報の実況の中心。時刻の順。docs/map.md の「台風」)。
 * `?series=typhoon-TC2001` (台風解析・予報情報の series)。受けた報が無ければ `points: []`
 */
export const GET = ({ url }) => {
  const series = url.searchParams.get("series") ?? "";
  if (!/^typhoon-TC\d+$/.test(series)) error(400, "series が正しくありません");
  return json(
    { points: app().store.typhoonTrack(series) },
    // 画面は報が替わったときだけ読み直すので、古い応答を使わない (新しい実況の点が抜けないように)
    { headers: { "cache-control": "private, no-cache" } },
  );
};
