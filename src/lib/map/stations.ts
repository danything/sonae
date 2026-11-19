/**
 * 観測点ごとの震度を地図に置く (docs/map.md の「観測点ごとの震度」)。位置は `tools/stations/build.ts` が作った
 * 表 (`static/areas/intensity-stations-v2.json`) から、観測点のコードか名前で引く。観測された震度をその観測点に置くだけで、
 * 観測点の間を補ったり、観測点の無い所の震度を推し量ったりはしない (docs/design.md の 5 章)
 */

import { INTENSITY_COLORS } from "#lib/format.ts";
import { prefectureOf } from "#lib/home.ts";
import {
  intensityLabel,
  intensityRank,
  type StationIntensity,
  UNRECEIVED,
} from "#lib/model.ts";

export const STATIONS_URL = "/areas/intensity-stations-v2.json";

/**
 * 表の形。`cities` は市町村の名前、`stations` は観測点のコード → [経度, 緯度, 設置者, 市町村の番号, 名前, 別名…]。
 * 設置者と市町村の番号は、分からなければ -1
 */
export interface StationTable {
  cities: string[];
  stations: Record<string, (number | string)[]>;
}

/** 設置者 (気象庁ホームページの「震度観測点」の `affi`) */
export type StationOwner = "jma" | "local" | "nied";
const OWNERS: Record<number, StationOwner> = {
  0: "jma",
  1: "local",
  2: "nied",
};
/** 吹き出しに出す設置者の文 */
export const OWNER_TEXT: Record<StationOwner, string> = {
  jma: "気象庁の観測点",
  local: "地方公共団体の観測点",
  nied: "防災科学技術研究所の観測点",
};

/** 表から引いた観測点 */
export interface StationInfo {
  at: [number, number];
  /** 市町村 (コード表の書き方。「札幌中央区」)。分からなければ空 */
  city: string;
  owner?: StationOwner;
  /** 都道府県 (観測点のコードの上 2 桁から)。分からなければ空 */
  pref: string;
}

/** 引くための索引 (コード → 観測点、名前 → 観測点) */
export interface StationIndex {
  byCode: Map<string, StationInfo>;
  byName: Map<string, StationInfo>;
}

/**
 * 名前を表の形にそろえる。気象庁の XML は気象庁以外の観測点の名前に「＊」を付け、P2P地震情報は付けない。
 * 前後の空白も外す
 */
export const stationKey = (name: string) =>
  name
    .trim()
    .replace(/[＊*]+$/u, "")
    .trim();

export function stationIndex(table: StationTable): StationIndex {
  const byCode = new Map<string, StationInfo>();
  const byName = new Map<string, StationInfo>();
  for (const [code, [lon, lat, affi, city, ...names]] of Object.entries(
    table.stations ?? {},
  )) {
    if (typeof lon !== "number" || typeof lat !== "number") continue;
    const info: StationInfo = {
      at: [lon, lat],
      city: typeof city === "number" ? (table.cities[city] ?? "") : "",
      owner: typeof affi === "number" ? OWNERS[affi] : undefined,
      pref: prefectureOf(code),
    };
    byCode.set(code, info);
    for (const n of names) if (typeof n === "string") byName.set(n, info);
  }
  return { byCode, byName };
}

/** 観測点を引く。コード (気象庁の XML) を先に、無ければ名前 (P2P・コードを持つ前に受けた報) で引く */
export function stationInfo(
  s: StationIntensity,
  index: StationIndex,
): StationInfo | undefined {
  return (
    (s.code ? index.byCode.get(s.code) : undefined) ??
    index.byName.get(stationKey(s.name))
  );
}

/** 観測点の位置 */
export const stationAt = (
  s: StationIntensity,
  index: StationIndex,
): [number, number] | undefined => stationInfo(s, index)?.at;

/**
 * 地図に置く観測点の点と、位置が引けなかった観測点。
 * 点は震度の小さいほうから並べ、`order` (震度の順位) で大きい震度が上に描かれるようにする。
 * 「5弱以上未入電」は震度が決まっていないので点にしない (詳しい内容の一覧には出る)。位置の引けない観測点も点にせず、
 * `missing` に名前を返す (詳しい内容で数を出す)。点には、押したときの吹き出しの中身 (`stationPopup`) も持たせる
 */
export function stationFeatures(
  stations: StationIntensity[],
  index: StationIndex,
) {
  const missing: string[] = [];
  const placed: {
    s: StationIntensity;
    info: StationInfo;
  }[] = [];
  for (const s of stations) {
    if (s.int === UNRECEIVED) continue;
    const info = stationInfo(s, index);
    if (info) placed.push({ s, info });
    else missing.push(s.name);
  }
  placed.sort((a, b) => intensityRank(a.s.int) - intensityRank(b.s.int));
  return {
    missing,
    data: {
      type: "FeatureCollection" as const,
      features: placed.map(({ s, info }) => ({
        type: "Feature" as const,
        properties: {
          int: s.int,
          color: INTENSITY_COLORS[s.int]?.bg ?? "#888",
          order: intensityRank(s.int),
          ...stationPopup(s, info),
        },
        geometry: { type: "Point" as const, coordinates: info.at },
      })),
    },
  };
}

/**
 * 観測点の吹き出しの中身。名前は「＊」を外す (「＊」は気象庁以外の観測点の印で、設置者を文で出すため)。
 * 設置者は表から引き、表に無ければ「＊」の有無で気象庁かそれ以外かだけを出す (XML のときだけ。P2P は印が無い)
 */
export function stationPopup(
  s: StationIntensity,
  info: StationInfo,
): { name: string; label: string; place: string; owner: string } {
  const pref = info.pref || s.pref || "";
  const starred = /[＊*]\s*$/u.test(s.name);
  return {
    name: stationKey(s.name),
    label: `震度${intensityLabel(s.int)}`,
    place: info.city && pref ? `${pref}・${info.city}` : pref || info.city,
    owner: info.owner
      ? OWNER_TEXT[info.owner]
      : starred
        ? "気象庁以外の観測点"
        : s.code
          ? OWNER_TEXT.jma
          : "",
  };
}

/**
 * 押した所に近い観測点を選ぶ。指は押せる範囲を広く取るので、範囲の中に幾つもあるときは、押した所にいちばん近いもの、
 * 同じ近さなら大きい震度 (上に描いているもの) を選ぶ。`d2` は押した所からの距離 (px) の 2 乗
 */
export function nearestStation<T extends { d2: number; order: number }>(
  hits: readonly T[],
): T | undefined {
  let best: T | undefined;
  for (const h of hits)
    if (!best || h.d2 < best.d2 || (h.d2 === best.d2 && h.order > best.order))
      best = h;
  return best;
}
