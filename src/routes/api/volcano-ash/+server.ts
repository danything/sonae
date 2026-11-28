import { error, json } from "@sveltejs/kit";

import { app } from "#lib/server/receiver.ts";

/**
 * 降灰予報 (VFVO53〜55) の範囲の多角形 (docs/map.md の「降灰予報の範囲」)。`?id=<火山の報の id>`。id は DB の検索に束縛値で渡すだけなので、形は緩く見る (識別番号が無い報は発表の時刻が入る)。
 * 一覧の報には持たせないので、地図で降灰予報を選んだときだけ読む。受けていない・範囲の無い報は `ash: null`
 */
export const GET = ({ url }) => {
  const id = url.searchParams.get("id") ?? "";
  if (!/^VFVO5[345]-[^\s/?#]+$/.test(id)) error(400, "id が正しくありません");
  return json(
    { ash: app().store.volcanoAsh(id) ?? null },
    { headers: { "cache-control": "private, max-age=60" } },
  );
};
