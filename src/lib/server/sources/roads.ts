/**
 * 災害時の通行止め。国土交通省が災害ごとに出す GeoJSON (「通れるマップ」の道路規制情報と ETC2.0 の平均速度) を、
 * 30 分ごとに取る (docs/design.md の 2.12)。
 *
 * - URL は、国土交通省 道路局のページから 3 時間ごとに自動で見つける (`./road-discover.ts`。`SONAE_ROAD_DISCOVER=off` で切る) のと、
 *   環境変数 `SONAE_ROAD_GEOJSON` に書いたもの (カンマか空白で区切る。見つからないときの予備) を合わせる
 * - 取得するのは https の `*.go.jp` だけ (サーバーが取得する先を、国の機関に絞る)
 * - `If-None-Match`・`If-Modified-Since` を付ける。取ったものは表 `layer_cache` に置き、取れない間は前のものを出す
 * - 道路規制情報は、全面通行止めで、まだ解除されていないものだけを採る。解除は、規制内容の「解除」と、
 *   通れるマップの色 (灰色は「規制解除後」) で見分ける (色の意味は通れるマップの凡例)
 * - ETC2.0 の平均速度は、通れるマップの色 (橙は時速 20 km 以下、青は 21 km 以上) を区分にする
 *
 * 知らせには使わない (DB の events にも Broker にも入れない)。線の作り方は `#lib/map/roads.ts`
 */

import type { Database } from "bun:sqlite";

import type {
  RoadCollection,
  RoadFeature,
  RoadLine,
  RoadResponse,
} from "#lib/map/roads.ts";

import { LayerCache } from "../layer-cache.ts";
import { sleep, StatusTracker, USER_AGENT } from "./retry.ts";
import {
  DISCOVER_INTERVAL_MS,
  discovered,
  discoveredUrls,
  discoverOnce,
  roadDiscoverOn,
} from "./road-discover.ts";
import type { Source, SourceContext } from "./types.ts";

export const ROAD_INTERVAL_MS = 30 * 60_000;
const RETRY_MS = 5 * 60_000;
const MAX_URLS = 10;
/** 1 つのファイルの大きさの上限 (ETC2.0 の速度は 1 つ 3〜12MB だった) */
const MAX_BYTES = 30 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/** 登録できる URL か (https の `*.go.jp`)。だめなら理由 */
export function roadUrlProblem(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "URL として読めません";
  }
  if (u.protocol !== "https:") return "https ではありません";
  if (u.username || u.password) return "ユーザー名やパスワードは書けません";
  if (!/(^|\.)go\.jp$/i.test(u.hostname))
    return "国の機関 (go.jp) の URL ではありません";
  return undefined;
}

/** 環境変数から URL の並びを読む。だめなものは理由を添えて外す */
export function roadUrls(
  env: string | undefined = process.env.SONAE_ROAD_GEOJSON,
): {
  urls: string[];
  rejected: { url: string; why: string }[];
} {
  const urls: string[] = [];
  const rejected: { url: string; why: string }[] = [];
  for (const raw of (env ?? "").split(/[\s,]+/)) {
    if (!raw) continue;
    const why =
      roadUrlProblem(raw) ??
      (urls.length >= MAX_URLS
        ? `${MAX_URLS} より多くは登録できません`
        : undefined);
    if (why) rejected.push({ url: raw, why });
    else if (!urls.includes(raw)) urls.push(raw);
  }
  return { urls, rejected };
}

const str = (v: unknown) =>
  typeof v === "string" && v.trim() !== ""
    ? v.trim()
    : typeof v === "number" && Number.isFinite(v)
      ? String(v)
      : undefined;
const num = (v: unknown) => {
  const s = str(v);
  return s !== undefined && Number.isFinite(Number(s)) ? Number(s) : undefined;
};

/** `#rrggbb` を [r, g, b] に */
function rgb(v: unknown): [number, number, number] | undefined {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(str(v) ?? "");
  return m
    ? [
        parseInt(m[1] ?? "", 16),
        parseInt(m[2] ?? "", 16),
        parseInt(m[3] ?? "", 16),
      ]
    : undefined;
}
/** 通れるマップの凡例の「規制解除後」の灰色 (色みが無く明るい) */
const releasedGray = (c: [number, number, number] | undefined) =>
  c !== undefined &&
  Math.max(...c) - Math.min(...c) < 16 &&
  Math.min(...c) >= 0x90;
/** ETC2.0 の速度の色。橙 (#ff9900) は時速 20 km 以下、青 (#0000ff) は 21 km 以上。ほかは分からない */
function speedClass(c: [number, number, number] | undefined) {
  if (!c) return undefined;
  const [r, g, b] = c;
  if (b > 0xa0 && r < 0x60) return "fast";
  if (r > 0xc0 && g > 0x60 && g < 0xd0 && b < 0x60) return "slow";
  return undefined;
}

const round = (c: unknown): [number, number] | undefined =>
  Array.isArray(c) &&
  typeof c[0] === "number" &&
  typeof c[1] === "number" &&
  Number.isFinite(c[0]) &&
  Number.isFinite(c[1])
    ? [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5]
    : undefined;
function line(c: unknown): [number, number][] | undefined {
  if (!Array.isArray(c)) return undefined;
  const pts = c.flatMap((p) => {
    const r = round(p);
    return r ? [r] : [];
  });
  return pts.length >= 2 ? pts : undefined;
}
function geometryOf(g: unknown): RoadFeature["geometry"] | undefined {
  if (typeof g !== "object" || g === null) return undefined;
  const o = g as { type?: unknown; coordinates?: unknown };
  if (o.type === "LineString") {
    const l = line(o.coordinates);
    return l ? { type: "LineString", coordinates: l } : undefined;
  }
  if (o.type === "MultiLineString" && Array.isArray(o.coordinates)) {
    const ls = o.coordinates.flatMap((c) => {
      const l = line(c);
      return l ? [l] : [];
    });
    return ls.length > 0
      ? { type: "MultiLineString", coordinates: ls }
      : undefined;
  }
  return undefined;
}

/** 区間。「八代JCT〜八代南IC」、無ければ住所、それも無ければ市町村 */
function sectionOf(p: Record<string, unknown>): string | undefined {
  const pair = (a?: string, b?: string) =>
    a && b ? (a === b ? a : `${a}〜${b}`) : (a ?? b);
  return (
    pair(str(p.始点), str(p.終点)) ??
    pair(str(p.始点住所), str(p.終点住所)) ??
    [str(p.県名), str(p.市町村名)].filter(Boolean).join("") ??
    undefined
  );
}

const CLOSURE_KEYS = [
  "規制内容",
  "規制開始_内容",
  "規制種別",
  "路線名",
  "道路種別",
];

/** 1 つの feature を線に。採らないもの (解除・全面通行止め でない規制・色の分からない速度) は undefined */
export function roadLine(f: unknown, updated: string): RoadFeature | undefined {
  if (typeof f !== "object" || f === null) return undefined;
  const o = f as Record<string, unknown>;
  const geometry = geometryOf(o.geometry);
  if (!geometry) return undefined;
  const p = (o.properties ?? {}) as Record<string, unknown>;
  const color = rgb(p._color);
  let props: RoadLine | undefined;
  if (CLOSURE_KEYS.some((k) => k in p)) {
    const rule = str(p.規制内容) ?? str(p.規制開始_内容);
    const released =
      /解除/.test(rule ?? "") ||
      str(p.規制解除_日時) !== undefined ||
      releasedGray(color);
    if (!rule || !/全面通行止/.test(rule) || released) return undefined;
    props = {
      kind: "closed",
      route: str(p.路線名) ?? str(p.道路種別),
      section: sectionOf(p) || undefined,
      rule: rule.replace(/全面通行止$/, "全面通行止め"),
      reason: str(p.規制理由),
      since: str(p.規制開始_日時),
      lengthKm: num(p.規制延長_Km) ?? num(p.延長_Km),
      updated,
    };
  } else {
    const s = speedClass(color);
    if (!s) return undefined;
    props = { kind: "speed", slow: s === "slow", updated };
  }
  // 無い項目は持たない (JSON を小さくする)
  for (const k of Object.keys(props) as (keyof RoadLine)[])
    if (props[k] === undefined) delete props[k];
  return { type: "Feature", properties: props, geometry };
}

/** 答えの本文を線の並びに。形が違えば例外 */
export function parseRoads(text: string, updated: string): RoadFeature[] {
  const doc = JSON.parse(text.replace(/^﻿/, "")) as Record<string, unknown>;
  if (!Array.isArray(doc.features))
    throw new Error("GeoJSON の features がありません");
  return doc.features.flatMap((f) => {
    const r = roadLine(f, updated);
    return r ? [r] : [];
  });
}

const MAX_REDIRECTS = 3;

/** 本文を数えながら読み、上限を超えたらそこでやめる (content-length の無い応答のため) */
export async function readLimited(
  res: Response,
  max: number,
  url: string,
): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`${url} が大きすぎます (${max} バイトより多い)`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * https の go.jp の URL を、`If-None-Match`・`If-Modified-Since` を付けて取る。304 なら undefined。
 * リダイレクトは自分で 3 回まで辿り、行き先も https の go.jp か確かめる (go.jp に絞った意味を、リダイレクトで崩さない)。
 * 200 でなければ例外。content-length が上限を超えていれば読まずに例外
 */
export async function fetchGoJp(
  doFetch: typeof fetch,
  url: string,
  signal: AbortSignal,
  o: { accept: string; etag?: string; modified?: string; maxBytes?: number },
): Promise<Response | undefined> {
  const first = roadUrlProblem(url);
  if (first) throw new Error(`${url} は使いません (${first})`);
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: o.accept,
  };
  if (o.etag) headers["if-none-match"] = o.etag;
  if (o.modified) headers["if-modified-since"] = o.modified;
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  let at = url;
  let res: Response | undefined;
  for (let hop = 0; ; hop++) {
    res = await doFetch(at, { headers, signal: timeout, redirect: "manual" });
    if (res.status < 300 || res.status >= 400 || res.status === 304) break;
    const next = res.headers.get("location");
    await res.body?.cancel();
    if (!next || hop >= MAX_REDIRECTS)
      throw new Error(`${url} のリダイレクトを辿れません (${res.status})`);
    at = new URL(next, at).toString();
    const why = roadUrlProblem(at);
    if (why)
      throw new Error(`${url} のリダイレクト先 ${at} は使いません (${why})`);
  }
  if (res.status === 304) return undefined;
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${url} が ${res.status} を返しました`);
  }
  const max = o.maxBytes ?? MAX_BYTES;
  const size = Number(res.headers.get("content-length") ?? 0);
  if (size > max) {
    await res.body?.cancel();
    throw new Error(`${url} が大きすぎます (${size} バイト)`);
  }
  return res;
}

interface CachedRoads {
  etag?: string;
  modified?: string;
  data: RoadCollection;
}
export const roadCacheId = (url: string) => `road:${url}`;

/** 登録してある URL の、置いてある線をまとめる (`/api/roads`)。速度の細い線を先に、通行止めを後に */
export function roadResponse(db: Database, urls: string[]): RoadResponse {
  const cache = new LayerCache(db);
  const all = urls.flatMap(
    (u) => cache.get<CachedRoads>(roadCacheId(u))?.data.data.features ?? [],
  );
  const features = [
    ...all.filter((f) => f.properties.kind === "speed"),
    ...all.filter((f) => f.properties.kind === "closed"),
  ];
  return {
    enabled: urls.length > 0,
    data: { type: "FeatureCollection", features },
  };
}

/** 地図に出す URL。環境変数で登録したものと、自動で見つけたもの (`/api/roads` と取得する輪で同じものを使う) */
export function activeRoadUrls(
  db: Database,
  manual: string[] = roadUrls().urls,
  discover: boolean = roadDiscoverOn(),
): string[] {
  return [
    ...new Set([
      ...manual,
      ...(discover ? discoveredUrls(discovered(db)) : []),
    ]),
  ];
}

export interface RoadOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
  onStatus?: SourceContext["onStatus"];
  /** 国土交通省 道路局のページから災害を自動で見つけるか (既定はしない。receiver が環境変数から渡す) */
  discover?: boolean;
}

/** 登録した URL があるか、自動の発見を使うなら情報源を作る。どちらも無ければ undefined (「受信の状態」には `off` で並べる) */
export function roadSource(
  db: Database,
  manual: string[],
  o: RoadOptions = {},
): Source | undefined {
  const discover = o.discover ?? false;
  if (manual.length === 0 && !discover) return undefined;
  const cache = new LayerCache(db);
  const status = new StatusTracker("roads", o.onStatus, {
    kind: "poll",
    everyMs: ROAD_INTERVAL_MS,
  });
  const doFetch = o.fetch ?? fetch;
  const wait = o.sleep ?? sleep;
  const now = o.now ?? Date.now;
  const log = o.log ?? ((m: string) => console.log(m));

  async function fetchOne(url: string, signal: AbortSignal): Promise<boolean> {
    const id = roadCacheId(url);
    const prev = cache.get<CachedRoads>(id);
    const res = await fetchGoJp(doFetch, url, signal, {
      accept: "application/geo+json, application/json",
      etag: prev?.data.etag,
      modified: prev?.data.modified,
    });
    if (!res) return false;
    const text = await readLimited(res, MAX_BYTES, url);
    const modified = res.headers.get("last-modified") ?? undefined;
    const t = Date.parse(modified ?? "");
    const updated = new Date(Number.isFinite(t) ? t : now()).toISOString();
    const features = parseRoads(text, updated);
    cache.put(
      id,
      {
        etag: res.headers.get("etag") ?? undefined,
        modified,
        data: { type: "FeatureCollection", features },
      } satisfies CachedRoads,
      new Date(now()).toISOString(),
    );
    log(
      `[roads] ${url} を取りました (通行止め ${features.filter((f) => f.properties.kind === "closed").length}・速度 ${features.filter((f) => f.properties.kind === "speed").length})`,
    );
    return true;
  }

  // 自動の発見の状態 (「受信の状態」に出す)
  let problem: string | undefined;
  const showDetail = () => {
    const d = discover ? discovered(db) : undefined;
    status.detail({
      roads: {
        discover,
        disasters: d?.disasters.map((x) => x.name) ?? [],
        manual: manual.length,
        checkedAt: d?.checkedAt,
        problem,
      },
    });
  };
  showDetail();

  return {
    id: "roads",
    status: () => status.get(),
    async run(signal) {
      let failures = 0;
      // 起動し直したときは、前に一覧を読んだ時刻から 3 時間たつまで読み直さない
      const last = Date.parse(discovered(db)?.checkedAt ?? "");
      let nextDiscover = Number.isFinite(last)
        ? last + DISCOVER_INTERVAL_MS
        : 0;
      while (!signal.aborted) {
        const errors: string[] = [];
        let fresh = false;
        if (discover && now() >= nextDiscover) {
          try {
            const r = await discoverOnce(db, doFetch, signal, now);
            problem =
              r.problems.length > 0
                ? `${r.problems.map((p) => p.name).join("、")}の地図のページが読めません`
                : undefined;
            errors.push(...r.problems.map((p) => p.error));
            log(
              `[roads] 一覧を読みました (災害 ${r.data.disasters.length} 件${r.data.disasters.map((d) => `・${d.name}`).join("")})`,
            );
            // 地図のページが読めない災害があれば、一覧が読めないときと同じく 30 分後に読み直す
            nextDiscover =
              now() +
              (r.problems.length > 0 ? ROAD_INTERVAL_MS : DISCOVER_INTERVAL_MS);
          } catch (err) {
            if (signal.aborted) break;
            problem = "一覧が読めません";
            errors.push(`一覧が読めません: ${err}`);
            // 読めなければ 30 分後に読み直す
            nextDiscover = now() + ROAD_INTERVAL_MS;
          }
          showDetail();
        }
        const urls = activeRoadUrls(db, manual, discover);
        // 1 つずつ順に取る (同じ所へ並べて取得しない)
        for (const url of urls) {
          if (signal.aborted) break;
          try {
            if (await fetchOne(url, signal)) fresh = true;
          } catch (err) {
            if (signal.aborted) break;
            errors.push(String(err));
          }
        }
        if (signal.aborted) break;
        status.seen(fresh);
        let delay = ROAD_INTERVAL_MS;
        if (errors.length === 0) {
          failures = 0;
          status.recovered();
          status.set("connected");
        } else {
          failures++;
          const why = errors.join(" / ");
          log(`[roads] 取れませんでした: ${why}`);
          // 前に取ったものがあれば出し続けているので「受信中」のまま、直近のエラーだけを出す。
          // 取得する URL が無いとき (一覧が読めないだけ) も「受信中」のまま
          const cached =
            urls.length === 0 || urls.some((u) => cache.get(roadCacheId(u)));
          status.set(cached ? "connected" : "retrying", why);
          delay = Math.min(ROAD_INTERVAL_MS, RETRY_MS * 2 ** (failures - 1));
        }
        await wait(delay, signal);
      }
      status.set("stopped");
    },
  };
}
