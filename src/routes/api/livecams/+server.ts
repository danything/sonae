import { json } from "@sveltejs/kit";

import { livecamResponse } from "#lib/server/sources/youtube.ts";

/**
 * YouTube のライブカメラの、いま配信中の動画 (docs/design.md の 2.13)。サーバーが 5 分ごとに確かめたものを渡すだけで、
 * ここから YouTube へは問い合わせない。キーが無ければ `enabled: false` (画面は地図の中で再生しない)
 */
export const GET = () =>
  json(livecamResponse(), { headers: { "cache-control": "no-store" } });
