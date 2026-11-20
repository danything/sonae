/**
 * 災害時の通行止めの GeoJSON の URL を、国土交通省 道路局のトップページから自動で見つける (docs/design.md の 2.12)。
 *
 * - 道路局のトップページ (`ROAD_LIST_URL`) を 3 時間ごとに読み、災害のページ (`/road/saigai/<名前>/`) へのリンクを探す
 * - 災害ごとに地図のページ (`/road/saigai/<名前>/map/map.html`) を読み、地図が読む GeoJSON のパスと災害の名前を取る
 * - 使う URL は `DISCOVERED_GEOJSON` の形 (www.mlit.go.jp の道路規制情報と ETC2.0 の速度) だけ。
 *   ページに書いてあっても、形の違う URL は捨てる (サーバーが取得する先を、決まった形の URL に絞る)
 * - どちらのページも `If-None-Match`・`If-Modified-Since` を付けて取る。トップページが 304 なら、地図のページは読まない
 *
 * 見つけたものは表 `layer_cache` に 1 行で置く (起動し直しても、3 時間たつまで読み直さない)
 */

import type { Database } from "bun:sqlite";

import { LayerCache } from "../layer-cache.ts";
import { fetchGoJp, readLimited } from "./roads.ts";

/** 道路局のトップページ。災害のページへのバナーが並ぶ (2026-11-21 に確かめた) */
export const ROAD_LIST_URL = "https://www.mlit.go.jp/road/index.html";
export const DISCOVER_INTERVAL_MS = 3 * 60 * 60_000;
/** ページ 1 つの大きさの上限 (トップページは 21KB、地図のページは 6KB だった) */
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
/** 災害の数の上限 (ページの作りが変わって、関係の無いリンクを大量に読まないため) */
const MAX_DISASTERS = 10;

/** 災害のページのパス。名前は英小文字・数字・`_`・`-` だけ */
const DISASTER_PAGE = /^\/road\/saigai\/([a-z0-9_-]+)\/(?:index\.html)?$/;
/** 試しに作ったページ (「【テスト】霞ヶ関地震」) の名前。リンクされていなくても除く */
const SKIP = new Set(["test"]);

/**
 * 見つけた GeoJSON として使ってよい URL の形。www.mlit.go.jp の災害のページの下にある、
 * 道路規制情報 (`dourokisei*.geojson`) と ETC2.0 の速度 (`ETC2.0_speed_data*.geojson`) だけ。
 * 通行実績 (`tukoujisseki.geojson`) などは読まない
 */
export const DISCOVERED_GEOJSON =
  /^https:\/\/www\.mlit\.go\.jp\/road\/saigai\/[a-z0-9_-]+\/map\/json\/(?:dourokisei|ETC2\.0_speed_data)[A-Za-z0-9_.-]*\.geojson$/;

export const disasterMapUrl = (slug: string) =>
  `https://www.mlit.go.jp/road/saigai/${slug}/map/map.html`;

/**
 * 道路局のトップページから、災害のページの名前 (`r8kumamoto`) を並べる。
 * タイトルが道路局のものでなければ、ページの作りが変わったとみなして例外
 */
export function disasterSlugs(html: string): string[] {
  if (!/<title>[^<]*道路[^<]*国土交通省[^<]*<\/title>/.test(html))
    throw new Error("道路局のトップページのタイトルが見当たりません");
  const out: string[] = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"'<>]+)["']/gi)) {
    let u: URL;
    try {
      u = new URL((m[1] ?? "").trim(), ROAD_LIST_URL);
    } catch {
      continue;
    }
    // http のリンクも同じページとして扱う (取得する URL は、名前から https で作り直す)
    if (u.hostname !== "www.mlit.go.jp") continue;
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    const slug = DISASTER_PAGE.exec(u.pathname)?.[1];
    if (!slug || SKIP.has(slug) || out.includes(slug)) continue;
    if (out.length >= MAX_DISASTERS) break;
    out.push(slug);
  }
  return out;
}

/** 地図のページから、災害の名前と GeoJSON の URL を取る。形の違う URL は捨てる */
export function readDisasterMap(
  html: string,
  slug: string,
): { name: string; urls: string[] } {
  const base = disasterMapUrl(slug);
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
  // 「道路：令和８年熊本地震 通れるマップ - 国土交通省」(間は全角の空白) →「令和8年熊本地震」
  const name =
    title
      .normalize("NFKC")
      .replace(/^\s*道路\s*:\s*/, "")
      .replace(/\s*-\s*国土交通省\s*$/, "")
      .replace(/\s*\S*マップ\s*$/, "")
      .trim() || slug;
  const urls: string[] = [];
  for (const m of html.matchAll(/["']([^"'\s<>]+\.geojson)["']/g)) {
    let u: string;
    try {
      u = new URL(m[1] ?? "", base).toString();
    } catch {
      continue;
    }
    // 同じ災害の下にあるものだけ (ほかの災害の GeoJSON を、この災害の名前で出さない)
    if (
      DISCOVERED_GEOJSON.test(u) &&
      u.startsWith(`https://www.mlit.go.jp/road/saigai/${slug}/map/json/`) &&
      !urls.includes(u)
    )
      urls.push(u);
  }
  return { name, urls };
}

export interface Disaster {
  slug: string;
  name: string;
  urls: string[];
  etag?: string;
  modified?: string;
}

/** 表 `layer_cache` に置く、見つけたもの */
export interface Discovered {
  etag?: string;
  modified?: string;
  /** 最後にトップページを読めた時刻 (304 も含む) */
  checkedAt: string;
  disasters: Disaster[];
}

export const DISCOVER_CACHE_ID = "road:discover";

export function discovered(db: Database): Discovered | undefined {
  return new LayerCache(db).get<Discovered>(DISCOVER_CACHE_ID)?.data;
}

/** 見つけた GeoJSON の URL をまとめる */
export const discoveredUrls = (d: Discovered | undefined): string[] => [
  ...new Set(d?.disasters.flatMap((x) => x.urls) ?? []),
];

/** 自動の発見を使うか。既定はオン。`SONAE_ROAD_DISCOVER=off` で切る */
export const roadDiscoverOn = (
  env: string | undefined = process.env.SONAE_ROAD_DISCOVER,
) => env?.trim().toLowerCase() !== "off";

/**
 * トップページと地図のページを読み、見つけたものを表に置いて返す。
 * トップページが読めなければ例外 (前に見つけたものは表に残る)。
 * 地図のページが読めない災害は、前に見つけたものを使い続け、理由を `problems` に入れる
 */
export async function discoverOnce(
  db: Database,
  doFetch: typeof fetch,
  signal: AbortSignal,
  now: () => number,
): Promise<{ data: Discovered; problems: { name: string; error: string }[] }> {
  const cache = new LayerCache(db);
  const prev = cache.get<Discovered>(DISCOVER_CACHE_ID)?.data;
  const checkedAt = new Date(now()).toISOString();
  const res = await fetchGoJp(doFetch, ROAD_LIST_URL, signal, {
    accept: "text/html",
    etag: prev?.etag,
    modified: prev?.modified,
    maxBytes: PAGE_MAX_BYTES,
  });
  if (!res && prev) {
    const data = { ...prev, checkedAt };
    cache.put(DISCOVER_CACHE_ID, data, checkedAt);
    return { data, problems: [] };
  }
  if (!res)
    throw new Error(`${ROAD_LIST_URL} が前のものが無いのに 304 を返しました`);
  const slugs = disasterSlugs(
    await readLimited(res, PAGE_MAX_BYTES, ROAD_LIST_URL),
  );
  const problems: { name: string; error: string }[] = [];
  const disasters: Disaster[] = [];
  // 1 つずつ順に読む (同じ所へ並べて取得しない)
  for (const slug of slugs) {
    if (signal.aborted) break;
    const before = prev?.disasters.find((d) => d.slug === slug);
    try {
      const page = await fetchGoJp(doFetch, disasterMapUrl(slug), signal, {
        accept: "text/html",
        etag: before?.etag,
        modified: before?.modified,
        maxBytes: PAGE_MAX_BYTES,
      });
      if (!page) {
        if (before) disasters.push(before);
        continue;
      }
      const map = readDisasterMap(
        await readLimited(page, PAGE_MAX_BYTES, disasterMapUrl(slug)),
        slug,
      );
      if (map.urls.length === 0)
        throw new Error(
          `${map.name} の地図のページに GeoJSON が見当たりません`,
        );
      disasters.push({
        slug,
        ...map,
        etag: page.headers.get("etag") ?? undefined,
        modified: page.headers.get("last-modified") ?? undefined,
      });
    } catch (err) {
      if (signal.aborted) break;
      const name = before?.name ?? slug;
      problems.push({
        name,
        error: `${name} の地図のページが読めません: ${err}`,
      });
      if (before) disasters.push(before);
    }
  }
  const data: Discovered = {
    etag: res.headers.get("etag") ?? undefined,
    modified: res.headers.get("last-modified") ?? undefined,
    checkedAt,
    disasters,
  };
  // 地図のページが読めなかったときは、トップページの ETag を残さない (次も地図のページを読み直す)
  if (problems.length > 0) {
    delete data.etag;
    delete data.modified;
  }
  if (!signal.aborted) cache.put(DISCOVER_CACHE_ID, data, checkedAt);
  return { data, problems };
}
