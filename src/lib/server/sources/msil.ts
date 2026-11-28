/**
 * 海しる (海上保安庁の海洋状況表示システム) の API から、地図の点の層を 1 日 1 回取る (docs/design.md の 2.11)。
 *
 * - 取るのは海底地殻変動観測点 (GNSS-A、31 点)・海域火山データベース (35 点)・海上保安部署等 (191 点)・
 *   潮汐推算の地点の一覧。どれもめったに変わらない
 * - 潮汐推算の値 (1 日分) は、人が地点を押したときだけ取る (`TideFetcher`。地点と日ごとに覚え、取りに行く回数に上限)
 * - API のキー (`MSIL_API_KEY`) が無ければ作らない (層を出さないだけで、ほかは普段どおり)。キーはヘッダー
 *   `Ocp-Apim-Subscription-Key` で送り、URL・ログ・状態の欄・ブラウザには出さない
 * - 取ったものは表 `layer_cache` に置く。起動し直しても、前に取ってから 1 日たつまでは取りに行かない
 *   (利用規約の「短い間に大量に取りに行かない」)。層は 1 つずつ順に取る
 * - 1 回の答えは 1,000 件・64MB まで。超えると `exceededTransferLimit` が付くので、`resultOffset` で続きを取る
 * - 失敗したら 15 分から倍々に空ける (上限 6 時間)。前に取ったものがあれば、それを出し続ける
 *
 * 知らせには使わない (DB の events にも Broker にも入れない)。点の作り方は `#lib/map/marine.ts`
 */

import type { Database } from "bun:sqlite";

import type {
  MarineCollection,
  MarineFeature,
  MarineKind,
  MarinePoint,
  MarineResponse,
  TideDay,
} from "#lib/map/marine.ts";

import { LayerCache } from "../layer-cache.ts";
import { sleep, StatusTracker, USER_AGENT } from "./retry.ts";
import type { Source, SourceContext } from "./types.ts";

export const MSIL_API = "https://api.msil.go.jp";

export interface MsilLayer {
  kind: MarineKind;
  /** API の頭 (`https://api.msil.go.jp/<path>/v2/MapServer/<layer>/query`) */
  path: string;
  layer: number;
  /**
   * ArcGIS の MapServer ではない API (潮汐推算の地点の一覧) の URL。あれば `path`・`layer` からは組まず、
   * 続き (`resultOffset`) も取らない
   */
  url?: string;
  parse(props: Record<string, unknown>): Omit<MarinePoint, "kind"> | undefined;
}

const str = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** 海上保安庁のページの URL だけを採る (画面にリンクとして出すため) */
function kaihoUrl(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  // 海域火山 DB は `<a href="…" target="_blank">…</A>` の形で来る
  const href = /href\s*=\s*"([^"]+)"/i.exec(s)?.[1] ?? s;
  return /^https:\/\/[a-z0-9.-]*\.mlit\.go\.jp\/[^\s"<>]*$/i.test(href)
    ? href
    : undefined;
}

/** 「732m」「-81m」「‐95m」(全角や別のハイフン) を m の数に。読めなければ undefined */
export function heightOf(v: unknown): number | undefined {
  const s = str(v)
    ?.replace(/[‐‑‒–—−－]/g, "-")
    .replace(/\s/g, "");
  const m = s ? /^(-?\d+(?:\.\d+)?)m$/i.exec(s) : null;
  return m ? Number(m[1]) : undefined;
}

/** 潮汐推算の地点のコード (「0114」)。`/api/tide` で受けるコードもこの形だけ */
export const TIDE_CODE = /^[0-9A-Za-z]{1,10}$/;

export const MSIL_LAYERS: MsilLayer[] = [
  {
    kind: "gnssa",
    path: "seabed-crust-deformation-info",
    layer: 1,
    parse(p) {
      const name = str(p.観測地点名);
      if (!name) return undefined;
      const depth = p.設置水深_m;
      return {
        name,
        depthM:
          typeof depth === "number" && Number.isFinite(depth)
            ? depth
            : undefined,
        org: str(p.設置機関),
        since: str(p.設置年月),
        url: kaihoUrl(p.URL),
      };
    },
  },
  {
    kind: "volcano",
    path: "marine-volcano-DB",
    layer: 1,
    parse(p) {
      const name = str(p.火山名);
      if (!name) return undefined;
      const point = str(p.点名);
      return {
        name,
        point: point && point !== name ? point : undefined,
        heightM: heightOf(p.標高_水深),
        basis: str(p.出典),
        url: kaihoUrl(p.URL),
      };
    },
  },
  {
    kind: "office",
    path: "coast-guard-office",
    layer: 1,
    // 属性は 名称・読み・郵便番号・所在地・電話番号・リンク (a 要素)・更新日 (海しるの開発者ポータルの例)
    parse(p) {
      const name = str(p.名称);
      if (!name) return undefined;
      const zip = str(p.郵便番号);
      const addr = str(p.所在地);
      return {
        name,
        address: addr ? (zip ? `〒${zip} ${addr}` : addr) : undefined,
        phone: str(p.電話番号),
        url: kaihoUrl(p.リンク),
      };
    },
  },
  {
    kind: "tide",
    path: "tide-prediction",
    layer: 0,
    url: `${MSIL_API}/tide-prediction/v3/station`,
    // 属性は stationCode・nameJa・nameEn (海しるの開発者ポータルの仕様)
    parse(p) {
      const name = str(p.nameJa);
      const code = str(p.stationCode);
      if (!name || !code || !TIDE_CODE.test(code)) return undefined;
      return { name, code };
    },
  },
];

export const msilUrl = (l: Pick<MsilLayer, "path" | "layer">, offset = 0) =>
  `${MSIL_API}/${l.path}/v2/MapServer/${l.layer}/query?${new URLSearchParams({
    f: "geojson",
    where: "1=1",
    outFields: "*",
    ...(offset > 0 ? { resultOffset: String(offset) } : {}),
  })}`;

/** 1 回の答え (GeoJSON) を点に。形が違えば例外。`more` は続きがあるか (`exceededTransferLimit`) */
export function parseMsil(
  l: MsilLayer,
  text: string,
): { features: MarineFeature[]; count: number; more: boolean } {
  const doc = JSON.parse(text) as Record<string, unknown>;
  if (!Array.isArray(doc.features))
    throw new Error(`${l.path} の答えに features がありません`);
  const features = doc.features.flatMap((f): MarineFeature[] => {
    if (typeof f !== "object" || f === null) return [];
    const o = f as Record<string, unknown>;
    const g = o.geometry as { type?: unknown; coordinates?: unknown } | null;
    const c = g?.coordinates;
    if (
      g?.type !== "Point" ||
      !Array.isArray(c) ||
      typeof c[0] !== "number" ||
      typeof c[1] !== "number" ||
      !Number.isFinite(c[0]) ||
      !Number.isFinite(c[1])
    )
      return [];
    const p = l.parse((o.properties ?? {}) as Record<string, unknown>);
    if (!p) return [];
    return [
      {
        type: "Feature",
        // 0.00001 度 (約 1 m) に丸める
        geometry: {
          type: "Point",
          coordinates: [
            Math.round(c[0] * 1e5) / 1e5,
            Math.round(c[1] * 1e5) / 1e5,
          ],
        },
        properties: { kind: l.kind, ...p },
      },
    ];
  });
  const more =
    doc.exceededTransferLimit === true ||
    (doc.properties as Record<string, unknown> | undefined)
      ?.exceededTransferLimit === true;
  return { features, count: doc.features.length, more };
}

/** 続きを取りに行く回数の上限 (1 回 1,000 件。いまは 1 回で済む) */
const MAX_PAGES = 20;
export const MSIL_INTERVAL_MS = 24 * 60 * 60_000;
const RETRY_MS = 15 * 60_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;
/** 1 回目の答えに 19 秒かかったことがある (2026-11-20) */
const TIMEOUT_MS = 90_000;

export const cacheId = (kind: MarineKind) => `msil-${kind}`;

export interface MsilOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
  onStatus?: SourceContext["onStatus"];
}

/** 置いてある点を、画面に渡す形にまとめる (`/api/marine`) */
export function marineResponse(db: Database, enabled: boolean): MarineResponse {
  const cache = new LayerCache(db);
  const fetchedAt: MarineResponse["fetchedAt"] = {};
  const features: MarineFeature[] = [];
  if (enabled)
    for (const l of MSIL_LAYERS) {
      const c = cache.get<MarineCollection>(cacheId(l.kind));
      if (!c) continue;
      fetchedAt[l.kind] = c.fetchedAt;
      features.push(...c.data.features);
    }
  return { enabled, fetchedAt, data: { type: "FeatureCollection", features } };
}

/** 環境変数の API のキー。無ければ undefined */
export const msilKey = () => process.env.MSIL_API_KEY?.trim() || undefined;

/** キーがあれば海しるの情報源を作る。無ければ undefined (受信の一覧には `off` で並べる) */
export function msilSource(
  db: Database,
  key: string | undefined = msilKey(),
  o: MsilOptions = {},
): Source | undefined {
  const k = key?.trim();
  if (!k) return undefined;
  const cache = new LayerCache(db);
  const status = new StatusTracker("msil", o.onStatus, {
    kind: "poll",
    everyMs: MSIL_INTERVAL_MS,
  });
  const doFetch = o.fetch ?? fetch;
  const wait = o.sleep ?? sleep;
  const now = o.now ?? Date.now;
  const log = o.log ?? ((m: string) => console.log(m));

  async function fetchLayer(
    l: MsilLayer,
    signal: AbortSignal,
  ): Promise<MarineFeature[]> {
    const all: MarineFeature[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await doFetch(l.url ?? msilUrl(l, offset), {
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/geo+json, application/json",
          "ocp-apim-subscription-key": k as string,
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        redirect: "follow",
      });
      // 答えの本文に鍵は入らないが、念のため状態の欄には番号だけを出す
      if (!res.ok) throw new Error(`${l.path} が ${res.status} を返しました`);
      const r = parseMsil(l, await res.text());
      all.push(...r.features);
      if (l.url || !r.more || r.count === 0) return all;
      offset += r.count;
    }
    throw new Error(`${l.path} の続きが ${MAX_PAGES} 回で終わりませんでした`);
  }

  /** 取り直す時刻 (ミリ秒)。置いていない層があればいま */
  const due = () =>
    Math.min(
      ...MSIL_LAYERS.map((l) => {
        const t = Date.parse(cache.get(cacheId(l.kind))?.fetchedAt ?? "");
        return Number.isFinite(t) ? t + MSIL_INTERVAL_MS : 0;
      }),
    );
  const hasAll = () =>
    MSIL_LAYERS.every((l) => cache.get(cacheId(l.kind)) !== undefined);

  return {
    id: "msil",
    status: () => status.get(),
    async run(signal) {
      let failures = 0;
      while (!signal.aborted) {
        let delay = 0;
        try {
          for (const l of MSIL_LAYERS) {
            const c = cache.get(cacheId(l.kind));
            const t = Date.parse(c?.fetchedAt ?? "");
            if (Number.isFinite(t) && now() - t < MSIL_INTERVAL_MS) continue;
            const features = await fetchLayer(l, signal);
            // 空の答えは、相手の不具合とみなして前のものを残す (31 点・35 点が急に無くなることは無い)
            if (features.length === 0)
              throw new Error(`${l.path} の点が 0 でした`);
            cache.put(
              cacheId(l.kind),
              { type: "FeatureCollection", features },
              new Date(now()).toISOString(),
            );
            status.seen(true);
            log(`[msil] ${l.path} を取りました (${features.length} 点)`);
          }
          failures = 0;
          status.seen(false);
          status.recovered();
          status.set("connected");
          delay = Math.max(60_000, due() - now());
        } catch (err) {
          if (signal.aborted) break;
          failures++;
          const why = String(err);
          log(`[msil] 取れませんでした: ${why}`);
          // 前に取ったものがあれば、それを出し続けているので「受信中」のまま、直近のエラーだけを出す
          status.set(hasAll() ? "connected" : "retrying", why);
          delay = Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** (failures - 1));
        }
        await wait(delay, signal);
      }
      status.set("stopped");
    },
  };
}

/** 潮汐推算の値を取りに行く回数の上限 (`TIDE_WINDOW_MS` の間に)。家族の数台が地点を押す量には足りる */
export const TIDE_MAX_FETCHES = 30;
export const TIDE_WINDOW_MS = 10 * 60_000;
/** 覚えておく地点と日の数 (1 つ 1 日分で 6KB ほど) */
const TIDE_CACHE_SIZE = 64;
const TIDE_TIMEOUT_MS = 30_000;

export const tideUrl = (code: string, date: string) =>
  `${MSIL_API}/tide-prediction/v3/data?${new URLSearchParams({
    stationCode: code,
    date: date.replaceAll("-", ""),
  })}`;

/** 日本時間の暦日 (`YYYY-MM-DD`) */
const jstDay = (ms: number) =>
  new Date(ms + 9 * 60 * 60_000).toISOString().slice(0, 10);

/**
 * 推算潮位の答え (`{ time, interval, stationCode, tide }`) を読む。形が違えば例外。
 * `interval` は秒 (仕様の説明は「1分毎」で既定は 60)。値の並びが半日に満たないときは、分とみなす
 * (仕様の例は 1 時間ごと 24 個に見えるため)。`time` が無ければその日の 0 時 (日本時間) から
 */
export function parseTide(code: string, date: string, text: string): TideDay {
  const doc = JSON.parse(text) as Record<string, unknown>;
  const tide = doc.tide;
  if (
    !Array.isArray(tide) ||
    tide.length < 2 ||
    tide.length > 5000 ||
    !tide.every((v) => typeof v === "number" && Number.isFinite(v))
  )
    throw new Error("推算潮位の答えに tide がありません");
  const interval =
    typeof doc.interval === "number" && doc.interval > 0 ? doc.interval : 60;
  const stepSec =
    tide.length * interval < 12 * 60 * 60 ? interval * 60 : interval;
  const time = typeof doc.time === "string" ? doc.time : "";
  const start = Number.isFinite(Date.parse(time))
    ? new Date(Date.parse(time)).toISOString()
    : new Date(Date.parse(`${date}T00:00:00+09:00`)).toISOString();
  return { code, date, start, stepSec, tide: tide as number[] };
}

/**
 * 潮汐推算の 1 日分の値を、人が地点を押したときだけ取る (`/api/tide`)。推算の値は日ごとに決まって変わらないので、
 * 地点と日ごとにメモリに覚え、同じ地点を押し直しても取りに行かない。取りに行く回数は 10 分に 30 回まで
 * (海しる API 利用規約の「短い間に大量に取りに行かない」)。地点は、1 日 1 回取った地点の一覧にあるコードだけ
 */
export class TideFetcher {
  private readonly cache = new Map<string, TideDay>();
  private readonly inflight = new Map<string, Promise<TideDay>>();
  private fetches: number[] = [];
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    private readonly key: string,
    o: Pick<MsilOptions, "fetch" | "now"> = {},
  ) {
    this.doFetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  /** 地点の名前 (一覧にあれば)。無ければ undefined */
  station(code: string): string | undefined {
    if (!TIDE_CODE.test(code)) return undefined;
    const c = new LayerCache(this.db).get<MarineCollection>(cacheId("tide"));
    return c?.data.features.find((f) => f.properties.code === code)?.properties
      .name;
  }

  /** 今日 (日本時間) の推算の値。地点が無い・回数の上限なら `TideRefused` を投げる */
  async today(code: string): Promise<TideDay> {
    if (this.station(code) === undefined)
      throw new TideRefused("この地点の潮汐推算はありません", 404);
    const date = jstDay(this.now());
    const id = `${code}-${date}`;
    const hit = this.cache.get(id);
    if (hit) return hit;
    const running = this.inflight.get(id);
    if (running) return running;
    const t = this.now();
    this.fetches = this.fetches.filter((x) => t - x < TIDE_WINDOW_MS);
    if (this.fetches.length >= TIDE_MAX_FETCHES)
      throw new TideRefused(
        "潮汐推算を短い間に読みすぎています。しばらくしてから開き直してください",
        429,
      );
    this.fetches.push(t);
    const p = (async () => {
      const res = await this.doFetch(tideUrl(code, date), {
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json",
          "ocp-apim-subscription-key": this.key,
        },
        signal: AbortSignal.timeout(TIDE_TIMEOUT_MS),
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`潮汐推算が ${res.status} を返しました`);
      const day = parseTide(code, date, await res.text());
      this.cache.set(id, day);
      // 古い日と、多すぎる分を捨てる (Map は足した順)
      for (const k of this.cache.keys())
        if (!k.endsWith(date) || this.cache.size > TIDE_CACHE_SIZE)
          this.cache.delete(k);
      return day;
    })();
    this.inflight.set(id, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(id);
    }
  }
}

/** 取りに行かずに断ったとき (地点が無い・回数の上限)。文はそのまま画面に出す */
export class TideRefused extends Error {
  constructor(
    message: string,
    readonly status: 404 | 429,
  ) {
    super(message);
  }
}
