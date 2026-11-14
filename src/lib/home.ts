/**
 * 住んでいる地域 (通知の条件。`#lib/push.ts` の Home) を選ぶための道具。画面だけで使う。
 * 市町村等の表 `static/areas/cities.json` と面 `static/areas/warning-areas.geojson` は tools/areas/build-weather.sh で作る。
 * 「現在地から選ぶ」は端末の中で面を引くだけで、緯度・経度はサーバーに送らない。
 */

import type { Home } from "./push.ts";

/** cities.json の 1 行: [名前, 府県と市町村の名前, 府県予報区, 一次細分区域, まとめた地域, 地震情報／細分区域] */
export type CityRow = [
  string,
  string,
  string | null,
  string | null,
  string | null,
  string | null,
];
export type Cities = Record<string, CityRow>;

/** 選んだ市町村等から、住んでいる地域を組む。地震情報／細分区域の名前は細分区域の面から引く */
export function homeOf(
  code: string,
  cities: Cities,
  quakeNames: Map<string, string>,
): Home | null {
  const row = cities[code];
  if (!row) return null;
  const [, full, office, ichiji, , quake] = row;
  const quakeName = quake ? quakeNames.get(quake) : undefined;
  return {
    code,
    name: full,
    quake: quake && quakeName ? { code: quake, name: quakeName } : null,
    office,
    ichiji,
  };
}

/** 都道府県ごとに、市町村等をコードの順に束ねる (選ぶ欄の並び)。都道府県はコードの上 2 桁 */
export function byPrefecture(
  cities: Cities,
): { pref: string; cities: { code: string; name: string }[] }[] {
  const groups = new Map<
    string,
    { pref: string; cities: { code: string; name: string }[] }
  >();
  for (const code of Object.keys(cities).sort()) {
    const row = cities[code];
    if (!row) continue;
    const [name, full] = row;
    const key = code.slice(0, 2);
    const g = groups.get(key) ?? {
      pref: full.endsWith(name) ? full.slice(0, full.length - name.length) : "",
      cities: [],
    };
    g.cities.push({ code, name });
    groups.set(key, g);
  }
  return [...groups.values()];
}

type Ring = [number, number][];
interface Feature {
  properties: { code?: string };
  geometry:
    | { type: "Polygon"; coordinates: Ring[] }
    | { type: "MultiPolygon"; coordinates: Ring[][] }
    | null;
}

/** 点が輪の中か (偶奇の数え方。経度を x、緯度を y) */
function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] ?? [0, 0];
    const [xj, yj] = ring[j] ?? [0, 0];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/** 多角形 (外の輪と穴) の中か */
const inPolygon = (lon: number, lat: number, poly: Ring[]) =>
  poly.length > 0 &&
  inRing(lon, lat, poly[0] ?? []) &&
  !poly.slice(1).some((hole) => inRing(lon, lat, hole));

/** 緯度・経度が入る市町村等のコード。どこにも入らなければ (海の上など) null */
export function cityAt(
  lat: number,
  lon: number,
  features: Feature[],
): string | null {
  for (const f of features) {
    const g = f.geometry;
    if (!g || !f.properties.code) continue;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    if (polys.some((p) => inPolygon(lon, lat, p))) return f.properties.code;
  }
  return null;
}
