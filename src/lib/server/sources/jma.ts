/**
 * 気象庁防災情報 XML (PULL 型)。高頻度フィード (eqvol.xml) を 60 秒ごとに取る。
 *
 * - `If-None-Match` と `If-Modified-Since` を付ける (ほとんどが 304)。`Cache-Control: max-age=60`
 *   なので 60 秒より短くしない
 * - 一度取った電文は取り直さない (Atom の id を raw_messages に持つ)
 * - 起動したときと、取得が 10 分以上途切れた後に、長期フィード (eqvol_l.xml) を 1 回だけ読む
 * - 1 日 10GB を超えると IP が遮断される。種別で絞り、知らない種別は取らない
 *
 * 出典: 気象庁防災情報 XML の公開 (https://www.data.jma.go.jp/developer/xml/feed/)。
 */

import {
  type FeedEntry,
  parseFeed,
  parseJmaXml,
  WANTED_CODES,
} from "./jma-xml.ts";
import { sleep, StatusTracker, USER_AGENT } from "./retry.ts";
import type { Source, SourceContext } from "./types.ts";

export const JMA_FEED =
  "https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml";
export const JMA_LONG_FEED =
  "https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml";

export interface JmaOptions {
  feedUrl?: string;
  longFeedUrl?: string;
  intervalMs?: number;
  fetch?: typeof fetch;
  log?: (m: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const GAP_MS = 10 * 60_000;

export function jmaSource(ctx: SourceContext, opts: JmaOptions = {}): Source {
  const status = new StatusTracker("jma", ctx.onStatus);
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? ((m: string) => console.log(m));
  const interval = Math.max(60_000, opts.intervalMs ?? 60_000);
  const wait = opts.sleep ?? sleep;
  const cache = new Map<string, { etag?: string; modified?: string }>();

  /** フィードを取る。変わっていなければ null */
  async function feed(
    url: string,
    signal: AbortSignal,
  ): Promise<FeedEntry[] | null> {
    const c = cache.get(url) ?? {};
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    if (c.etag) headers["if-none-match"] = c.etag;
    if (c.modified) headers["if-modified-since"] = c.modified;
    const res = await doFetch(url, {
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (res.status === 304) return null;
    if (!res.ok) throw new Error(`フィードが ${res.status} を返しました`);
    cache.set(url, {
      etag: res.headers.get("etag") ?? undefined,
      modified: res.headers.get("last-modified") ?? undefined,
    });
    return parseFeed(await res.text());
  }

  /** まだ取っていない電文を、古い順に取って渡す */
  async function take(entries: FeedEntry[], signal: AbortSignal) {
    const todo = entries
      .filter((e) => WANTED_CODES.has(e.code) && !ctx.seen("jma", e.id))
      .reverse();
    for (const e of todo) {
      if (signal.aborted) return;
      const res = await doFetch(e.url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      if (!res.ok) {
        log(`[jma] ${e.url} が ${res.status} を返しました`);
        continue;
      }
      const body = await res.text();
      try {
        ctx.emit({
          source: "jma",
          key: e.id,
          code: e.code,
          body,
          items: parseJmaXml(body, e.code),
        });
      } catch (err) {
        // 読めない電文も原文は残す (読み方を直したら流し直す)
        log(`[jma] ${e.code} を読めませんでした: ${err}`);
        ctx.emit({
          source: "jma",
          key: e.id,
          code: e.code,
          body,
          items: [],
          error: String(err),
        });
      }
      status.seen(true);
    }
  }

  return {
    id: "jma",
    status: () => status.get(),
    async run(signal) {
      let lastOk = 0;
      while (!signal.aborted) {
        try {
          if (Date.now() - lastOk > GAP_MS) {
            const long = await feed(opts.longFeedUrl ?? JMA_LONG_FEED, signal);
            if (long) await take(long, signal);
          }
          const entries = await feed(opts.feedUrl ?? JMA_FEED, signal);
          if (entries) await take(entries, signal);
          lastOk = Date.now();
          status.seen(false);
          status.set("connected");
        } catch (err) {
          if (signal.aborted) break;
          log(`[jma] フィードを取れませんでした: ${err}`);
          status.set("retrying", String(err));
        }
        await wait(interval, signal);
      }
      status.set("stopped");
    },
  };
}
