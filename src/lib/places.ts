/**
 * 場所の検索 (ヘッダーの検索の欄の「場所の候補」。docs/map.md の「場所の検索」)。DOM にも MapLibre にも触らない。
 *
 * - 市町村は手元のデータ (`static/areas/cities.json` と、市町村等の外枠の表 `offices.json`) から探す。外へは問い合わせない
 * - 住所・地名は国土地理院の住所検索 (地理院地図が使っているもの) に、ブラウザから直接問い合わせる。
 *   送るのは打った文字だけで、sonae のサーバーは通さない (残さない)
 */

import { type Cities, prefectureOf } from "./home.ts";
import type { OfficeTable } from "./map/style.ts";

/** 国土地理院の住所検索。CORS は `*` (2026-11-15 に確かめた) */
export const GSI_ADDRESS_SEARCH =
  "https://msearch.gsi.go.jp/address-search/AddressSearch";

/** 外へ問い合わせるのは、この文字数から (1 文字では候補が多すぎて役に立たない) */
export const REMOTE_MIN_CHARS = 2;
/** 打つのが止まってから問い合わせるまで (ミリ秒)。打つたびには送らない */
export const REMOTE_DELAY_MS = 600;
/** 候補の数の上限 */
export const PLACE_LIMIT = 8;

export interface Place {
  /** 候補の鍵 (並びの中で一意) */
  id: string;
  /** 市町村 (手元のデータ) か、住所・地名 (国土地理院) か */
  kind: "city" | "address";
  /** 候補の名前 (「東京都千代田区」「東京都千代田区霞が関一丁目３番」) */
  label: string;
  /** 寄せる所 [経度, 緯度] */
  at: [number, number];
  /** 市町村の外枠 [西, 南, 東, 北] (市町村だけ。収まるように寄せる) */
  bounds?: [number, number, number, number];
}

/** 比べるための形 (全角・半角の揺れと、「ヶ」「ケ」の揺れ (霞ヶ浦・霞ケ浦) をそろえ、空白を除く) */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[ヶヵ]/g, "ケ")
    .toLowerCase();
}

/** 外へ問い合わせてよい文字か (2 文字から) */
export const shouldQuery = (query: string): boolean =>
  normalize(query).length >= REMOTE_MIN_CHARS;

/** 市町村等の外枠を、どの府県予報区かにかかわらず引けるようにする */
export function cityBounds(
  offices: OfficeTable,
): Map<string, [number, number, number, number]> {
  const out = new Map<string, [number, number, number, number]>();
  for (const cities of Object.values(offices))
    for (const [code, b] of Object.entries(cities)) out.set(code, b);
  return out;
}

/**
 * 手元の市町村から探す。並びは、名前がそのまま同じ・名前の頭が同じ・府県と市町村の名前のどこかに入る、の順。
 * 同じ段は市町村等のコードの順
 */
export function localPlaces(
  query: string,
  cities: Cities,
  bounds: Map<string, [number, number, number, number]>,
  limit = PLACE_LIMIT,
): Place[] {
  const q = normalize(query);
  if (q === "") return [];
  const hits: { rank: number; code: string; place: Place }[] = [];
  for (const [code, row] of Object.entries(cities)) {
    const [name] = row;
    // 2 列目は分けた市町村 (仙台市東部など) では説明の文なので、府県の名前を前に付けて作る (`homeOf` と同じ)
    const full = `${prefectureOf(code)}${name}`;
    const n = normalize(name);
    const f = normalize(full);
    const rank =
      n === q || f === q
        ? 0
        : n.startsWith(q) || f.startsWith(q)
          ? 1
          : f.includes(q)
            ? 2
            : -1;
    if (rank < 0) continue;
    const b = bounds.get(code);
    if (!b) continue;
    hits.push({
      rank,
      code,
      place: {
        id: `city:${code}`,
        kind: "city",
        label: full,
        at: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2],
        bounds: b,
      },
    });
  }
  return hits
    .sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code))
    .slice(0, limit)
    .map((h) => h.place);
}

/** 国土地理院の住所検索の応答 (GeoJSON の Feature の配列) を候補にする。形の違うものは捨てる */
export function parseGsi(json: unknown): Place[] {
  if (!Array.isArray(json)) return [];
  const out: Place[] = [];
  for (const f of json as {
    geometry?: { coordinates?: unknown };
    properties?: { title?: unknown };
  }[]) {
    const c = f?.geometry?.coordinates;
    const title = f?.properties?.title;
    if (
      !Array.isArray(c) ||
      typeof c[0] !== "number" ||
      typeof c[1] !== "number" ||
      !Number.isFinite(c[0]) ||
      !Number.isFinite(c[1]) ||
      typeof title !== "string" ||
      title === ""
    )
      continue;
    out.push({
      id: `gsi:${title}:${c[0]},${c[1]}`,
      kind: "address",
      label: title,
      at: [c[0], c[1]],
    });
  }
  return out;
}

/**
 * 手元の市町村を先に、住所・地名を後に並べる。住所検索が市町村そのもの (「北海道札幌市」) を返したときは、
 * 手元の市町村 (外枠に収まるように寄せられる) と重なるので捨てる。同じ名前の住所も 1 つにする
 */
export function mergePlaces(
  local: Place[],
  remote: Place[],
  limit = PLACE_LIMIT,
): Place[] {
  const seen = new Set(local.map((p) => normalize(p.label)));
  const extra: Place[] = [];
  for (const p of remote) {
    const key = normalize(p.label);
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(p);
  }
  // 市町村が多く当たる語 (「中央」「大和」) でも住所・地名が全部落ちないよう、住所に REMOTE_MIN_SLOTS 枠は残す
  const keep = Math.min(
    local.length,
    Math.max(limit - Math.min(extra.length, REMOTE_MIN_SLOTS), 0),
  );
  return [...local.slice(0, keep), ...extra].slice(0, limit);
}

/** 住所・地名の候補に、少なくとも残す枠 */
export const REMOTE_MIN_SLOTS = 3;

/** 国土地理院の住所検索の URL (打った文字だけを送る) */
export const gsiSearchUrl = (query: string): string =>
  `${GSI_ADDRESS_SEARCH}?q=${encodeURIComponent(query.trim())}`;
