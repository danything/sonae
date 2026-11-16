/**
 * 住んでいる地域 (通知の条件。`#lib/push.ts` の Home) を選ぶための道具。画面だけで使う。
 * 市町村等の表 `static/areas/cities.json` と面 `static/areas/warning-areas.geojson` は tools/areas/build-weather.sh で作る。
 * 「現在地から選ぶ」は端末の中で面を引くだけで、緯度・経度はサーバーに送らない。
 */

import { type Home, normalizePrefs, type PushPrefs } from "./push.ts";

/**
 * cities.json の 1 行: [名前, 府県と市町村の名前, 府県予報区, 一次細分区域, まとめた地域, 地震情報／細分区域,
 * 沿岸が入る津波予報区 ([コード, 名前] の並び。海に面していなければ空。tools/areas/tsunami-cities.ts)]
 */
export type CityRow = [
  string,
  string,
  string | null,
  string | null,
  string | null,
  string | null,
  ([string, string][] | undefined)?,
];
export type Cities = Record<string, CityRow>;

/**
 * 都道府県の名前 (JIS の都道府県コード 01〜47 の順)。市町村等のコードの上 2 桁で引く。
 * cities.json の 2 列目 (府県と市町村の名前) は、2 つに分けた市 (仙台市東部・横浜市北部・富山市平地など) では
 * 「気象庁予報警報規程別表第四の二に示す「…」の区域」や「神奈川県横浜市のうち…」のような説明の文なので、
 * そこから都道府県の名前を切り出さない
 */
const PREFECTURES = [
  "北海道",
  "青森県",
  "岩手県",
  "宮城県",
  "秋田県",
  "山形県",
  "福島県",
  "茨城県",
  "栃木県",
  "群馬県",
  "埼玉県",
  "千葉県",
  "東京都",
  "神奈川県",
  "新潟県",
  "富山県",
  "石川県",
  "福井県",
  "山梨県",
  "長野県",
  "岐阜県",
  "静岡県",
  "愛知県",
  "三重県",
  "滋賀県",
  "京都府",
  "大阪府",
  "兵庫県",
  "奈良県",
  "和歌山県",
  "鳥取県",
  "島根県",
  "岡山県",
  "広島県",
  "山口県",
  "徳島県",
  "香川県",
  "愛媛県",
  "高知県",
  "福岡県",
  "佐賀県",
  "長崎県",
  "熊本県",
  "大分県",
  "宮崎県",
  "鹿児島県",
  "沖縄県",
] as const;

/** 市町村等のコードから都道府県の名前。知らないコードは空 */
export function prefectureOf(code: string): string {
  return PREFECTURES[Number(code.slice(0, 2)) - 1] ?? "";
}

/** 選んだ市町村等から、住んでいる地域を組む。地震情報／細分区域の名前は細分区域の面から引く */
export function homeOf(
  code: string,
  cities: Cities,
  quakeNames: Map<string, string>,
): Home | null {
  const row = cities[code];
  if (!row) return null;
  const [name, , office, ichiji, , quake, tsunami] = row;
  const quakeName = quake ? quakeNames.get(quake) : undefined;
  return {
    code,
    // 「宮城県仙台市東部」の形 (2 列目は分けた市では説明の文になるので使わない)
    name: `${prefectureOf(code)}${name}`,
    quake: quake && quakeName ? { code: quake, name: quakeName } : null,
    office,
    ichiji,
    tsunami: (tsunami ?? []).map(([c, n]) => ({ code: c, name: n })),
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
    const [name] = row;
    const key = code.slice(0, 2);
    const g = groups.get(key) ?? { pref: prefectureOf(code), cities: [] };
    g.cities.push({ code, name });
    groups.set(key, g);
  }
  return [...groups.values()];
}

type Ring = [number, number][];
/** 市町村等の面 (`warning-areas.geojson` の 1 つ) */
export interface AreaFeature {
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

/** 緯度・経度が、市町村等の面の中か */
function inFeature(lat: number, lon: number, f: AreaFeature): boolean {
  const g = f.geometry;
  if (!g || !f.properties.code) return false;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.some((p) => inPolygon(lon, lat, p));
}

/** 緯度・経度が入る市町村等の面。どこにも入らなければ (海の上など) undefined */
export const featureAt = (
  lat: number,
  lon: number,
  features: AreaFeature[],
): AreaFeature | undefined => features.find((f) => inFeature(lat, lon, f));

/** 緯度・経度が入る市町村等のコード。どこにも入らなければ (海の上など) null */
export function cityAt(
  lat: number,
  lon: number,
  features: AreaFeature[],
): string | null {
  return featureAt(lat, lon, features)?.properties.code ?? null;
}

/**
 * 現在地が入る市町村等を、動いたときに探し直す (開いているときの気象の通知に使う。`#lib/push-client.ts`)。
 * 前の面の中にまだいれば探さない (位置は数秒ごとに届くので、全部の面を毎回は引かない)。
 * 緯度・経度は覚えず、覚えるのは入っている面だけ
 */
export function createHereFinder(features: AreaFeature[]) {
  let last: AreaFeature | undefined;
  return (lat: number, lon: number): string | null => {
    if (!last || !inFeature(lat, lon, last))
      last = featureAt(lat, lon, features);
    return last?.properties.code ?? null;
  };
}

/** Web Push の登録の様子 (`#lib/push-client.ts` の `readPushState` の形) */
export interface PushStateLike {
  info:
    | { enabled: false }
    | {
        enabled: true;
        publicKey: string;
        subscriptions: { endpoint: string; prefs: PushPrefs }[];
      };
  endpoint: string | undefined;
}

/**
 * 地図のメニューから住んでいる地域を変えるときに、覚える条件と、サーバーへ送るかを決める。
 * このブラウザが Web Push に登録してあればサーバーの条件の `home` だけを替えて送り、無ければ端末の条件の `home` だけを替える。
 * 登録を読めなかったとき (`state` が null) は端末にだけ覚え、そう知らせる
 */
export function planHomeSave(
  state: PushStateLike | null,
  local: PushPrefs,
  home: Home,
): { prefs: PushPrefs; publicKey: string | null; note: string } {
  const done = `${home.name}を住んでいる地域にしました`;
  if (state === null)
    return {
      prefs: normalizePrefs({ ...local, home }),
      publicKey: null,
      note: `${done}。Web Push の登録を読めなかったので、このブラウザにだけ覚えました`,
    };
  const info = state.info;
  const mine = info.enabled
    ? info.subscriptions.find((s) => s.endpoint === state.endpoint)
    : undefined;
  return {
    prefs: normalizePrefs({ ...(mine ? mine.prefs : local), home }),
    publicKey: mine && info.enabled ? info.publicKey : null,
    note: done,
  };
}
