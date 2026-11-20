import { json } from "@sveltejs/kit";

import { app } from "#lib/server/receiver.ts";
import { marineResponse, msilKey } from "#lib/server/sources/msil.ts";

/**
 * 海しるの点の層 (海底地殻変動観測点・海域火山)。サーバーが 1 日 1 回取って置いたものを渡す (docs/design.md の 2.11)。
 * ブラウザには海しるの API のキーを渡さない。キーが無ければ `enabled: false` で点は空 (画面は層を出さない)
 */
export const GET = () =>
  json(marineResponse(app().store.db, msilKey() !== undefined), {
    headers: { "cache-control": "private, max-age=3600" },
  });
