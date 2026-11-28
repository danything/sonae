/**
 * 気象庁防災情報 XML (PULL 型)。高頻度フィードを 60 秒ごとに取る。地震火山 (eqvol.xml) と、
 * 気象の随時 (extra.xml。警報・注意報など) の 2 つを、同じ作りの別の情報源として動かす。気象の情報源は、
 * その他 (other.xml。潮位の解説情報) と定時 (regular.xml。早期注意情報) のフィードも間隔を空けて取る。
 *
 * - `If-None-Match` と `If-Modified-Since` を付ける (変わっていなければ 304)。`Cache-Control: max-age=60`
 *   なので 60 秒より短くしない
 * - 一度取った電文は取り直さない (Atom の id を raw_messages に持つ)。404・410 が返った電文も、
 *   そのフィードに載っている間は取り直さない (メモリに持つ。5xx などの一時的な失敗は次の回に取り直す)
 * - 起動したときと、取得が 10 分以上途切れた後に、長期フィード (eqvol_l.xml・extra_l.xml など) を 1 回だけ読む
 * - 1 日 10GB を超えると IP が遮断される。種別で絞り、知らない種別は取らない
 * - その時点の状態をまるごと持つ種別 (府県予報区ごとの警報・注意報と早期注意情報) は、同じ府県予報区のいちばん新しい
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
const JMA_LONG_FEED = `${FEED_BASE}/eqvol_l.xml`;
const JMA_EXTRA_FEED = `${FEED_BASE}/extra.xml`;
const JMA_EXTRA_LONG_FEED = `${FEED_BASE}/extra_l.xml`;
const JMA_OTHER_FEED = `${FEED_BASE}/other.xml`;
const JMA_OTHER_LONG_FEED = `${FEED_BASE}/other_l.xml`;
const JMA_REGULAR_FEED = `${FEED_BASE}/regular.xml`;
const JMA_REGULAR_LONG_FEED = `${FEED_BASE}/regular_l.xml`;

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
  /** 電文を読む。url はフィードのリンク (府県予報区のコードがファイル名の後ろにある) */
  parse(xml: string, code: string, url?: string): Normalized[];
  /**
   * 一緒に取るほかのフィード (同じ種別の振り分けと読み方を使う)。`everyMs` ごとに取る (急がない電文だけが載るフィード)。
   * 長期フィードは、初めてと、取れない間が 10 分を超えた後に読む
   */
  more?: { feedUrl: string; longFeedUrl: string; everyMs: number }[];
}

const GAP_MS = 10 * 60_000;
/**
 * フィードは取れても、電文の本体が続けてこの回数だけ取れなければ (5xx・408・429)、受けられていないとみなして
 * 状態を「再接続中」にする (予備の源が動き出す。docs/design.md の 2.1 の「予備の源」)
 */
export const TELEGRAM_MISS_LIMIT = 3;

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
  const interval = Math.max(60_000, opts.intervalMs ?? 60_000);
  const status = new StatusTracker(kind.id, ctx.onStatus, {
    kind: "poll",
    everyMs: interval,
  });
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? ((m: string) => console.log(m));
  const wait = opts.sleep ?? sleep;
  const cache = new Map<string, { etag?: string; modified?: string }>();
  /**
   * フィードごとの、404・410 が返った電文 (Atom の id)。そのフィードを読んで載っていなければ忘れる。
   * 長期フィードと高頻度のフィードに同じ電文が載るので、どちらかで覚えていれば取得しない
   */
  const gone = new Map<string, Set<string>>();
  const isGone = (id: string) => [...gone.values()].some((s) => s.has(id));
  const tag = `[${kind.id}]`;

  /**
   * フィードを取り、まだ取っていない電文を渡す。電文を全部取れてから控える (途中で失敗したら、次も
   * 304 にならず読み直して、取り残しを取得する。`pollSource` と同じ)
   */
  async function feed(url: string, signal: AbortSignal): Promise<boolean> {
    const c = cache.get(url) ?? {};
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    if (c.etag) headers["if-none-match"] = c.etag;
    if (c.modified) headers["if-modified-since"] = c.modified;
    const res = await doFetch(url, {
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (res.status === 304) return true;
    if (!res.ok) throw new Error(`フィードが ${res.status} を返しました`);
    if (!(await take(url, parseFeed(await res.text()), signal))) return false;
    cache.set(url, {
      etag: res.headers.get("etag") ?? undefined,
      modified: res.headers.get("last-modified") ?? undefined,
    });
    return true;
  }

  /** まだ取っていない電文を、古い順に取って渡す。取れなかった電文があれば false */
  async function take(
    feedUrl: string,
    entries: FeedEntry[],
    signal: AbortSignal,
  ): Promise<boolean> {
    const listed = new Set(entries.map((e) => e.id));
    const missing = new Set(
      [...(gone.get(feedUrl) ?? [])].filter((id) => listed.has(id)),
    );
    gone.set(feedUrl, missing);
    const todo = latestSnapshots(
      entries.filter((e) => kind.wanted.has(e.code)),
      kind.snapshot,
    )
      .filter((e) => !isGone(e.id) && !ctx.seen(kind.id, e.id))
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
        // 取れないので、取り残しに数えない (毎回フィードを読み直さない)。404・410 は覚えて、
        // フィードが変わって読み直しても、載っている間は取得しない
        if (res.status >= 500 || res.status === 408 || res.status === 429)
          all = false;
        else if (res.status === 404 || res.status === 410) missing.add(e.id);
        continue;
      }
      const body = await res.text();
      try {
        ctx.emit({
          source: kind.id,
          key: e.id,
          code: e.code,
          body,
          items: kind.parse(body, e.code, e.url),
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
      /** 一緒に取るほかのフィードの、次に取る時刻と、最後に取れた時刻 */
      const moreNext = new Map<string, number>();
      const moreOk = new Map<string, number>();
      /** フィードは取れたが、電文の本体を取り残した回が続いた数 */
      let missed = 0;
      while (!signal.aborted) {
        try {
          let complete = true;
          if (Date.now() - lastOk > GAP_MS)
            complete = await feed(opts.longFeedUrl ?? kind.longFeedUrl, signal);
          complete =
            (await feed(opts.feedUrl ?? kind.feedUrl, signal)) && complete;
          lastOk = Date.now();
          // 急がないほかのフィードの失敗は、記録して次の間隔に回すだけにする
          // (主のフィードの状態と間隔に響かせない。警報などの取得を遅らせないため)
          for (const m of kind.more ?? []) {
            const now = Date.now();
            if (now < (moreNext.get(m.feedUrl) ?? 0)) continue;
            moreNext.set(m.feedUrl, now + m.everyMs - 1000);
            try {
              if (now - (moreOk.get(m.feedUrl) ?? 0) > GAP_MS + m.everyMs)
                await feed(m.longFeedUrl, signal);
              await feed(m.feedUrl, signal);
              moreOk.set(m.feedUrl, Date.now());
            } catch (err) {
              if (signal.aborted) throw err;
              log(`${tag} ${m.feedUrl} を取れませんでした: ${err}`);
            }
          }
          // 電文の本体を取り残した回は、受けたことにしない (最後に受けた時刻を進めない)。続けば「再接続中」にする
          // (フィードだけ取れて電文が 5xx のときも、予備の源が動き出すように)
          if (complete) {
            missed = 0;
            status.seen(false);
            status.set("connected");
          } else if (++missed >= TELEGRAM_MISS_LIMIT)
            status.set(
              "retrying",
              `電文を ${missed} 回続けて取れません (配信元が 5xx などを返しています)`,
            );
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

/** 気象の随時のフィード (extra.xml。警報・注意報・竜巻・洪水・台風・解説情報など) と、その他のフィード (other.xml。潮位の解説情報)・定時のフィード (regular.xml。早期注意情報) */
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
      // その他のフィード (other.xml) には、潮位の気象解説情報 (VMCJ53〜55) が載る。海上警報などほかの電文が
      // 多く、急ぐ電文は無いので 5 分ごと
      more: [
        {
          feedUrl: JMA_OTHER_FEED,
          longFeedUrl: JMA_OTHER_LONG_FEED,
          everyMs: 5 * 60_000,
        },
        // 定時のフィード (regular.xml) には早期注意情報 (VPFD61・VPFW60) が載る。天気予報など取らない電文が
        // 多く (約 300KB。1 回に 10 時間ほどの分が並ぶ)、早期注意情報は 1 日 3 回の定時が主なので 10 分ごと
        {
          feedUrl: JMA_REGULAR_FEED,
          longFeedUrl: JMA_REGULAR_LONG_FEED,
          everyMs: 10 * 60_000,
        },
      ],
    },
    opts,
  );
}
