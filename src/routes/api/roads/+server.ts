import { json } from "@sveltejs/kit";

import { app } from "#lib/server/receiver.ts";
import { activeRoadUrls, roadResponse } from "#lib/server/sources/roads.ts";

/**
 * 災害時の通行止めと通れた道 (目安) の線。サーバーが 30 分ごとに取って置いたものを渡す (docs/design.md の 2.12)。
 * 自動で見つけた災害も、登録した URL も無ければ `enabled: false` で線は空 (画面は層を出さない)
 */
export const GET = () => {
  const db = app().store.db;
  return json(roadResponse(db, activeRoadUrls(db)), {
    headers: { "cache-control": "private, max-age=300" },
  });
};
