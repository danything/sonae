/**
 * 地図の下地と、重ねる層 (docs/map.md)。MapLibre の style と、データから色の式を組む関数。
 * DOM にも MapLibre にも触らない (試験できるように)。
 */

import {
  INTENSITY_COLORS,
  LG_COLORS,
  TSUNAMI_COLORS,
  WARNING_COLORS,
} from "#lib/format.ts";
import type {
  AreaIntensity,
  AreaLongPeriod,
  Eew,
  ForeignQuake,
  ObservedIntensity,
  Quake,
  Tsunami,
  Volcano,
  WarningLevel,
} from "#lib/model.ts";
import { intensityRank, TSUNAMI_ORDER, volcanoTop } from "#lib/model.ts";

const GSI = "https://cyberjapandata.gsi.go.jp/xyz";
const TILES = "https://maps.gsi.go.jp/development/ichiran.html";

/**
 * 地理院タイル「写真」を出し始めるズーム。これより引いているときは Blue Marble を出す (docs/map.md)。
 * 写真の 8 以下 (世界衛星モザイク) は、画像の無い所が灰色の三角として焼き込まれ、海に継ぎ目の段差もあるため
 */
export const PHOTO_MIN_ZOOM = 9;

/**
 * 写真の出典。地理院タイルの一覧の「写真」の備考のとおり、ズームの段ごとに元の衛星画像の出典も出す
 * (9〜13 は全国ランドサットモザイク、14〜18 はシームレス空中写真。2〜8 の世界衛星モザイクは使わない)
 */
const PHOTO_ATTRIBUTION = [
  `<a href="${TILES}" target="_blank" rel="noopener">国土地理院</a> (シームレス空中写真)`,
  "Landsat8画像 (GSI, TSIC, GEO Grid/AIST)・Landsat8画像 (courtesy of the U.S. Geological Survey)・海底地形 (GEBCO)",
  "GRUS画像 (© Axelspace)",
].join(" | ");

/**
 * 引いたとき (ズーム 8 まで) の下地。NASA GIBS の Blue Marble (2004 年 8 月、陰影つき)。
 * 海は暗い紺で、地理院の写真 (9 から) の黒い海とつながる。GIBS は 8 までなので、9 からは引き伸ばす
 */
export const BLUE_MARBLE_TILES =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg";
const GIBS = "https://nasa-gibs.github.io/gibs-api-docs/";
/** Blue Marble の出典。NASA Earth Observatory の頼み (「NASA Earth Observatory」と書く) と、GIBS の謝辞の文 */
const BLUE_MARBLE_ATTRIBUTION = `Blue Marble: NASA Earth Observatory | <a href="${GIBS}" target="_blank" rel="noopener">NASA GIBS</a>`;

/** 台湾の観測点の揺れ (TREM-RTS) の出典。授權頁の書き方 (全文は `#lib/notice.ts` の CREDITS) */
const RTS_ATTRIBUTION =
  '資料來源：ExpTech Studio TREM（<a href="https://exptech.dev" target="_blank" rel="noopener">exptech.dev</a>）・非商業使用・非官方資訊，以中央氣象署發布為準';

/** 有志の観測点の揺れ (Wolfx SeisJS) の出典。Wolfx から返事をもらった書き方 (全文は `#lib/notice.ts` の CREDITS) */
const SEIS_ATTRIBUTION =
  '<a href="https://wolfx.jp/docs/seisjs-api/" target="_blank" rel="noopener">Wolfx Project (SeisJS)</a>・非公式';

const JMA_GIS_ATTRIBUTION =
  '<a href="https://www.data.jma.go.jp/developer/gis.html" target="_blank" rel="noopener">気象庁 予報区等 GIS データ</a> を加工';

/**
 * プレート境界 (PB2002。`tools/plates/build.sh` で簡略化した線)。ODC Attribution License 1.0 の 4.3 の文
 * (「出典と注意」の窓の全文は `#lib/notice.ts` の CREDITS。docs/map.md)
 */
export const PLATES_URL = "/plates/pb2002-boundaries.geojson";
const PLATES_ATTRIBUTION =
  'プレート境界: Contains information from PB2002 (Bird, 2003; Hugo Ahlenius, Nordpil) which is made available under the <a href="https://opendatacommons.org/licenses/by/1-0/" target="_blank" rel="noopener">ODC Attribution License</a>';
/**
 * プレート境界の線の色。写真の上で沈まず、震源の丸 (不透明度 0.8・黒い縁) より目立たない淡い橙を半分透かす。
 * 深さの色 (赤・黄・緑・青) と津波の色 (紫・赤・黄) のどれとも違う色にする
 */
export const PLATE_COLOR = "rgba(255, 196, 150, 0.55)";

/**
 * 地理院地図Vector (国土地理院最適化ベクトルタイル) の PMTiles。試験公開で URL が変わりうる (docs/map.md)。
 * 前の `{z}/{x}/{y}.pbf` の配信は 2023 年のデータで止まっているので、PMTiles の 1 ファイルを範囲で読む
 */
const GSI_VECTOR_URL =
  "https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles";
const GSI_VECTOR_ATTRIBUTION = `<a href="https://github.com/gsi-cyberjapan/optimal_bvmap" target="_blank" rel="noopener">国土地理院最適化ベクトルタイル</a> を加工`;

/** 地図の字と印に使う端末の字体 (字体のファイルは外から読まない。tools/gsi/build.ts と同じ) */
export const TEXT_FONT_CSS = '"Noto Sans JP", sans-serif';

/**
 * ハザードマップ (重ねるラスタータイル)。選ぶのは 1 つだけ (色がぶつかるため)。
 * ハザードマップポータルサイトの 3 つと、地理院タイルの都市圏活断層図 (地形の分類で塗った全面の図なので、
 * いつも重ねると写真が見づらい。選んだときだけ出す)
 */
export type HazardId = "none" | "flood" | "landslide" | "tsunami" | "faults";
const DISAPORTAL = "https://disaportaldata.gsi.go.jp/raster";
const LEGEND = "https://disaportal.gsi.go.jp/hazardmap/copyright/img";
const HAZARD_ATTRIBUTION = `<a href="https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html" target="_blank" rel="noopener">ハザードマップポータルサイト</a>`;
/** 国土地理院の「活断層図（都市圏活断層図）について」(各図の調査者がある) */
const GSI_AFM_ABOUT = "https://www.gsi.go.jp/bousaichiri/active_fault.html";

export interface Hazard {
  id: Exclude<HazardId, "none">;
  /** 選択肢の名前 */
  label: string;
  /** 凡例の上に出す、何の想定か */
  title: string;
  /** タイルの層 (土砂災害は 3 つを重ねる)。地図の層の名前は `hazard-<id>` */
  layers: { id: string; tiles: string }[];
  /** タイルのあるズーム */
  minzoom: number;
  maxzoom: number;
  /** 写真の上に重ねるときの不透明度 */
  opacity: number;
  /** MapLibre の出典 (タイルの 1 つ目に付ける) */
  attribution: string;
  /** 地図の隅の短い出典に足す名前 (`#lib/notice.ts` の `mapCredit`) */
  credit: string;
  /** 公式の凡例の画像 (無ければ出さない) */
  legends: { src: string; alt: string; name?: string }[];
  /** 凡例の代わり・下に出す説明 (リンクは href) */
  about?: (string | { text: string; href: string })[];
}

const portal = (layer: string) => ({
  id: layer,
  tiles: `${DISAPORTAL}/${layer}/{z}/{x}/{y}.png`,
});
const PORTAL = {
  minzoom: 2,
  maxzoom: 17,
  opacity: 0.75,
  attribution: HAZARD_ATTRIBUTION,
  credit: "ハザードマップポータルサイト",
};

export const HAZARDS: Hazard[] = [
  {
    id: "flood",
    label: "洪水",
    title: "洪水浸水想定区域 (想定最大規模)",
    ...PORTAL,
    layers: [portal("01_flood_l2_shinsuishin_data")],
    legends: [
      {
        src: `${LEGEND}/shinsui_legend3.png`,
        alt: "浸水深の凡例: 0.5m 未満から 20m 以上まで、深いほど濃い色",
      },
    ],
  },
  {
    id: "landslide",
    label: "土砂災害",
    title: "土砂災害警戒区域 (土石流・急傾斜地の崩壊・地すべり)",
    ...PORTAL,
    layers: [
      portal("05_dosekiryukeikaikuiki"),
      portal("05_kyukeishakeikaikuiki"),
      portal("05_jisuberikeikaikuiki"),
    ],
    legends: [
      {
        src: `${LEGEND}/keikai_dosekiryu.png`,
        alt: "土石流の警戒区域と特別警戒区域の凡例",
        name: "土石流",
      },
      {
        src: `${LEGEND}/keikai_kyukeisya.png`,
        alt: "急傾斜地の崩壊の警戒区域と特別警戒区域の凡例",
        name: "急傾斜地の崩壊",
      },
      {
        src: `${LEGEND}/keikai_jisuberi.png`,
        alt: "地すべりの警戒区域と特別警戒区域の凡例",
        name: "地すべり",
      },
    ],
  },
  {
    id: "tsunami",
    label: "津波",
    title: "津波浸水想定",
    ...PORTAL,
    layers: [portal("04_tsunami_newlegend_data")],
    legends: [
      {
        src: `${LEGEND}/shinsui_legend3.png`,
        alt: "浸水深の凡例: 0.5m 未満から 20m 以上まで、深いほど濃い色",
      },
    ],
  },
  {
    id: "faults",
    label: "活断層",
    title: "活断層図 (都市圏活断層図)",
    layers: [{ id: "afm", tiles: `${GSI}/afm/{z}/{x}/{y}.png` }],
    // タイルはズーム 11 からしか無い。引いているときは読みに行かない
    minzoom: 11,
    maxzoom: 16,
    // 地形の分類で塗った全面の図なので、写真が透けて見えるよう少し透かす
    opacity: 0.7,
    attribution: `<a href="${TILES}#afm" target="_blank" rel="noopener">国土地理院 (都市圏活断層図)</a>`,
    credit: "都市圏活断層図",
    legends: [],
    about: [
      "大きく寄せたとき (ズーム 11 以上) だけ出ます。図の見方と、図ごとの調査者は国土地理院の「",
      { text: "活断層図（都市圏活断層図）について", href: GSI_AFM_ABOUT },
      "」にあります。",
    ],
  },
];

/** ハザードマップの層ごとに出すかどうか (選んだものだけ。なしなら全部隠す) */
export function hazardVisibility(id: HazardId): Record<string, boolean> {
  return Object.fromEntries(
    HAZARDS.flatMap((h) =>
      h.layers.map((l) => [`hazard-${l.id}`, h.id === id]),
    ),
  );
}

/**
 * ハザードマップを重ねている間に隠す層。面で塗る色がハザードマップの色とぶつかって見分けられないため。
 * 気象警報・注意報の塗りと、一覧で選んだ府県予報区の縁取り・震度の塗り (震度は地域の上の数字のラベルで残る)・
 * 緊急地震速報の地域の塗り (縁取りの `eew-line` は残す)
 */
export const HIDDEN_UNDER_HAZARD = [
  "warning-fill",
  "warning-focus-casing",
  "warning-focus",
  "quake-fill",
  "eew-fill",
] as const;
/** ハザードマップを重ねている間だけ出す層 (いま出ている特別警報の市町村等の縁取り) */
export const SHOWN_UNDER_HAZARD = [
  "warning-special-casing",
  "warning-special",
] as const;

/** 選んだハザードマップが、いまのズームで地図に重なっているか (タイルのあるズームか) */
export function hazardCovers(id: HazardId, zoom: number): boolean {
  const h = HAZARDS.find((x) => x.id === id);
  return h !== undefined && zoom >= h.minzoom;
}

/** ハザードマップが重なっているかで、重ねる層の出し入れを決める (隠す層・代わりに出す層) */
export function overlayVisibility(
  id: HazardId,
  /** いまのズーム。ハザードマップのタイルが無いズーム (活断層はズーム 11 未満) では何も重ならないので隠さない */
  zoom = Number.POSITIVE_INFINITY,
): Record<string, boolean> {
  const on = hazardCovers(id, zoom);
  return {
    ...Object.fromEntries(HIDDEN_UNDER_HAZARD.map((l) => [l, !on])),
    ...Object.fromEntries(SHOWN_UNDER_HAZARD.map((l) => [l, on])),
  };
}

/**
 * いま特別警報 (レベル 5) が出ている市町村等だけを描く filter。ハザードマップを重ねている間、
 * 塗る代わりに縁取りで残す (数十年に一度の重大な災害のおそれなので隠さない)
 */
export function specialWarningFilter(levels: Map<string, WarningLevel>): Expr {
  const codes = [...levels].filter(([, l]) => l === 5).map(([c]) => c);
  return ["in", ["get", "code"], ["literal", codes]];
}

/** 端末に覚えた選択を読む。知らない値は「なし」 */
export const readHazard = (raw: string | null): HazardId =>
  HAZARDS.some((h) => h.id === raw) ? (raw as HazardId) : "none";

/**
 * 指定緊急避難場所 (災害ごとに skhb01〜08) と指定避難所 (sih)。地理院タイルの GeoJSON で、ズーム 10 のタイルしか無い。
 * 寄せたとき (ズーム 14 から) だけ、見ている範囲のタイルを読む
 */
export const SHELTER_LAYERS = [
  "skhb01",
  "skhb02",
  "skhb03",
  "skhb04",
  "skhb05",
  "skhb06",
  "skhb07",
  "skhb08",
  "sih",
] as const;
export const SHELTER_TILE_ZOOM = 10;
export const SHELTER_MIN_ZOOM = 14;
/** 指定緊急避難場所の disaster1〜8 の災害 (地理院タイル一覧の備考の順) */
export const SHELTER_DISASTERS = [
  "洪水",
  "崖崩れ、土石流及び地滑り",
  "高潮",
  "地震",
  "津波",
  "大規模な火事",
  "内水氾濫",
  "火山現象",
] as const;
const SHELTER_ATTRIBUTION = `<a href="https://www.gsi.go.jp/bousaichiri/hinanbasho.html" target="_blank" rel="noopener">国土地理院 (指定緊急避難場所・指定避難所データ)</a>`;

/** 見ている範囲 (西・南・東・北) に掛かるズーム z のタイル。多すぎたら空 (読みすぎない) */
export function tilesIn(
  [west, south, east, north]: [number, number, number, number],
  z: number,
  max = 4,
): [number, number][] {
  const n = 2 ** z;
  const x = (lon: number) =>
    Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const y = (lat: number) => {
    const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
    return Math.min(
      n - 1,
      Math.max(
        0,
        Math.floor(
          ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
        ),
      ),
    );
  };
  const out: [number, number][] = [];
  for (let tx = x(west); tx <= x(east); tx++)
    for (let ty = y(north); ty <= y(south); ty++) out.push([tx, ty]);
  return out.length > max ? [] : out;
}

interface ShelterProps {
  name?: string;
  address?: string;
  remarks?: string | null;
  [k: string]: unknown;
}
export interface ShelterFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    name: string;
    address: string;
    /** 指定緊急避難場所として対応する災害 (SHELTER_DISASTERS の番号、1 から) */
    disasters: number[];
    /** 指定避難所でもある */
    shelter: boolean;
  };
}

/**
 * 層ごとの GeoJSON をまとめ、同じ場所・同じ名前の施設を 1 つにする (指定緊急避難場所は災害ごとの層に
 * 同じ施設が何度も出て、指定避難所を兼ねるものも多い)
 */
export function mergeShelters(
  parts: {
    layer: (typeof SHELTER_LAYERS)[number];
    features: {
      geometry: { coordinates: number[] };
      properties: ShelterProps;
    }[];
  }[],
): ShelterFeature[] {
  const byKey = new Map<string, ShelterFeature>();
  for (const { layer, features } of parts) {
    for (const f of features) {
      const [lon, lat] = f.geometry.coordinates;
      if (typeof lon !== "number" || typeof lat !== "number") continue;
      const p = f.properties;
      const key = `${lon.toFixed(6)},${lat.toFixed(6)},${p.name ?? ""}`;
      const cur =
        byKey.get(key) ??
        ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lon, lat] },
          properties: {
            name: p.name ?? "",
            address: p.address ?? "",
            disasters: [],
            shelter: false,
          },
        } satisfies ShelterFeature);
      if (layer === "sih") cur.properties.shelter = true;
      else
        for (let i = 1; i <= 8; i++)
          if (p[`disaster${i}`] === 1 && !cur.properties.disasters.includes(i))
            cur.properties.disasters.push(i);
      byKey.set(key, cur);
    }
  }
  for (const f of byKey.values()) f.properties.disasters.sort((a, b) => a - b);
  return [...byKey.values()];
}

/**
 * 地図の見方 (「出典と注意」の窓に出す)。層はいつも全部出していて、オン・オフは無い (docs/map.md)。
 * 色の意味は地図の上には書かないので、ここに言葉で書く
 */
export const MAP_LEGEND: { label: string; note: string }[] = [
  {
    label: "各地の震度",
    note: "一覧で選んだ地震の、地域ごとの震度の色と数字。何も選んでいないときは出しません",
  },
  {
    label: "震源",
    note: "新しい 50 件の丸。色は深さ (30 km まで赤・100 km まで黄・300 km まで緑・それより深いと青)、大きさは M。選んだ地震は ×",
  },
  {
    label: "長周期地震動階級",
    note: "選んだ地震で、階級 1 以上を観測した地域を太い枠で囲みます。枠の色は階級 4 紫・3 赤・2 橙・1 黄",
  },
  {
    label: "津波の警報・注意報",
    note: "津波予報区の海岸の線を区分の色で引きます。大津波警報は線が太くなります",
  },
  {
    label: "緊急地震速報",
    note: "出ている間の震央の × と、警報の出た地域 (赤く塗って縁取ります)",
  },
  {
    label: "気象警報・注意報",
    note: "市町村等を段の色で塗ります。特別警報 黒・危険警報 紫・警報 赤・注意報 黄 (気象庁の配色)。塗った所を押すと、市町村の名前と出ている警報・注意報が出ます。一覧で府県予報区の警報・注意報を選ぶと、その府県予報区の市町村等を白い線で縁取ります",
  },
  {
    label: "台湾の観測点の揺れ (非公式)",
    note: "ExpTech の観測網 TREM-net の台湾の観測点。ふだんは小さな灰色の点で、地震の間だけ、揺れた観測点をいまの揺れ (計測震度) に当たる震度の色で塗ります。中央氣象署の発表ではない非公式の値で、地図に出すだけです。一覧・音・読み上げ・通知では知らせません。中央氣象署の発表を優先してください",
  },
  {
    label: "有志の観測点の揺れ (非公式)",
    note: "Wolfx Project の SeisJS に参加している有志の観測点 (いまは中国と台湾の数か所)。値は観測点が計算した計測震度で、0.5 以上なら震度の色で塗り、それ未満は灰色の点です。気象庁や各国の機関の発表ではない非公式の値で、地図に出すだけです。一覧・音・読み上げ・通知では知らせません",
  },
  {
    label: "海外の地震",
    note: "新しい 50 件。白い縁の丸 (色と大きさは震源と同じ)",
  },
  {
    label: "プレート境界",
    note: "淡い橙の破線。Peter Bird の研究の模型 PB2002 (2003 年) の線で、どの機関の公式の線でもありません。震源との位置の見当に使ってください",
  },
  {
    label: "火山",
    note: "噴火警戒レベル 2 以上の火山と、選んだ情報の火山の三角。中の数字はレベル",
  },
  {
    label: "道路・地名・施設の記号",
    note: "国土地理院の地理院地図Vector。寄せるほど細い道と小さな地名まで出ます。高速道路は橙・国道は黄・ほかの道は白",
  },
  {
    label: "指定緊急避難場所・指定避難所",
    note: "大きく寄せたとき (ズーム 14 以上) だけ、緑の「避」の印で出します。押すと、どの災害に対応する指定緊急避難場所か、指定避難所かが出ます。国土地理院のデータで最新でないことや載っていない施設があるので、避難先は市町村の情報で確かめてください。指定緊急避難場所は災害のときに逃げる場所 (災害の種類ごと)、指定避難所は家に戻れないときに過ごす場所です",
  },
  {
    label: "ハザードマップ",
    note:
      "地図の右下で、なし・洪水 (想定最大規模の浸水)・土砂災害 (警戒区域)・津波 (浸水想定)・活断層から 1 つを選べます。色の意味は選んだときに出る公式の凡例のとおりです。想定の無い川や地域は塗られていないので、色が無くても安全とは限りません。" +
      "選んでいる間は、色がぶつからないよう、気象警報・注意報の塗りと縁取り・震度の塗り (数字のラベルは残ります)・緊急地震速報の地域の塗りを隠します。いま出ている特別警報の市町村等は白い縁の黒い線で縁取り、緊急地震速報の地域は赤い縁取りで、津波の警報・注意報の線もそのまま残します。「なし」に戻すと元に戻ります",
  },
  {
    label: "現在地",
    note: "地図の右下の現在地のボタンがオンの間 (既定はオン) だけ、白い縁の青い点と、位置の誤差の淡い円を出します。位置は端末の中で使うだけで、サーバーには送りません",
  },
  {
    label: "住んでいる地域",
    note: "「通知」で選んだ住んでいる地域 (市町村) を、黒い縁の上に水色の破線で縁取ります。地図を右クリック (スマホは長押し) して「ここを住んでいる地域にする」でも選べます",
  },
  {
    label: "活断層",
    note: "都市圏活断層図。地形の分類で塗った全面の図なので、いつもは重ねず、地図の右下のハザードマップで「活断層」を選んだときだけ出します。大きく寄せたとき (ズーム 11 以上) だけ出ます",
  },
];

const TRANSPARENT = "rgba(0,0,0,0)";

type Expr = unknown[];

/**
 * 地域の鍵 (気象庁の XML はコード、P2P は名前) から色を引く式。どちらも無ければ透明。
 * `match` は組を 1 つ以上要るので、空なら既定の値だけを返す
 */
export function matchExpr<T extends string | number>(
  byCode: Map<string, T>,
  byName: Map<string, T>,
  fallback: T | Expr,
): T | Expr {
  const make = (key: string, m: Map<string, T>, rest: T | Expr): T | Expr =>
    m.size === 0 ? rest : ["match", ["get", key], ...[...m].flat(), rest];
  return make("code", byCode, make("name", byName, fallback));
}

/** 震度の色で地域を塗る式 */
export function intensityFill(areas: AreaIntensity[]): string | Expr {
  const byCode = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const a of areas) {
    const color = INTENSITY_COLORS[a.int]?.bg;
    if (!color) continue;
    if (a.code) byCode.set(a.code, color);
    else byName.set(a.name, color);
  }
  return matchExpr(byCode, byName, TRANSPARENT);
}

/** 長周期地震動階級 1 以上の地域の枠の色の式 (階級 0 は透明。取消のときは呼ぶ側が空で渡す) */
export function longPeriodLine(areas: AreaLongPeriod[]): string | Expr {
  const byCode = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const a of areas) {
    const color = LG_COLORS[a.lg]?.bg;
    if (!color) continue;
    if (a.code) byCode.set(a.code, color);
    else byName.set(a.name, color);
  }
  return matchExpr(byCode, byName, TRANSPARENT);
}

/** 市町村等を、いま出ている気象警報・注意報のいちばん高い段の色で塗る式 */
export function warningFill(levels: Map<string, WarningLevel>): string | Expr {
  const byCode = new Map<string, string>();
  for (const [code, level] of levels) {
    const color = level > 0 ? WARNING_COLORS[level]?.bg : undefined;
    if (color) byCode.set(code, color);
  }
  return matchExpr(byCode, new Map(), TRANSPARENT);
}

/** 府県予報区ごとの市町村等と、その面の外枠 [西, 南, 東, 北] (`static/areas/offices.json`、tools/areas/offices.ts) */
export type OfficeTable = Record<
  string,
  Record<string, [number, number, number, number]>
>;

/** 住んでいる地域の市町村等だけを縁取る filter (決まっていなければ何も描かない) */
export function homeFilter(code: string | null | undefined): Expr {
  return ["==", ["get", "code"], code ?? ""];
}

/** 住んでいる地域の縁取りの色 (写真の上で読める水色。警報・注意報の段の色と取り違えない) */
const HOME_COLOR = "#3cd7ff";

/** 選んだ府県予報区の市町村等だけを縁取る filter (選んでいなければ何も描かない) */
export function officeFilter(
  table: OfficeTable,
  office: string | null | undefined,
): Expr {
  const codes = office ? Object.keys(table[office] ?? {}) : [];
  return ["in", ["get", "code"], ["literal", codes]];
}

/**
 * 選んだ府県予報区へ寄せる範囲 [[西, 南], [東, 北]]。警報・注意報の出ている市町村等が画面に収まるようにし
 * (東京都の伊豆諸島・小笠原のように離れた所まで含めて引きすぎない)、出ている所が表に無ければ府県予報区の全体
 */
export function officeBounds(
  table: OfficeTable,
  office: string,
  warned: string[],
): [[number, number], [number, number]] | undefined {
  const cities = table[office];
  if (!cities) return undefined;
  const hit = warned.flatMap((c) => (cities[c] ? [cities[c]] : []));
  const boxes = hit.length > 0 ? hit : Object.values(cities);
  const first = boxes[0];
  if (!first) return undefined;
  let [w, s, e, n] = first;
  for (const [bw, bs, be, bn] of boxes) {
    w = Math.min(w, bw);
    s = Math.min(s, bs);
    e = Math.max(e, be);
    n = Math.max(n, bn);
  }
  return [
    [w, s],
    [e, n],
  ];
}

/** 緊急地震速報の警報の地域 (名前) を塗る式 */
export function eewFill(eews: Eew[], color: string): string | Expr {
  const names = new Map<string, string>();
  for (const e of eews) {
    if (e.cancelled) continue;
    for (const n of e.warnAreas) names.set(n, color);
  }
  return matchExpr(new Map(), names, TRANSPARENT);
}

/** 津波予報区の線の色と太さ (大津波警報は太さを 2 倍。気象庁の配色の指針) */
export function tsunamiPaint(tsunamis: Tsunami[]): {
  color: string | Expr;
  width: number | Expr;
} {
  const byCode = new Map<string, string>();
  const byName = new Map<string, string>();
  const widthCode = new Map<string, number>();
  const widthName = new Map<string, number>();
  // 強いほうを後に入れて勝たせる
  const areas = tsunamis
    .flatMap((t) => t.areas)
    .filter((a) => a.grade !== "none")
    .sort(
      (a, b) => TSUNAMI_ORDER.indexOf(b.grade) - TSUNAMI_ORDER.indexOf(a.grade),
    );
  for (const a of areas) {
    const color = TSUNAMI_COLORS[a.grade]?.bg ?? TRANSPARENT;
    const width = a.grade === "major" ? 8 : a.grade === "forecast" ? 2 : 4;
    (a.code ? byCode : byName).set(a.code ?? a.name, color);
    (a.code ? widthCode : widthName).set(a.code ?? a.name, width);
  }
  return {
    color: matchExpr(byCode, byName, TRANSPARENT),
    width: matchExpr(widthCode, widthName, 0),
  };
}

/**
 * 震源の点の色 (深さ)。境は 30・100・300 km。深さの分からないものは灰色。
 * 震度の色 (気象庁の配色の指針) と取り違えないよう、震度のラベルとは別の形 (丸) で描く
 */
export const DEPTH_COLORS = [
  { upto: 30, color: "#ff3b30", label: "30 km まで" },
  { upto: 100, color: "#ffcc00", label: "100 km まで" },
  { upto: 300, color: "#34c759", label: "300 km まで" },
  { upto: Infinity, color: "#2f80ff", label: "それより深い" },
] as const;

/** 深さ (km、無ければ -1) から色を引く MapLibre の式 */
function depthColorExpr(): Expr {
  return [
    "case",
    ["<", ["get", "depth"], 0],
    "#9aa0a6",
    [
      "step",
      ["get", "depth"],
      DEPTH_COLORS[0].color,
      DEPTH_COLORS[0].upto + 0.5,
      DEPTH_COLORS[1].color,
      DEPTH_COLORS[1].upto + 0.5,
      DEPTH_COLORS[2].color,
      DEPTH_COLORS[2].upto + 0.5,
      DEPTH_COLORS[3].color,
    ],
  ];
}

/**
 * 震源の点 (新しい順に最大 n 件)。色は深さ、大きさは M。新しいものほど上に描く (`order`)
 */
export function hypocenterFeatures(quakes: Quake[], n = 50) {
  return {
    type: "FeatureCollection" as const,
    features: quakes
      .filter(
        (q) =>
          q.hypocenter?.lat !== undefined &&
          q.hypocenter.lon !== undefined &&
          !q.cancelled,
      )
      .slice(0, n)
      .map((q, i) => ({
        type: "Feature" as const,
        properties: {
          id: q.id,
          m: typeof q.magnitude === "number" ? q.magnitude : 3,
          depth: q.hypocenter?.depthKm ?? -1,
          order: n - i,
        },
        geometry: {
          type: "Point" as const,
          coordinates: [q.hypocenter?.lon ?? 0, q.hypocenter?.lat ?? 0],
        },
      })),
  };
}

/** 地域ごとの震度のラベルを置く所。重なったときに大きい震度が上に来るよう、小さいほうから並べる */
export function intensityLabels(
  areas: AreaIntensity[],
  points: Record<string, [number, number]>,
  byName: Map<string, string>,
): { int: ObservedIntensity; at: [number, number]; name: string }[] {
  return areas
    .flatMap((a) => {
      const code = a.code ?? byName.get(a.name);
      const at = code ? points[code] : undefined;
      return at ? [{ int: a.int, at, name: a.name }] : [];
    })
    .sort((a, b) => intensityRank(a.int) - intensityRank(b.int));
}

/** 海外の地震の点の出典 (機関を足したらここにも足す) */
const FOREIGN_ATTRIBUTION =
  '海外の地震: <a href="https://earthquake.usgs.gov/" target="_blank" rel="noopener">Credit: U.S. Geological Survey</a> | <a href="https://www.seismicportal.eu" target="_blank" rel="noopener">Credit: EMSC-CSEM SeismicPortal</a> (CC BY 4.0) | <a href="https://www.geonet.org.nz/" target="_blank" rel="noopener">GeoNet</a> (CC BY 3.0 NZ) | <a href="https://www.cwa.gov.tw/" target="_blank" rel="noopener">中央氣象署</a>';

/** 海外の地震の点 (新しい順に最大 n 件)。色は深さ、大きさは M */
export function foreignFeatures(quakes: ForeignQuake[], n = 50) {
  return {
    type: "FeatureCollection" as const,
    features: quakes.slice(0, n).map((q, i) => ({
      type: "Feature" as const,
      properties: {
        id: q.id,
        m: q.magnitude ?? 4.5,
        depth: q.depthKm ?? -1,
        order: n - i,
      },
      geometry: { type: "Point" as const, coordinates: [q.lon, q.lat] },
    })),
  };
}

/** 地図に置く火山の印 1 つ */
export interface VolcanoMark {
  code: string;
  name: string;
  at: [number, number];
  /** 警戒の段 (1〜5)。分からなければ無し */
  level?: number;
  kind: string;
  /** 選んだ情報の火山 */
  selected: boolean;
}

/**
 * 火山の印。いまの噴火警報・予報 (`latestPerVolcano`) で段が 2 以上の火山と、選んだ報の火山。
 * 位置は電文の位置、無ければ活火山の一覧 (`volcano-points.json`) から引く。段の低いほうから並べる (高い段が上に描かれる)
 */
export function volcanoMarks(
  levels: Volcano[],
  selected: Volcano | null | undefined,
  points: Record<string, [number, number, string?]>,
): VolcanoMark[] {
  const out = new Map<string, VolcanoMark>();
  const put = (v: Volcano, isSelected: boolean) => {
    for (const a of v.volcanoes) {
      const p = points[a.code];
      const at: [number, number] | undefined =
        a.lat !== undefined && a.lon !== undefined
          ? [a.lon, a.lat]
          : p
            ? [p[0], p[1]]
            : undefined;
      if (!at) continue;
      const prev = out.get(a.code);
      out.set(a.code, {
        code: a.code,
        name: a.name,
        at,
        // 噴火速報には段が無いので、いまの段を残す
        level: a.level ?? prev?.level,
        kind: a.kind,
        selected: isSelected || prev?.selected === true,
      });
    }
  };
  for (const v of levels) if (volcanoTop(v) >= 2) put(v, false);
  if (selected && !selected.cancelled) put(selected, true);
  return [...out.values()].sort(
    (a, b) =>
      Number(a.selected) - Number(b.selected) ||
      (a.level ?? 0) - (b.level ?? 0),
  );
}

/** 下地と、データの無い層。データ (色の式・点) は地図を作ったあとで差し込む */
export function baseStyle(
  /** スプライト (地理院の記号) を置いた所の頭。MapLibre は相対の URL を読まない */
  origin = "",
  hazard: HazardId = "none",
): Record<string, unknown> {
  const hazardShown = hazardVisibility(hazard);
  const overlay = overlayVisibility(hazard);
  const vis = (id: string) => ({
    visibility: overlay[id] === false ? "none" : "visible",
  });
  return {
    version: 8,
    // 字体 (glyphs) の URL は書かない。MapLibre は端末の字体で字を描く (外から字体を読まない。docs/map.md)
    sprite: `${origin}/map/gsi/sprite/std`,
    sources: {
      gsi: {
        type: "vector",
        url: `pmtiles://${GSI_VECTOR_URL}`,
        attribution: GSI_VECTOR_ATTRIBUTION,
      },
      ...Object.fromEntries(
        HAZARDS.flatMap((h) =>
          h.layers.map((l, i) => [
            `hazard-${l.id}`,
            {
              type: "raster",
              tiles: [l.tiles],
              tileSize: 256,
              minzoom: h.minzoom,
              maxzoom: h.maxzoom,
              ...(i === 0 ? { attribution: h.attribution } : {}),
            },
          ]),
        ),
      ),
      shelters: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        attribution: SHELTER_ATTRIBUTION,
      },
      "blue-marble": {
        type: "raster",
        tiles: [BLUE_MARBLE_TILES],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 8,
        attribution: BLUE_MARBLE_ATTRIBUTION,
      },
      photo: {
        type: "raster",
        tiles: [`${GSI}/seamlessphoto/{z}/{x}/{y}.jpg`],
        tileSize: 256,
        minzoom: PHOTO_MIN_ZOOM,
        maxzoom: 18,
        attribution: PHOTO_ATTRIBUTION,
      },
      "quake-areas": {
        type: "geojson",
        data: "/areas/quake-areas.geojson",
        attribution: JMA_GIS_ATTRIBUTION,
      },
      "tsunami-areas": {
        type: "geojson",
        data: "/areas/tsunami-areas.geojson",
      },
      "warning-areas": {
        type: "geojson",
        data: "/areas/warning-areas.geojson",
      },
      plates: {
        type: "geojson",
        data: PLATES_URL,
        attribution: PLATES_ATTRIBUTION,
      },
      foreign: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        attribution: FOREIGN_ATTRIBUTION,
      },
      // 台湾の観測点 (TREM-RTS)。点は画面が SSE で受けたものを差し込む (`#lib/rts.ts` の `rtsFeatures`)
      rts: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        attribution: RTS_ATTRIBUTION,
      },
      // 有志の観測点 (Wolfx SeisJS)。点の作り方は TREM-RTS と同じ
      seis: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        attribution: SEIS_ATTRIBUTION,
      },
      hypocenters: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
      me: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
    },
    layers: [
      // 引いたときの下地 (Blue Marble)。写真の出始め (9) から 1 段重ねて 10 まで残し、
      // 境で写真のタイルを読んでいる間も白く抜けないようにする (写真は透かさない JPEG なので、重ね終われば上を覆う)
      {
        id: "blue-marble",
        type: "raster",
        source: "blue-marble",
        maxzoom: PHOTO_MIN_ZOOM + 1,
      },
      // 写真は 9 から。陸の近くの海は Blue Marble の暗い紺より明るい青なので、半段かけて透かしから重ねる
      {
        id: "photo",
        type: "raster",
        source: "photo",
        minzoom: PHOTO_MIN_ZOOM,
        paint: {
          "raster-opacity": [
            "interpolate",
            ["linear"],
            ["zoom"],
            PHOTO_MIN_ZOOM,
            0,
            PHOTO_MIN_ZOOM + 0.5,
            1,
          ],
        },
      },
      // ハザードマップ (選んだものだけ。写真のすぐ上に、透かして重ねる)
      ...HAZARDS.flatMap((h) =>
        h.layers.map((l) => ({
          id: `hazard-${l.id}`,
          type: "raster",
          source: `hazard-${l.id}`,
          paint: { "raster-opacity": h.opacity },
          layout: {
            visibility: hazardShown[`hazard-${l.id}`] ? "visible" : "none",
          },
        })),
      ),
      // プレート境界 (PB2002)。付加情報のいちばん下に、細い破線で引く (震源の丸や区域の色を邪魔しない)。
      // 研究の模型の線なので、寄せても太くしすぎない
      {
        id: "plate-boundaries",
        type: "line",
        source: "plates",
        layout: { "line-join": "round" },
        paint: {
          "line-color": PLATE_COLOR,
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.8, 8, 1.6],
          "line-dasharray": [3, 2],
        },
      },
      // 気象警報・注意報は震度の下に塗る (地震のときは震度を見せる)。ハザードマップを重ねている間は隠す
      {
        id: "warning-fill",
        type: "fill",
        source: "warning-areas",
        layout: vis("warning-fill"),
        paint: { "fill-color": TRANSPARENT, "fill-opacity": 0.6 },
      },
      {
        id: "quake-fill",
        type: "fill",
        source: "quake-areas",
        layout: vis("quake-fill"),
        paint: { "fill-color": TRANSPARENT, "fill-opacity": 0.75 },
      },
      {
        id: "eew-fill",
        type: "fill",
        source: "quake-areas",
        layout: vis("eew-fill"),
        paint: { "fill-color": TRANSPARENT, "fill-opacity": 0.35 },
      },
      {
        id: "eew-line",
        type: "line",
        source: "quake-areas",
        paint: { "line-color": TRANSPARENT, "line-width": 2.5 },
      },
      {
        id: "quake-line",
        type: "line",
        source: "quake-areas",
        paint: { "line-color": "rgba(255,255,255,0.45)", "line-width": 0.6 },
      },
      {
        id: "longperiod-line",
        type: "line",
        source: "quake-areas",
        layout: { "line-join": "round" },
        paint: { "line-color": TRANSPARENT, "line-width": 3 },
      },
      {
        id: "tsunami",
        type: "line",
        source: "tsunami-areas",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": TRANSPARENT, "line-width": 0 },
      },
      // 一覧で選んだ府県予報区の市町村等の縁取り (写真の上で読めるよう、黒い縁の上に白い線)
      {
        id: "warning-focus-casing",
        type: "line",
        source: "warning-areas",
        filter: officeFilter({}, null),
        layout: { "line-join": "round", ...vis("warning-focus-casing") },
        paint: { "line-color": "rgba(0,0,0,0.6)", "line-width": 4 },
      },
      {
        id: "warning-focus",
        type: "line",
        source: "warning-areas",
        filter: officeFilter({}, null),
        layout: { "line-join": "round", ...vis("warning-focus") },
        paint: { "line-color": "#fff", "line-width": 1.75 },
      },
      // ハザードマップを重ねている間、いま出ている特別警報の市町村等は塗らずに縁取る (白い縁の上に特別警報の色の太い線)
      {
        id: "warning-special-casing",
        type: "line",
        source: "warning-areas",
        filter: specialWarningFilter(new Map()),
        layout: { "line-join": "round", ...vis("warning-special-casing") },
        paint: { "line-color": "#fff", "line-width": 6 },
      },
      {
        id: "warning-special",
        type: "line",
        source: "warning-areas",
        filter: specialWarningFilter(new Map()),
        layout: { "line-join": "round", ...vis("warning-special") },
        paint: {
          "line-color": WARNING_COLORS[5]?.bg ?? "#000",
          "line-width": 3,
        },
      },
      ...roadLayers(),
      // 住んでいる地域 (通知の条件) の市町村等の縁取り。黒い縁の上に水色の破線 (府県予報区の白い縁取りと見分ける)
      {
        id: "home-casing",
        type: "line",
        source: "warning-areas",
        filter: homeFilter(null),
        layout: { "line-join": "round" },
        paint: { "line-color": "rgba(0,0,0,0.65)", "line-width": 5 },
      },
      {
        id: "home-line",
        type: "line",
        source: "warning-areas",
        filter: homeFilter(null),
        layout: { "line-join": "round" },
        paint: {
          "line-color": HOME_COLOR,
          "line-width": 2.5,
          "line-dasharray": [2, 1],
        },
      },
      // 台湾の観測点のいまの揺れ (TREM-RTS)。見た目は下の stationLayer
      stationLayer("rts"),
      // 有志の観測点のいまの揺れ (Wolfx SeisJS)。見た目は台湾の観測点と同じ
      stationLayer("seis"),
      {
        id: "hypocenters",
        type: "circle",
        source: "hypocenters",
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["get", "m"],
            1,
            3,
            5,
            7,
            8,
            16,
          ],
          "circle-color": depthColorExpr(),
          "circle-opacity": 0.8,
          "circle-stroke-color": "rgba(0,0,0,0.6)",
          "circle-stroke-width": 1,
        },
        layout: { "circle-sort-key": ["get", "order"] },
      },
      {
        id: "foreign",
        type: "circle",
        source: "foreign",
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["get", "m"],
            4,
            5,
            6,
            9,
            9,
            18,
          ],
          "circle-color": depthColorExpr(),
          "circle-opacity": 0.55,
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 1.5,
        },
        layout: { "circle-sort-key": ["get", "order"] },
      },
      // 地理院の注記 (地名・施設の記号) は、地図を作ったあとでここ (避難場所の下) に差し込む (`/map/gsi/anno.json`)
      {
        id: "shelters",
        type: "symbol",
        source: "shelters",
        minzoom: SHELTER_MIN_ZOOM,
        layout: {
          "icon-image": "shelter",
          "icon-allow-overlap": true,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 14, 0.8, 17, 1.1],
        },
      },
      // 現在地 (いちばん上)。誤差の円は淡く塗り、点は白い縁の青
      {
        id: "me-accuracy",
        type: "fill",
        source: "me",
        filter: ["==", ["get", "kind"], "accuracy"],
        paint: { "fill-color": ME_COLOR, "fill-opacity": 0.15 },
      },
      {
        id: "me-accuracy-line",
        type: "line",
        source: "me",
        filter: ["==", ["get", "kind"], "accuracy"],
        paint: {
          "line-color": ME_COLOR,
          "line-opacity": 0.5,
          "line-width": 1,
        },
      },
      {
        id: "me-dot",
        type: "circle",
        source: "me",
        filter: ["==", ["get", "kind"], "dot"],
        paint: {
          "circle-radius": 7,
          "circle-color": ME_COLOR,
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 2.5,
        },
      },
    ],
  };
}

/**
 * 道路 (地理院地図Vector の道路中心線)。写真の上で読めるよう、細い黒い縁取りの上に明るい線を引く。
 * 引いているときは高速道路と国道だけ、寄せるほど細い道まで出す (読むタイルと描く線を減らす)
 */
function roadLayers(): Record<string, unknown>[] {
  const kinds: {
    id: string;
    ctg: string[];
    min: number;
    color: string;
    w: [number, number, number, number];
  }[] = [
    {
      id: "minor",
      ctg: ["市区町村道等", "不明"],
      min: 13,
      color: "rgba(255,255,255,0.85)",
      w: [13, 0.6, 16, 2.5],
    },
    {
      id: "pref",
      ctg: ["都道府県道"],
      min: 10,
      color: "#ffffff",
      w: [10, 0.6, 16, 4],
    },
    {
      id: "national",
      ctg: ["国道"],
      min: 7,
      color: "#ffe066",
      w: [7, 0.6, 16, 5],
    },
    {
      id: "motorway",
      ctg: ["高速自動車国道等"],
      min: 6,
      color: "#ffa04d",
      w: [6, 0.8, 16, 5],
    },
  ];
  return kinds.flatMap((k) => {
    const [z0, w0, z1, w1] = k.w;
    const base = {
      type: "line",
      source: "gsi",
      "source-layer": "RdCL",
      minzoom: k.min,
      filter: ["in", ["get", "vt_rdctg"], ["literal", k.ctg]],
      layout: { "line-join": "round", "line-cap": "round" },
    };
    return [
      {
        ...base,
        id: `road-${k.id}-casing`,
        paint: {
          "line-color": "rgba(0,0,0,0.55)",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            z0,
            w0 + 1.2,
            z1,
            w1 + 2,
          ],
        },
      },
      {
        ...base,
        id: `road-${k.id}`,
        paint: {
          "line-color": k.color,
          "line-width": ["interpolate", ["linear"], ["zoom"], z0, w0, z1, w1],
        },
      },
    ];
  });
}

/** 現在地の青い点の色 (震源の深さの青と分けるため、白い縁を太く付ける) */
const ME_COLOR = "#1a73e8";

/**
 * 現在地の点と、位置の誤差の円 (半径はメートル。地図のズームにかかわらず実際の大きさで描くため、
 * 多角形にする)。端末の中で描くだけで、緯度・経度はサーバーに送らない
 */
export function meFeatures(
  lon: number,
  lat: number,
  accuracyM: number,
  steps = 64,
) {
  const R = 6_371_008.8;
  const r = Math.max(accuracyM, 0) / R;
  const φ = (lat * Math.PI) / 180;
  const λ = (lon * Math.PI) / 180;
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const θ = (2 * Math.PI * (i % steps)) / steps;
    const φ2 = Math.asin(
      Math.sin(φ) * Math.cos(r) + Math.cos(φ) * Math.sin(r) * Math.cos(θ),
    );
    const λ2 =
      λ +
      Math.atan2(
        Math.sin(θ) * Math.sin(r) * Math.cos(φ),
        Math.cos(r) - Math.sin(φ) * Math.sin(φ2),
      );
    ring.push([(λ2 * 180) / Math.PI, (φ2 * 180) / Math.PI]);
  }
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: { kind: "accuracy" },
        geometry: { type: "Polygon" as const, coordinates: [ring] },
      },
      {
        type: "Feature" as const,
        properties: { kind: "dot" },
        geometry: { type: "Point" as const, coordinates: [lon, lat] },
      },
    ],
  };
}

/** 日本の全体が入る範囲 (南西・北東) */
export const JAPAN_BOUNDS: [[number, number], [number, number]] = [
  [122, 24],
  [149, 46],
];

/**
 * 観測点のいまの揺れの層 (台湾の TREM-RTS と Wolfx SeisJS)。震源の丸の下に、小さな点で置く。ふだんは控えた灰色、
 * 揺れの値が来た観測点だけ震度の色で少し大きく (大きい値ほど上)。押しても何も出さない
 */
function stationLayer(id: "rts" | "seis") {
  return {
    id,
    type: "circle" as const,
    source: id,
    paint: {
      // ズームの補間は式の外側に 1 つだけ (MapLibre の決まり)。中で揺れているかで分ける
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        4,
        ["case", ["get", "shaking"], 4, 2],
        9,
        ["case", ["get", "shaking"], 7, 3.5],
      ],
      "circle-color": ["get", "color"],
      // 灰色の点も写真の上で見分けられる濃さに (震源の丸より小さく、縁は細く)
      "circle-opacity": ["case", ["get", "shaking"], 0.95, 0.8],
      "circle-stroke-color": "rgba(0,0,0,0.6)",
      "circle-stroke-width": ["case", ["get", "shaking"], 1, 0.5],
    },
    layout: { "circle-sort-key": ["get", "order"] },
  };
}
