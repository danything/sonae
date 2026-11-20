/**
 * 海しる (海上保安庁の海洋状況表示システム) の API から、地図の点の層を 1 日 1 回取る (docs/design.md の 2.11)。
 *
 * - 取るのは海底地殻変動観測点 (GNSS-A、31 点) と海域火山データベース (35 点) だけ。どちらもめったに変わらない
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
  const status = new StatusTracker("msil", o.onStatus);
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
      const res = await doFetch(msilUrl(l, offset), {
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
      if (!r.more || r.count === 0) return all;
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
