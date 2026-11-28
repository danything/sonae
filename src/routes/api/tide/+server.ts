import { json } from "@sveltejs/kit";

import type { TideError } from "#lib/map/marine.ts";
import { app } from "#lib/server/receiver.ts";
import { msilKey, TideFetcher, TideRefused } from "#lib/server/sources/msil.ts";

/** 鍵を替えたら作り直す (開発サーバーで環境変数を替えたとき) */
let fetcher: { key: string; f: TideFetcher } | undefined;

const fail = (error: string, status: number) =>
  json({ error } satisfies TideError, {
    status,
    headers: { "cache-control": "no-store" },
  });

/**
 * 潮汐推算の地点の、今日 (日本時間) の推算の潮位 (docs/design.md の 2.11)。地図で地点を押したときに画面が読む。
 * サーバーが海しるから取得し (キーはブラウザに渡さない)、地点と日ごとに持つ。キーが無ければ 404
 */
export const GET = async ({ url }: { url: URL }) => {
  const key = msilKey();
  if (!key) return fail("海しるの API のキーがありません", 404);
  const code = url.searchParams.get("station") ?? "";
  if (fetcher?.key !== key)
    fetcher = { key, f: new TideFetcher(app().store.db, key) };
  try {
    const day = await fetcher.f.today(code);
    return json(day, { headers: { "cache-control": "private, max-age=600" } });
  } catch (err) {
    if (err instanceof TideRefused) return fail(err.message, err.status);
    console.log(`[msil] 潮汐推算を取れませんでした: ${String(err)}`);
    return fail(
      "潮汐推算を読めませんでした。しばらくしてから開き直してください",
      502,
    );
  }
};
