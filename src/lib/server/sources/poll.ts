/**
 * HTTP で決まった間隔に取りに行く情報源の輪 (USGS・PTWC・GeoNet・CWA・気象庁 bosai など)。
 *
 * - 間隔は情報源ごとに決め、`minIntervalMs` より短くしない (相手のキャッシュの寿命より短く取りに行かない)
 * - `If-None-Match`・`If-Modified-Since` を付ける。304 なら何もしない
 * - 失敗したら、間隔の 2 倍・4 倍…と空ける (上限 `maxBackoffMs`)。同じ URL を立て続けに取りに行かない
 * - 読めない形 (相手の形が変わった) は、その回を捨てて状態にエラーを出す。ほかの情報源には響かない
 * - 起動したときと、取得が `gapMs` より長く途切れた後に、1 回だけ `backfillUrl` (長い期間の一覧) を読む
 */

import type { SourceId } from "#lib/model.ts";

import { sleep, StatusTracker, USER_AGENT } from "./retry.ts";
import type { Incoming, Source, SourceContext } from "./types.ts";

export interface PollOptions {
  id: SourceId;
  url: string;
  /** 起動したときと、長く途切れた後に読む URL (無ければ url) */
  backfillUrl?: string;
  intervalMs: number;
  minIntervalMs: number;
  maxBackoffMs?: number;
  gapMs?: number;
  /** 付ける要求の頭 (Accept・鍵など) */
  headers?: Record<string, string>;
  /** 受けた本文から、渡すもの (鍵が付いた Incoming) を作る。読めなければ例外を投げる */
  parse(text: string, url: string): Incoming[];
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (m: string) => void;
}

export function pollSource(ctx: SourceContext, o: PollOptions): Source {
  const status = new StatusTracker(o.id, ctx.onStatus);
  const doFetch = o.fetch ?? fetch;
  const wait = o.sleep ?? sleep;
  const log = o.log ?? ((m: string) => console.log(m));
  const interval = Math.max(o.minIntervalMs, o.intervalMs);
  const maxBackoff = Math.max(interval, o.maxBackoffMs ?? 15 * 60_000);
  const gap = o.gapMs ?? 10 * 60_000;
  const cache = new Map<string, { etag?: string; modified?: string }>();

  async function once(url: string, signal: AbortSignal): Promise<void> {
    const c = cache.get(url) ?? {};
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      ...o.headers,
    };
    if (c.etag) headers["if-none-match"] = c.etag;
    if (c.modified) headers["if-modified-since"] = c.modified;
    const res = await doFetch(url, {
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      redirect: "follow",
    });
    if (res.status === 304) return;
    if (!res.ok) throw new Error(`${res.status} が返りました`);
    const text = await res.text();
    const items = o.parse(text, url);
    let fresh = false;
    for (const m of items) {
      if (ctx.seen(m.source, m.key)) continue;
      ctx.emit(m);
      fresh = true;
    }
    // 渡し終えてから控える (途中で失敗したら、次も 304 にならず読み直す)。
    // 1 日分の URL も同じ控えを使うが、相手が毎分作り直すので、途切れた後に 304 になることはほぼ無い
    cache.set(url, {
      etag: res.headers.get("etag") ?? undefined,
      modified: res.headers.get("last-modified") ?? undefined,
    });
    status.seen(fresh);
  }

  return {
    id: o.id,
    status: () => status.get(),
    async run(signal) {
      let lastOk = 0;
      let failures = 0;
      while (!signal.aborted) {
        try {
          if (o.backfillUrl && Date.now() - lastOk > gap)
            await once(o.backfillUrl, signal);
          await once(o.url, signal);
          lastOk = Date.now();
          failures = 0;
          status.seen(false);
          status.set("connected");
        } catch (err) {
          if (signal.aborted) break;
          failures++;
          log(`[${o.id}] 取れませんでした: ${err}`);
          status.set("retrying", String(err));
        }
        const delay =
          failures === 0
            ? interval
            : Math.min(maxBackoff, interval * 2 ** (failures - 1));
        await wait(delay, signal);
      }
      status.set("stopped");
    },
  };
}
