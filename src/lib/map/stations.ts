/**
 * 観測点ごとの震度を地図に置く (docs/map.md の「観測点ごとの震度」)。位置は `tools/stations/build.ts` が作った
 * 表 (`static/areas/intensity-stations.json`) から、観測点のコードか名前で引く。観測された震度をその観測点に置くだけで、
 * 観測点の間を補ったり、観測点の無い所の震度を推し量ったりはしない (docs/design.md の 5 章)
 */

import { INTENSITY_COLORS } from "#lib/format.ts";
import {
  intensityRank,
  type StationIntensity,
  UNRECEIVED,
} from "#lib/model.ts";

export const STATIONS_URL = "/areas/intensity-stations.json";

/** 表の形: 観測点のコード → [経度, 緯度, 名前, 別名…] */
export type StationTable = Record<string, (number | string)[]>;

/** 引くための索引 (コード → 位置、名前 → 位置) */
export interface StationIndex {
  byCode: Map<string, [number, number]>;
  byName: Map<string, [number, number]>;
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
  const byCode = new Map<string, [number, number]>();
  const byName = new Map<string, [number, number]>();
  for (const [code, [lon, lat, ...names]] of Object.entries(table)) {
    if (typeof lon !== "number" || typeof lat !== "number") continue;
    const at: [number, number] = [lon, lat];
    byCode.set(code, at);
    for (const n of names) if (typeof n === "string") byName.set(n, at);
  }
  return { byCode, byName };
}

/** 観測点の位置。コード (気象庁の XML) を先に、無ければ名前 (P2P・コードを持つ前に受けた報) で引く */
export function stationAt(
  s: StationIntensity,
  index: StationIndex,
): [number, number] | undefined {
  return (
    (s.code ? index.byCode.get(s.code) : undefined) ??
    index.byName.get(stationKey(s.name))
  );
}

/**
 * 地図に置く観測点の点と、位置が引けなかった観測点。
 * 点は震度の小さいほうから並べ、`order` (震度の順位) で大きい震度が上に描かれるようにする。
 * 「5弱以上未入電」は震度が決まっていないので点にしない (詳しい内容の一覧には出る)。位置の引けない観測点も点にせず、
 * `missing` に名前を返す (詳しい内容で数を出す)
 */
export function stationFeatures(
  stations: StationIntensity[],
  index: StationIndex,
) {
  const missing: string[] = [];
  const placed: {
    s: StationIntensity;
    at: [number, number];
  }[] = [];
  for (const s of stations) {
    if (s.int === UNRECEIVED) continue;
    const at = stationAt(s, index);
    if (at) placed.push({ s, at });
    else missing.push(s.name);
  }
  placed.sort((a, b) => intensityRank(a.s.int) - intensityRank(b.s.int));
  return {
    missing,
    data: {
      type: "FeatureCollection" as const,
      features: placed.map(({ s, at }) => ({
        type: "Feature" as const,
        properties: {
          int: s.int,
          color: INTENSITY_COLORS[s.int]?.bg ?? "#888",
          order: intensityRank(s.int),
        },
        geometry: { type: "Point" as const, coordinates: at },
      })),
    },
  };
}
