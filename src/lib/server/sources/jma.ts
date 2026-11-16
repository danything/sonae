/**
 * 気象庁防災情報 XML (PULL 型)。高頻度フィードを 60 秒ごとに取る。地震火山 (eqvol.xml) と、
 * 気象の随時 (extra.xml。警報・注意報など) の 2 つを、同じ作りの別の情報源として動かす。
 *
 * - `If-None-Match` と `If-Modified-Since` を付ける (変わっていなければ 304)。`Cache-Control: max-age=60`
 *   なので 60 秒より短くしない
 * - 一度取った電文は取り直さない (Atom の id を raw_messages に持つ)
 * - 起動したときと、取得が 10 分以上途切れた後に、長期フィード (eqvol_l.xml・extra_l.xml) を 1 回だけ読む
 * - 1 日 10GB を超えると IP が遮断される。種別で絞り、知らない種別は取らない
 * - その時点の状態をまるごと持つ種別 (府県予報区ごとの警報・注意報) は、同じ府県予報区のいちばん新しい
 *   電文だけを取る (古いものは新しいもので置き換わるので、取っても使わない)
 *
 * 出典: 気象庁防災情報 XML の公開 (https://www.data.jma.go.jp/developer/xml/feed/)。
 */

import type { SourceId } from "#lib/model.ts";

import {
  parseWeatherXml,
  WEATHER_CODES,
  WEATHER_SNAPSHOT_CODES,
} from "./jma-weather.ts";
import {
  type FeedEntry,
  parseFeed,
  parseJmaXml,
  WANTED_CODES,
} from "./jma-xml.ts";
import { sleep, StatusTracker, USER_AGENT } from "./retry.ts";
import type { Normalized, Source, SourceContext } from "./types.ts";

const FEED_BASE = "https://www.data.jma.go.jp/developer/xml/feed";
export const JMA_FEED = `${FEED_BASE}/eqvol.xml`;
export const JMA_LONG_FEED = `${FEED_BASE}/eqvol_l.xml`;
export const JMA_EXTRA_FEED = `${FEED_BASE}/extra.xml`;
export const JMA_EXTRA_LONG_FEED = `${FEED_BASE}/extra_l.xml`;

export interface JmaOptions {
  feedUrl?: string;
  longFeedUrl?: string;
  intervalMs?: number;
  fetch?: typeof fetch;
  log?: (m: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** フィードごとに違うところ */
interface FeedKind {
  id: SourceId;
  feedUrl: string;
  longFeedUrl: string;
  /** 取る種別 */
  wanted: ReadonlySet<string>;
  /** その時点の状態をまるごと持つ種別 (府県予報区ごとに、いちばん新しいものだけ取る) */
  snapshot?: ReadonlySet<string>;
  parse(xml: string, code: string): Normalized[];
}

const GAP_MS = 10 * 60_000;

/**
 * 状態をまるごと持つ種別で、同じ府県予報区のものは新しい 1 つだけを残す (並びは新しい順のまま)。
 * 府県予報区はファイル名の種別の後ろ (`_VPWW55_471000.xml` の `471000`) で見分ける
 */
export function latestSnapshots(
  entries: FeedEntry[],
  snapshot: ReadonlySet<string> | undefined,
): FeedEntry[] {
  if (!snapshot) return entries;
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (!snapshot.has(e.code)) return true;
    const area = new RegExp(`_${e.code}_([^/]+)\\.xml$`).exec(e.url)?.[1];
    if (!area) return true;
    const key = `${e.code}_${area}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function feedSource(
  ctx: SourceContext,
  kind: FeedKind,
  opts: JmaOptions,
): Source {
  const status = new StatusTracker(kind.id, ctx.onStatus);
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? ((m: string) => console.log(m));
  const interval = Math.max(60_000, opts.intervalMs ?? 60_000);
  const wait = opts.sleep ?? sleep;
  const cache = new Map<string, { etag?: string; modified?: string }>();
  const tag = `[${kind.id}]`;

  /**
   * フィードを取り、まだ取っていない電文を渡す。電文を全部取れてから控える (途中で失敗したら、次も
   * 304 にならず読み直して、取り残しを取りに行く。`pollSource` と同じ)
   */
  async function feed(url: string, signal: AbortSignal): Promise<void> {
    const c = cache.get(url) ?? {};
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    if (c.etag) headers["if-none-match"] = c.etag;
    if (c.modified) headers["if-modified-since"] = c.modified;
    const res = await doFetch(url, {
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (res.status === 304) return;
    if (!res.ok) throw new Error(`フィードが ${res.status} を返しました`);
    if (!(await take(parseFeed(await res.text()), signal))) return;
    cache.set(url, {
      etag: res.headers.get("etag") ?? undefined,
      modified: res.headers.get("last-modified") ?? undefined,
    });
  }

  /** まだ取っていない電文を、古い順に取って渡す。取れなかった電文があれば false */
  async function take(
    entries: FeedEntry[],
    signal: AbortSignal,
  ): Promise<boolean> {
    const todo = latestSnapshots(
      entries.filter((e) => kind.wanted.has(e.code)),
      kind.snapshot,
    )
      .filter((e) => !ctx.seen(kind.id, e.id))
      .reverse();
    let all = true;
    for (const e of todo) {
      if (signal.aborted) return false;
      const res = await doFetch(e.url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      if (!res.ok) {
        log(`${tag} ${e.url} が ${res.status} を返しました`);
        // 取り直すのは、待てば取れそうなもの (5xx・408・429) だけ。404・410 などは取り直しても
        // 取れないので、取り残しに数えない (毎回フィードを読み直さない)
        if (res.status >= 500 || res.status === 408 || res.status === 429)
          all = false;
        continue;
      }
      const body = await res.text();
      try {
        ctx.emit({
          source: kind.id,
          key: e.id,
          code: e.code,
          body,
          items: kind.parse(body, e.code),
        });
      } catch (err) {
        // 読めない電文も原文は残す (読み方を直したら流し直す)
        log(`${tag} ${e.code} を読めませんでした: ${err}`);
        ctx.emit({
          source: kind.id,
          key: e.id,
          code: e.code,
          body,
          items: [],
          error: String(err),
        });
      }
      status.seen(true);
    }
    return all;
  }

  return {
    id: kind.id,
    status: () => status.get(),
    async run(signal) {
      let lastOk = 0;
      while (!signal.aborted) {
        try {
          if (Date.now() - lastOk > GAP_MS)
            await feed(opts.longFeedUrl ?? kind.longFeedUrl, signal);
          await feed(opts.feedUrl ?? kind.feedUrl, signal);
          lastOk = Date.now();
          status.seen(false);
          status.set("connected");
        } catch (err) {
          if (signal.aborted) break;
          log(`${tag} フィードを取れませんでした: ${err}`);
          status.set("retrying", String(err));
        }
        await wait(interval, signal);
      }
      status.set("stopped");
    },
  };
}

/** 地震火山のフィード (eqvol.xml) */
export function jmaSource(ctx: SourceContext, opts: JmaOptions = {}): Source {
  return feedSource(
    ctx,
    {
      id: "jma",
      feedUrl: JMA_FEED,
      longFeedUrl: JMA_LONG_FEED,
      wanted: WANTED_CODES,
      parse: parseJmaXml,
    },
    opts,
  );
}

/** 気象の随時のフィード (extra.xml。警報・注意報・土砂災害・竜巻・洪水・台風など) */
export function jmaWeatherSource(
  ctx: SourceContext,
  opts: JmaOptions = {},
): Source {
  return feedSource(
    ctx,
    {
      id: "jma-weather",
      feedUrl: JMA_EXTRA_FEED,
      longFeedUrl: JMA_EXTRA_LONG_FEED,
      wanted: WEATHER_CODES,
      snapshot: WEATHER_SNAPSHOT_CODES,
      parse: parseWeatherXml,
    },
    opts,
  );
}
