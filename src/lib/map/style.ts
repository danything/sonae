/**
 * 地図の下地と、重ねる層 (docs/map.md)。MapLibre の style と、データから色の式を組む関数。
 * DOM にも MapLibre にも触らない (試験できるように)。
 */

import {
  INTENSITY_COLORS,
  LG_COLORS,
  TSUNAMI_COLORS,
  volcanoKindText,
  WARNING_COLORS,
} from "#lib/format.ts";
import { ashLayers, ashSources } from "#lib/map/ash.ts";
import {
  FOREIGN_RADIUS,
  HYPO_RADIUS,
  radiusExpr,
} from "#lib/map/epicenters.ts";
import { livecamFeatures } from "#lib/map/livecams.ts";
import { OFFICE_MINZOOM, TIDE_MINZOOM } from "#lib/map/marine.ts";
import {
  JMATILE,
  N3_TILE_ZOOMS,
  NOWC_KINDS,
  NOWC_PAGE,
  nowcOf,
  RASRF_PAGE,
  RASRF_TILE_ZOOMS,
  SLMCS_COLOR,
  stepLayerZoom,
} from "#lib/map/nowc.ts";
import { LOOP_SLOTS, loopLayerId } from "#lib/map/rain-loop.ts";
import {
  RAIN_ATTRIBUTION,
  RAIN_TILE_ZOOMS,
  type RainFrame,
  rainLayerZoom,
  rainTiles,
} from "#lib/map/rain.ts";
import {
  RISK_ATTRIBUTION,
  RISK_TILE_ZOOMS,
  type RiskFrame,
  riskOf,
  RISKS,
  riskTiles,
  RIVER_CALM_COLOR,
  RIVER_CASING,
  RIVER_CASING_SEVERE,
  RIVER_LEVEL_COLORS,
  RIVER_MAP_MINZOOM,
  SMALL_RIVER_CALM_COLOR,
  SMALL_RIVER_CASING,
} from "#lib/map/risk.ts";
import {
  typhoonLineLayers,
  typhoonPointLayers,
  typhoonSources,
} from "#lib/map/typhoon.ts";
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
  '<a href="https://seis.wolfx.jp/" target="_blank" rel="noopener">Wolfx Project (SeisJS)</a>・非公式';

const ROADS_ATTRIBUTION =
  '出典：<a href="https://www.mlit.go.jp/road/road_fr4_000201.html" target="_blank" rel="noopener">国土交通省「通れるマップ」</a>を加工して作成';

const MARINE_ATTRIBUTION =
  '出典：<a href="https://www.msil.go.jp/" target="_blank" rel="noopener">海洋状況表示システム</a> (海底地殻変動観測点・海域火山DB・海上保安部署等・潮汐推算 を加工)';

/** YouTube のライブカメラの出典 (全文は `#lib/notice.ts` の CREDITS) */
const LIVECAMS_ATTRIBUTION =
  "ライブカメラ: 九州地方整備局・杉並区・東京都港湾局 (YouTube)";

/** 火山の監視カメラの位置の出典 (全文は `#lib/notice.ts` の CREDITS) */
const CAMERAS_ATTRIBUTION =
  '出典：<a href="https://www.data.jma.go.jp/vois/data/obs/volcam/volcam.php" target="_blank" rel="noopener">気象庁ホームページ (監視カメラ画像)</a>';

const JMA_GIS_ATTRIBUTION =
  '<a href="https://www.data.jma.go.jp/developer/gis.html" target="_blank" rel="noopener">気象庁 予報区等 GIS データ</a> を加工';

/** 震度観測点の位置の出典 (全文は `#lib/notice.ts` の CREDITS) */
const STATIONS_ATTRIBUTION =
  '<a href="https://www.jma.go.jp/jma/kishou/know/jishin/intens-st/" target="_blank" rel="noopener">気象庁 震度観測点</a>・<a href="https://xml.kishou.go.jp/tec_material.html" target="_blank" rel="noopener">地震火山関連コード表</a> を加工';

/**
 * 地域ごとの震度の塗りの濃さ。観測点の丸を出しているときは、寄せるほど薄くする (引いているときは丸が重なり、
 * 地域の塗りが全体の見当になる。寄せると丸が離れて観測点ごとに読めるので、塗りは下地に回す。docs/map.md)
 */
export const QUAKE_FILL_OPACITY = 0.75;
export function quakeFillOpacity(withStations: boolean): number | Expr {
  if (!withStations) return QUAKE_FILL_OPACITY;
  return ["interpolate", ["linear"], ["zoom"], 6, QUAKE_FILL_OPACITY, 9, 0.3];
}

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
/** 通行止め (災害) の線の色と、通れた道 (目安) の線の色 (docs/map.md の「災害時の通行止め」) */
export const ROAD_CLOSED_COLOR = "#e60012";
export const ROAD_SLOW_COLOR = "#ff9900";
export const ROAD_FAST_COLOR = "#3cc8ff";
/**
 * 通れた道 (目安) の線を隠すズーム。この値から上では描かず、押しても吹き出しを出さない。
 * 元の線は ETC2.0 の記録の点を直線でつないだもので、道路から数百 m ずれる所がある。寄せるとずれが道路と取り違えるほど
 * 大きく見えるので隠す (docs/map.md の「災害時の通行止め」)
 */
export const ROAD_SPEED_MAXZOOM = 13;

/**
 * 火山の監視カメラの印を出すズーム。引いた縮尺では 1 つの火山に 2〜8 台が重なり、噴火警報・予報の火山の印も隠すので、
 * 火山の周りが見分けられるズームから出す (docs/map.md の「火山の監視カメラ」)
 */
export const CAMERA_MINZOOM = 7;

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
 * 重ねる図 (重ねるラスタータイル)。選ぶのは 1 つだけ (色がぶつかるため)。
 * 雨雲 (気象庁の高解像度降水ナウキャスト。`#lib/map/rain.ts`)、今後の雨 (降水短時間予報)、雷・竜巻 (ナウキャスト)、キキクル (気象庁の土砂・大雨の危険度。`#lib/map/risk.ts`) と、
 * ハザードマップ (ハザードマップポータルサイトの水害と土砂災害) と、地震の備えの図 (地理院タイルの都市圏活断層図と、
 * 防災科研の J-SHIS の 2 つ)。どれも面を塗る図なので、いつも重ねると写真と警報・注意報の塗りが見づらい。選んだときだけ出す
 */
export type HazardId =
  | "none"
  | "rain"
  | "rain-loop"
  | "rain-forecast"
  | "thunder"
  | "tornado"
  | "risk-land"
  | "risk-heavyrain"
  | "risk-inund"
  | "risk-flood"
  | "flood"
  | "flood-duration"
  | "flood-collapse"
  | "naisui"
  | "hightide"
  | "tsunami"
  | "landslide"
  | "faults"
  | "quake-prob"
  | "ground-amp";
const DISAPORTAL = "https://disaportaldata.gsi.go.jp/raster";
const LEGEND = "https://disaportal.gsi.go.jp/hazardmap/copyright/img";
const DISAPORTAL_OPENDATA =
  "https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html";
const HAZARD_ATTRIBUTION = `<a href="${DISAPORTAL_OPENDATA}" target="_blank" rel="noopener">ハザードマップポータルサイト</a>`;
/** 国土地理院の「活断層図（都市圏活断層図）について」(各図の調査者がある) */
const GSI_AFM_ABOUT = "https://www.gsi.go.jp/bousaichiri/active_fault.html";

/**
 * 防災科研の J-SHIS (地震ハザードステーション) の WMS。地図の画像をブラウザから直接読む (docs/map.md の「J-SHIS」)。
 * 確率論的地震動予測地図は 2024 年版 (`Y2024`。2026-11-21 に GetCapabilities で確かめた、いちばん新しいもの)、
 * 表層地盤は V4
 */
export const JSHIS = "https://www.j-shis.bosai.go.jp";
export const JSHIS_PSHM_VERSION = "Y2024";
/** 今後 30 年に震度 6 弱以上の揺れに見舞われる確率 (平均ケース・全ての地震・5 段の色) */
export const JSHIS_PSHM_LAYER = `P-${JSHIS_PSHM_VERSION}-MAP-AVR-TTL_MTTL-T30_I55_PD`;
/** 表層地盤の増幅率 (工学的基盤 Vs=400m/s から地表まで) */
export const JSHIS_AMP_LAYER = "Z-V4-JAPAN-AMP-VS400_M250-IDARV2";
const JSHIS_PSHM_WMS = `${JSHIS}/map/wms/pshm/${JSHIS_PSHM_VERSION}`;
const JSHIS_SSTRCT_WMS = `${JSHIS}/map/wms/sstrct/V4`;
/**
 * J-SHIS の WMS の 1 枚の大きさ (px)。256px の 4 枚分を 1 枚で読み、リクエストを減らす。
 * J-SHIS から「連続した大量のリクエストは避けてほしい」と返事をもらった (2026-11-25。docs/map.md の「J-SHIS」)
 */
export const JSHIS_TILE_SIZE = 512;
/**
 * J-SHIS の画像を読むいちばん大きいズーム。250m の格子なので、512px の 1 枚が約 38m/px になる 11 で足りる。
 * それより寄せたら、読み足さずに 11 の画像を引き伸ばす
 */
export const JSHIS_FETCH_MAXZOOM = 11;
/**
 * WMS の GetMap を、MapLibre が埋める見ている範囲 (`{bbox-epsg-3857}`) で読む URL。WMS 1.3.0 の EPSG:3857 は
 * x・y の順 (経度の側から)。`size` px 四方の透かした PNG
 */
export const wmsTiles = (base: string, layer: string, size = JSHIS_TILE_SIZE) =>
  `${base}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=${size}&HEIGHT=${size}&LAYERS=${layer}&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE`;
const wmsLegend = (base: string, layer: string) =>
  `${base}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetLegendGraphic&SLD_VERSION=1.1.0&LAYER=${layer}&FORMAT=image/png&STYLE=default`;
const JSHIS_ATTRIBUTION = `<a href="${JSHIS}/" target="_blank" rel="noopener">J-SHIS (防災科研)</a>`;

/** 選択肢の見出し。並びは `HAZARD_GROUPS` の順 */
export type HazardGroup = "water" | "quake";
export const HAZARD_GROUPS: { id: HazardGroup; label: string }[] = [
  { id: "water", label: "ハザードマップ (水害・土砂災害)" },
  { id: "quake", label: "地震の備え" },
];

export interface Hazard {
  id: Exclude<
    HazardId,
    | "none"
    | "rain"
    | "rain-loop"
    | "rain-forecast"
    | "thunder"
    | "tornado"
    | "risk-land"
    | "risk-heavyrain"
    | "risk-inund"
    | "risk-flood"
  >;
  /** 選択肢の見出し */
  group: HazardGroup;
  /** 選択肢の名前 */
  label: string;
  /** 選んでいる間のボタンの文字 (いま起きているように読めないよう、何の図かを残す) */
  pill: string;
  /**
   * 同じ選択肢の中で切り替える図 (洪水の浸水の深さ・浸水が続く時間・家屋倒壊等氾濫想定区域)。
   * 選択肢には `parent` の無いものだけを並べ、凡例の上で切り替える
   */
  parent?: Hazard["id"];
  /** 凡例の上で切り替えるときの名前 */
  variant?: string;
  /** 凡例の上に出す、何の想定か */
  title: string;
  /** タイルの層 (土砂災害は 3 つを重ねる)。地図の層の名前は `hazard-<id>` */
  layers: { id: string; tiles: string }[];
  /** タイルのあるズーム */
  minzoom: number;
  maxzoom: number;
  /** タイル 1 枚の大きさ (px。無ければ 256) */
  tileSize?: number;
  /** 画像を読むいちばん大きいズーム (無ければ `maxzoom`)。それより寄せたら引き伸ばす */
  fetchMaxzoom?: number;
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
  /** 凡例の下の出典 (無ければ出さない) と、色の無い所についての注意 */
  source?: { text: string; href: string };
  caveat?: string;
}

const portal = (layer: string) => ({
  id: layer,
  tiles: `${DISAPORTAL}/${layer}/{z}/{x}/{y}.png`,
});
const PORTAL = {
  group: "water" as const,
  minzoom: 2,
  maxzoom: 17,
  opacity: 0.75,
  attribution: HAZARD_ATTRIBUTION,
  credit: "ハザードマップポータルサイト",
  source: { text: "ハザードマップポータルサイト", href: DISAPORTAL_OPENDATA },
  caveat:
    "想定の無い川や地域は塗られていません。色が無くても安全とは限りません。",
};
const DEPTH_LEGEND = {
  src: `${LEGEND}/shinsui_legend3.png`,
  alt: "浸水深の凡例: 0.5m 未満から 20m 以上まで、深いほど濃い色",
};
const JSHIS_COMMON = {
  group: "quake" as const,
  // 日本全体を 1 枚で見るズームから。250m の格子なので、11 より寄せたら読み足さずに引き伸ばす
  minzoom: 4,
  maxzoom: 14,
  tileSize: JSHIS_TILE_SIZE,
  fetchMaxzoom: JSHIS_FETCH_MAXZOOM,
  // 陸の全面を塗る図なので、写真が透けて見えるよう少し透かす
  opacity: 0.7,
  attribution: JSHIS_ATTRIBUTION,
  credit: "J-SHIS (防災科研)",
  source: {
    text: "防災科研 J-SHIS 地震ハザードステーション",
    href: `${JSHIS}/`,
  },
};

export const HAZARDS: Hazard[] = [
  {
    id: "flood",
    label: "洪水",
    pill: "ハザードマップ: 洪水",
    variant: "浸水の深さ",
    title: "洪水浸水想定区域 (想定最大規模)",
    ...PORTAL,
    layers: [portal("01_flood_l2_shinsuishin_data")],
    legends: [DEPTH_LEGEND],
  },
  {
    id: "flood-duration",
    parent: "flood",
    label: "浸水継続時間",
    pill: "ハザードマップ: 浸水が続く時間",
    variant: "浸水が続く時間",
    title: "浸水継続時間 (想定最大規模)",
    ...PORTAL,
    layers: [portal("01_flood_l2_keizoku_data")],
    legends: [
      {
        src: `${LEGEND}/shinsui_legend_l2_keizoku.png`,
        alt: "浸水が続く時間の凡例: 12 時間未満から 4 週間以上まで、長いほど濃い色",
      },
    ],
  },
  {
    id: "flood-collapse",
    parent: "flood",
    label: "家屋倒壊等氾濫想定区域",
    pill: "ハザードマップ: 家屋倒壊等",
    variant: "家屋倒壊等",
    title: "家屋倒壊等氾濫想定区域 (氾濫流・河岸侵食)",
    ...PORTAL,
    // タイルはズーム 4 から (オープンデータの一覧)
    minzoom: 4,
    layers: [
      portal("01_flood_l2_kaokutoukai_hanran_data"),
      portal("01_flood_l2_kaokutoukai_kagan_data"),
    ],
    legends: [
      {
        src: `${LEGEND}/kaokutoukai_hanran.png`,
        alt: "氾濫流の凡例: 赤い丸の模様",
        name: "氾濫流",
      },
      {
        src: `${LEGEND}/kaokutoukai_kagan.png`,
        alt: "河岸侵食の凡例: 赤い面",
        name: "河岸侵食",
      },
    ],
    about: [
      "川があふれた水の勢いや、川岸が削られることで、家が壊れたり流されたりするおそれのある区域です。",
    ],
  },
  {
    id: "naisui",
    label: "内水",
    pill: "ハザードマップ: 内水",
    title: "内水 (雨水出水) 浸水想定区域",
    ...PORTAL,
    layers: [portal("02_naisui_data")],
    legends: [
      {
        src: `${LEGEND}/naisui_legend.png`,
        alt: "内水の浸水深の凡例: 0.1m 未満から 20m 以上まで、深いほど濃い色",
      },
    ],
    about: [
      "下水道や水路があふれる浸水の想定です。オープンデータにするのを認めた市町村の分だけが載っています。",
    ],
  },
  {
    id: "hightide",
    label: "高潮",
    pill: "ハザードマップ: 高潮",
    title: "高潮浸水想定区域 (想定最大規模)",
    ...PORTAL,
    layers: [portal("03_hightide_l2_shinsuishin_data")],
    legends: [DEPTH_LEGEND],
  },
  {
    id: "tsunami",
    label: "津波",
    pill: "ハザードマップ: 津波",
    title: "津波浸水想定",
    ...PORTAL,
    layers: [portal("04_tsunami_newlegend_data")],
    legends: [DEPTH_LEGEND],
  },
  {
    id: "landslide",
    label: "土砂災害",
    pill: "ハザードマップ: 土砂災害",
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
    id: "faults",
    group: "quake",
    label: "活断層",
    pill: "活断層",
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
  {
    id: "quake-prob",
    label: "揺れの確率 (30 年)",
    pill: "揺れの確率 (30 年)",
    title: "今後 30 年に震度 6 弱以上の揺れに見舞われる確率",
    ...JSHIS_COMMON,
    layers: [
      { id: "jshis-pshm", tiles: wmsTiles(JSHIS_PSHM_WMS, JSHIS_PSHM_LAYER) },
    ],
    legends: [
      {
        src: wmsLegend(JSHIS_PSHM_WMS, JSHIS_PSHM_LAYER),
        alt: "確率の凡例: 0.1% 未満から 26% 以上まで 5 段、高いほど赤から紫",
      },
    ],
    about: [
      "防災科研の確率論的地震動予測地図 (2024 年版・平均ケース・全ての地震)。地震調査研究推進本部の評価をもとにした計算で、誤差を含みます。",
    ],
    caveat:
      "確率が低い所でも、強い揺れに見舞われないとは限りません (確率の低い所で起きた大きな地震もあります)。",
  },
  {
    id: "ground-amp",
    label: "地盤の揺れやすさ",
    pill: "地盤の揺れやすさ",
    title: "表層地盤の揺れやすさ (地盤増幅率)",
    ...JSHIS_COMMON,
    layers: [
      { id: "jshis-amp", tiles: wmsTiles(JSHIS_SSTRCT_WMS, JSHIS_AMP_LAYER) },
    ],
    legends: [
      {
        src: wmsLegend(JSHIS_SSTRCT_WMS, JSHIS_AMP_LAYER),
        alt: "増幅率の凡例: 0.8 未満から 2.3 以上まで、大きいほど赤から紫",
      },
    ],
    about: [
      "防災科研の表層地盤 (V4) の、固い地盤 (Vs=400m/s) から地表までに揺れが何倍になるかの目安。約 250m 四方ごとの代表値です。",
    ],
    caveat:
      "数が大きいほど揺れやすい地盤です。同じ四角の中でも、場所によって揺れ方は違います。",
  },
];

/** 選択肢に並べる図 (凡例の上で切り替える図を除く) */
export const HAZARD_CHOICES = HAZARDS.filter((h) => !h.parent);

/** 選んだ図と、凡例の上で切り替えられる仲間 (洪水なら 3 つ。仲間が無ければ空) */
export function hazardFamily(id: HazardId): Hazard[] {
  const h = HAZARDS.find((x) => x.id === id);
  if (!h) return [];
  const root = h.parent ?? h.id;
  const family = HAZARDS.filter((x) => x.id === root || x.parent === root);
  return family.length > 1 ? family : [];
}

/** 選択肢のどれを選んでいる印にするか (凡例の上で切り替える図は、親の選択肢) */
export const hazardChoice = (id: HazardId): HazardId =>
  HAZARDS.find((x) => x.id === id)?.parent ?? id;

/** ハザードマップの層ごとに出すかどうか (選んだものだけ。なしなら全部隠す) */
export function hazardVisibility(id: HazardId): Record<string, boolean> {
  return Object.fromEntries(
    HAZARDS.flatMap((h) =>
      h.layers.map((l) => [`hazard-${l.id}`, h.id === id]),
    ),
  );
}

/**
 * 重ねる図のどれかを選んでいる間に隠す層。面で塗る色が重ねる図の色とぶつかって見分けられないため。
 * 気象警報・注意報の塗りと、一覧で選んだ府県予報区の縁取り・震度の塗り (震度は地域の上の数字のラベルで残る)・
 * 緊急地震速報の地域の塗り (縁取りの `eew-line` は残す)・通れた道 (`road-speed`)
 */
export const HIDDEN_UNDER_HAZARD = [
  "warning-fill",
  "warning-focus-casing",
  "warning-focus",
  "quake-fill",
  "eew-fill",
  // 通れた道 (目安) の橙と青の細い線は、浸水想定などの色と重なる。通行止めの赤い線は残す
  "road-speed",
  // 選んだ降灰予報の範囲の塗り。縁の線 (`ash-line`) は残す (震度の塗りを隠して数字のラベルを残すのと同じ)
  "ash-fill",
  "ash-stripe",
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

/**
 * 地震を選んでいる間に隠す層 (気象警報・注意報の塗りと、一覧で選んだ府県予報区の縁取り)。警報・注意報の黄・赤・紫が
 * 震度の色 (黄・赤・紫) と重なって読み違えるため。特別警報は `SHOWN_UNDER_HAZARD` の縁取りで残す (docs/map.md の
 * 「地震を選んでいる間」)。緊急地震速報と津波の線は隠さない
 */
export const HIDDEN_UNDER_QUAKE = [
  "warning-fill",
  "warning-focus-casing",
  "warning-focus",
] as const;

/** 雨雲を写真の上に重ねるときの不透明度 (ハザードマップより少し濃く。淡い 0〜1 mm/h も写真の上で見える) */
export const RAIN_OPACITY = 0.8;

/**
 * 雨雲を出すか。地震を選んでいる間は隠す。雨雲の色 (気象庁の降水量の配色) は震度の色と同じ色を使うので、
 * 重ねると震度を読み違えるため (docs/map.md の「地震を選んでいる間」)。地震を見ている間に読みたいのは震度
 */
export const rainShown = (id: HazardId, quake: boolean) =>
  id === "rain" && !quake;

/** 雨雲の層ごとに出すかどうか。時刻の表をまだ読めていない (`ready` でない) 間は出さない */
export function rainVisibility(
  id: HazardId,
  quake: boolean,
  ready: boolean,
): Record<string, boolean> {
  const on = ready && rainShown(id, quake);
  return Object.fromEntries(RAIN_TILE_ZOOMS.map((n) => [`rain-${n}`, on]));
}

/** 雨雲 (いま→予測) を出すか。雨雲と同じく、地震を選んでいる間は隠す (docs/map.md の「雨雲 (いま→予測)」) */
export const loopShown = (id: HazardId, quake: boolean) =>
  id === "rain-loop" && !quake;

/**
 * 雨雲 (いま→予測) の層ごとに出すかどうか (`rainloop-<枚>-<ズーム>`)。`ready` は枚ごとに時刻の表を読めているか
 * (`#lib/map/rain-loop.ts` の `loopReady`)。読めている枚は全部出し (タイルを読んでおく)、見せる枚は透明度で選ぶ
 */
export function loopVisibility(
  id: HazardId,
  quake: boolean,
  ready: readonly boolean[],
): Record<string, boolean> {
  const on = loopShown(id, quake);
  return Object.fromEntries(
    LOOP_SLOTS.flatMap((s) =>
      RAIN_TILE_ZOOMS.map((n) => [loopLayerId(s, n), on && ready[s] === true]),
    ),
  );
}

/** 雨雲 (いま→予測) の枚ごとの透明度。見せる枚だけを雨雲と同じ濃さにし、ほかは 0 (描かないが、タイルは持つ) */
export const loopOpacity = (slot: number, shown: number) =>
  slot === shown ? RAIN_OPACITY : 0;

/** キキクルを写真の上に重ねるときの不透明度 (雨雲と同じ。黄の「注意」も写真の上で見える) */
export const RISK_OPACITY = 0.8;

/**
 * キキクルを出すか。雨雲と同じく、地震を選んでいる間は隠す。キキクルの黄・赤・紫は震度の色とぶつかるため
 * (docs/map.md の「地震を選んでいる間」)
 */
export const riskShown = (id: HazardId, quake: boolean) =>
  riskOf(id) !== undefined && !quake;

/** 洪水キキクルの中小河川の線の層 (段ごとの source に縁と線の 2 つ) */
export const floodLayerIds = (n: number) =>
  [`riskflood-${n}-casing`, `riskflood-${n}`] as const;
/** 洪水キキクルを選んだときに出す川の層 (中小河川の網・指定河川の地図・洪水予報の区間) */
export const RIVER_LAYERS = [
  "river-map-casing",
  "river-map",
  "river-casing",
  "river-line",
  "river-label",
] as const;

/**
 * キキクルの層ごとに出すかどうか。時刻の表をまだ読めていない (`ready` でない) 間は出さない。
 * 格子のもの (土砂・大雨・浸水) は `risk-<ズーム>`、洪水は川の線の層 (docs/map.md の「キキクル」)
 */
export function riskVisibility(
  id: HazardId,
  quake: boolean,
  ready: boolean,
): Record<string, boolean> {
  const on = ready && riskShown(id, quake);
  const river = riskOf(id)?.draw === "river";
  return {
    ...Object.fromEntries(
      RISK_TILE_ZOOMS.map((n) => [`risk-${n}`, on && !river]),
    ),
    ...Object.fromEntries(
      RISK_TILE_ZOOMS.flatMap((n) =>
        floodLayerIds(n).map((l) => [l, on && river]),
      ),
    ),
    ...Object.fromEntries(RIVER_LAYERS.map((l) => [l, on && river])),
  };
}

/** 洪水キキクルの時刻の表を読む前に、出さない層に持たせる仮の URL */
const PLACEHOLDER_FLOOD = `${JMATILE}/risk/19700101000000/none/19700101000000/surf/flood/{z}/{x}/{y}.pbf`;

/** 指定河川の段の色 (段の無いものは水色) */
const riverColor = (calm: string, offset: number): Expr => [
  "match",
  ["get", "level"],
  2 - offset,
  RIVER_LEVEL_COLORS[2],
  3 - offset,
  RIVER_LEVEL_COLORS[3],
  4 - offset,
  RIVER_LEVEL_COLORS[4],
  5 - offset,
  RIVER_LEVEL_COLORS[5],
  calm,
];
/**
 * 指定河川の線の太さ。気象庁の画面は 256px のタイルのズーム L で L − 2 px (地図のズーム z では z − 1)。
 * 縁は線より 2 px 太く引く
 */
const riverWidth = (extra: number): Expr => [
  "interpolate",
  ["linear"],
  ["zoom"],
  4,
  3 + extra,
  14,
  13 + extra,
];
/** 中小河川の線の太さ。気象庁の画面は L が 10 から L − 7 px、それより引くと 2 px (地図のズーム z では 9 から z − 6) */
const smallRiverWidth = (extra: number): Expr => [
  "interpolate",
  ["linear"],
  ["zoom"],
  9,
  2 + extra,
  10,
  4 + extra,
  14,
  8 + extra,
];

/**
 * 中小河川の段ごとの層を出す地図のズーム。MapLibre のベクトルタイルは 512px の扱いで、地図のズーム z では z のタイルを読む
 * (256px のタイルの雨雲とは 1 段ずれる)。そのため、タイルのズーム n の段は地図のズーム n から n + 2 の手前まで。いちばん
 * 引いた段 (4) より引くと線は出ない (気象庁の画面も 256px のズーム 4、地図のズームで 3 からなので、ほぼ同じ)
 */
export function floodLayerZoom(n: number): {
  minzoom?: number;
  maxzoom?: number;
} {
  const last = n === RISK_TILE_ZOOMS.at(-1);
  return { minzoom: n, ...(last ? {} : { maxzoom: n + 2 }) };
}

/**
 * 洪水キキクルの川の層。下から、中小河川の危険度 (段ごとの source)・指定河川の地図 (水色)・洪水予報の区間 (段の色)・
 * 区間の名前。気象庁の画面の重ね順 (zIndex 302・402・601) と同じ。気象庁の画面にある中小河川の網 (水色の PNG。zIndex 101) は、
 * 写真の上では細かい線が一面に広がって危険度の色が読みにくいので描かない (docs/map.md の「キキクル」)
 */
function riverLayers(on: Record<string, boolean>): Record<string, unknown>[] {
  const vis = (id: string) => ({ visibility: on[id] ? "visible" : "none" });
  return [
    ...RISK_TILE_ZOOMS.flatMap((n) => {
      const [casing, line] = floodLayerIds(n);
      const zoom = floodLayerZoom(n);
      return [
        {
          id: casing,
          type: "line",
          source: `riskflood-${n}`,
          "source-layer": "flood",
          ...zoom,
          paint: {
            "line-color": SMALL_RIVER_CASING,
            // 灰色の縁は、気象庁の画面と同じく地図のズーム 7 (L 8) から
            "line-opacity": ["step", ["zoom"], 0, RIVER_MAP_MINZOOM, 1],
            "line-width": smallRiverWidth(2),
          },
          layout: { ...vis(casing), "line-cap": "butt", "line-join": "round" },
        },
        {
          id: line,
          type: "line",
          source: `riskflood-${n}`,
          "source-layer": "flood",
          ...zoom,
          paint: {
            "line-color": riverColor(SMALL_RIVER_CALM_COLOR, 1),
            "line-width": smallRiverWidth(0),
          },
          layout: { ...vis(line), "line-cap": "butt", "line-join": "round" },
        },
      ];
    }),
    {
      id: "river-map-casing",
      type: "line",
      source: "river-map",
      minzoom: RIVER_MAP_MINZOOM,
      paint: { "line-color": RIVER_CASING, "line-width": riverWidth(2) },
      layout: { ...vis("river-map-casing"), "line-join": "round" },
    },
    {
      id: "river-map",
      type: "line",
      source: "river-map",
      minzoom: RIVER_MAP_MINZOOM,
      paint: { "line-color": RIVER_CALM_COLOR, "line-width": riverWidth(0) },
      layout: { ...vis("river-map"), "line-join": "round" },
    },
    {
      id: "river-casing",
      type: "line",
      source: "river",
      filter: ["!=", ["geometry-type"], "Point"],
      paint: {
        "line-color": [
          "case",
          ["==", ["get", "level"], 5],
          RIVER_CASING_SEVERE,
          RIVER_CASING,
        ],
        "line-width": riverWidth(2),
      },
      layout: { ...vis("river-casing"), "line-join": "round" },
    },
    {
      id: "river-line",
      type: "line",
      source: "river",
      filter: ["!=", ["geometry-type"], "Point"],
      paint: {
        "line-color": riverColor(RIVER_CALM_COLOR, 0),
        "line-width": riverWidth(0),
      },
      layout: { ...vis("river-line"), "line-join": "round" },
    },
    {
      // 区間の名前と段は、気象庁の画面と同じく地図のズーム 7 (L 8) から。字は段の色の縁 (注意は黄の字に暗い縁)
      id: "river-label",
      type: "symbol",
      source: "river",
      minzoom: RIVER_MAP_MINZOOM,
      filter: ["==", ["geometry-type"], "Point"],
      layout: {
        ...vis("river-label"),
        // 色だけに頼らないよう、名前に段の言葉 (凡例と同じ) を添える (docs/design.md の 6.2)
        "text-field": [
          "concat",
          ["get", "name"],
          " (",
          [
            "match",
            ["get", "level"],
            2,
            "注意",
            3,
            "警戒",
            4,
            "危険",
            5,
            "災害切迫",
            "",
          ],
          ")",
        ],
        "text-font": ["Noto Sans JP", "sans-serif"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 10, 13, 14, 21],
        // 区間は数えるほどなので、地名と重なっても出す (気象庁の画面も必ず出す)
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": [
          "case",
          ["==", ["get", "level"], 2],
          RIVER_LEVEL_COLORS[2],
          "#ffffff",
        ],
        "text-halo-color": [
          "match",
          ["get", "level"],
          3,
          RIVER_LEVEL_COLORS[3],
          4,
          RIVER_LEVEL_COLORS[4],
          5,
          RIVER_LEVEL_COLORS[5],
          RIVER_CASING,
        ],
        "text-halo-width": 2,
      },
    },
  ];
}

/** 時刻の表を読む前に、出さない層に持たせる仮の URL (MapLibre は出さない層の source を読まない) */
const PLACEHOLDER_TILE = `${JMATILE}/nowc/19700101000000/none/19700101000000/surf/none/{z}/{x}/{y}.png`;
const NOWC_ATTRIBUTION = `<a href="${NOWC_PAGE}" target="_blank" rel="noopener">気象庁 雷・竜巻発生確度ナウキャスト</a> を加工`;
const RASRF_ATTRIBUTION = `<a href="${RASRF_PAGE}" target="_blank" rel="noopener">気象庁 降水短時間予報</a> を加工`;
const SLMCS_ATTRIBUTION = `<a href="${NOWC_PAGE}" target="_blank" rel="noopener">気象庁 線状降水帯の雨域</a> を加工`;

/** 雷・竜巻・今後の雨を写真の上に重ねるときの不透明度 (雨雲と同じ) */
export const NOWC_OPACITY = 0.8;

/**
 * 雷・竜巻・今後の雨を出すか。雨雲と同じく、地震を選んでいる間は隠す。どれも気象庁の配色 (震度の色と同じ赤・橙・黄・紫) で
 * 塗るので、重ねると震度を読み違えるため (docs/map.md の「地震を選んでいる間」)
 */
export const nowcShown = (id: HazardId, quake: boolean) =>
  (id === "rain-forecast" || nowcOf(id) !== undefined) && !quake;

/** 雷・竜巻の層ごとに出すかどうか (`nowc-<ズーム>`。雷と竜巻は URL を替えて同じ source を使う) */
export function nowcVisibility(
  id: HazardId,
  quake: boolean,
  ready: boolean,
): Record<string, boolean> {
  const on = ready && nowcOf(id) !== undefined && nowcShown(id, quake);
  return Object.fromEntries(N3_TILE_ZOOMS.map((n) => [`nowc-${n}`, on]));
}

/** 今後の雨の層ごとに出すかどうか (`rasrf-<ズーム>`) */
export function rasrfVisibility(
  id: HazardId,
  quake: boolean,
  ready: boolean,
): Record<string, boolean> {
  const on = ready && id === "rain-forecast" && nowcShown(id, quake);
  return Object.fromEntries(RASRF_TILE_ZOOMS.map((n) => [`rasrf-${n}`, on]));
}

/**
 * 重ねる図が重なっているか・地震を選んでいるかで、重ねる層の出し入れを決める (隠す層・代わりに出す層)。
 * 重ねる図が重なっている間は `HIDDEN_UNDER_HAZARD` を、地震を選んでいる間は `HIDDEN_UNDER_QUAKE` を
 * 隠し、どちらのときも特別警報の縁取りを出す。雨雲・雨雲 (いま→予測)・キキクル・雷・竜巻・今後の雨は地震を選んでいる間は出さない
 * (`rainShown`・`loopShown`・`riskShown`・`nowcShown`) ので、そのときは地震を選んでいる間の決まりだけになる
 */
export function overlayVisibility(
  id: HazardId,
  /** いまのズーム。ハザードマップのタイルが無いズーム (活断層はズーム 11 未満) では何も重ならないので隠さない */
  zoom = Number.POSITIVE_INFINITY,
  /** 一覧で地震を選んでいるか */
  quake = false,
): Record<string, boolean> {
  const on =
    hazardCovers(id, zoom) ||
    rainShown(id, quake) ||
    loopShown(id, quake) ||
    riskShown(id, quake) ||
    nowcShown(id, quake);
  const hidden = new Set<string>([
    ...(on ? HIDDEN_UNDER_HAZARD : []),
    ...(quake ? HIDDEN_UNDER_QUAKE : []),
  ]);
  return {
    ...Object.fromEntries(
      [...HIDDEN_UNDER_HAZARD, ...HIDDEN_UNDER_QUAKE].map((l) => [
        l,
        !hidden.has(l),
      ]),
    ),
    ...Object.fromEntries(SHOWN_UNDER_HAZARD.map((l) => [l, on || quake])),
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
  raw === "rain" ||
  raw === "rain-loop" ||
  raw === "rain-forecast" ||
  NOWC_KINDS.some((k) => k.id === raw) ||
  RISKS.some((r) => r.id === raw) ||
  HAZARDS.some((h) => h.id === raw)
    ? (raw as HazardId)
    : "none";

/**
 * 指定緊急避難場所 (災害ごとに skhb01〜08) と指定避難所 (一般の sih と福祉避難所の sfh)。地理院タイルの GeoJSON で、ズーム 10 のタイルしか無い。
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
  "sfh",
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
  /** 福祉避難所の受け入れる人 (sfh だけ) */
  accept?: string | null;
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
    /** 福祉避難所でもある (要配慮者のための指定避難所) */
    welfare: boolean;
    /** 福祉避難所の受け入れる人 (市町村が書いたまま。無ければ空) */
    accept: string;
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
            welfare: false,
            accept: "",
          },
        } satisfies ShelterFeature);
      if (layer === "sih") cur.properties.shelter = true;
      else if (layer === "sfh") {
        cur.properties.welfare = true;
        const accept = typeof p.accept === "string" ? p.accept.trim() : "";
        if (accept && !cur.properties.accept) cur.properties.accept = accept;
      } else
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
 * 地図の見方 (「出典と注意」の窓に出す)。いつも出す層と、右下の「重ねる」で選ぶ図 (docs/map.md)。
 * 色の意味は地図の上には書かないので、ここに言葉で書く
 */
export const MAP_LEGEND: { label: string; note: string }[] = [
  {
    label: "各地の震度",
    note: "一覧で選んだ地震の、地域ごとの震度の色と数字。何も選んでいないときは出しません",
  },
  {
    label: "観測点ごとの震度",
    note: "一覧で選んだ地震の、震度観測点ごとの震度の色の丸 (大きい震度が上)。電文に並んだ観測点だけを置き、観測点の間の震度を補ったり推し量ったりはしていません。寄せると丸が大きくなり、地域の塗りは薄くなります。丸を押すと、観測点の名前・震度・都道府県と市町村・設置者 (気象庁・地方公共団体・防災科学技術研究所) が出ます。位置の分からない観測点は出さず、詳しい内容にその数を書きます",
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
    note: "津波予報区の海岸の線を区分の色で引きます。大津波警報は紫の太い線、津波警報は赤、津波注意報は黄、津波予報 (若干の海面変動) は青い細い線です",
  },
  {
    label: "緊急地震速報",
    note: "出ている間の震央の × と、警報の出た地域 (赤く塗って縁取ります)",
  },
  {
    label: "気象警報・注意報",
    note: "市町村等を段の色で塗ります。特別警報 黒・危険警報 紫・警報 赤・注意報 黄 (気象庁の配色)。塗った所を押すと、市町村の名前と出ている警報・注意報が出ます。一覧で府県予報区の警報・注意報を選ぶと、その府県予報区の市町村等を白い線で縁取ります。地震を選んでいる間は、震度の色と重ならないよう塗りを隠します (特別警報は縁取りで出します)",
  },
  {
    label: "台風",
    note: "気象庁の台風解析・予報情報の図の決まりのまま描きます。予報円は白の破線 (台風の中心が 70% の確率で入る範囲)、予報円の中心を結ぶ線は白の細い破線、暴風警戒域は赤の実線、いまの暴風域は赤の太い実線、強風域は黄の実線です。青い線と点は、これまでの経路 (sonae が受けた報の実況の中心を時刻の順につないだもの) です。sonae が報を受けていなかった間 (6 時間を超えて空いた所) は線を引かずに空けます。赤い丸がいまの中心で、丸と予報円の中心を押すと、中心気圧・最大風速と予報の時刻が出ます。台風が無いときと、12 時間より新しい報が無いときは描きません",
  },
  {
    label: "台湾の観測点の揺れ (非公式)",
    note: "ExpTech の観測網 TREM-net の台湾の観測点。ふだんは小さな灰色の点で、地震の間だけ、揺れた観測点をいまの揺れ (計測震度) に当たる震度の色で塗ります。中央氣象署の発表ではない非公式の値で、地図に出すだけです。一覧・音・読み上げ・通知では知らせません。中央氣象署の発表を優先してください",
  },
  {
    label: "有志の観測点の揺れ (非公式)",
    note: "Wolfx Project の SeisJS に参加している有志の観測点。数と場所は参加する人しだいで変わり、日本に 1 か所も無いこともあります。値は観測点が計算した計測震度で、0.5 以上なら震度の色で塗り、それ未満は灰色の点です。気象庁や各国の機関の発表ではない非公式の値で、地図に出すだけです。一覧・音・読み上げ・通知では知らせません",
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
    note: "噴火警戒レベル 2 以上の火山と、選んだ情報の火山の三角。中の数字はレベルです。レベルが分からない火山は灰色の三角で、右に種類の名前 (噴火速報は「噴火速報」) を出します",
  },
  {
    label: "降灰予報の範囲",
    note: "一覧で降灰予報を選んだときだけ、気象庁の予報の範囲を気象庁の地図と同じ色で塗ります。灰色は降灰 (少量)、黄はやや多量、赤は多量、白地に赤の縞は小さな噴石の落下範囲です。いつの予想かは右下に出し、‹ › で時刻の区切りを動かせます。定時の降灰予報は噴火した場合の予想で、いま降っている所ではありません。選んでいる間は、色がぶつかる警報・注意報の塗りを隠します",
  },
  {
    label: "海底地殻変動観測点・海域火山 (海しる)",
    note: "海上保安庁の海しるから取った点です。水色のひし形は海底地殻変動観測点 (GNSS-A。海底の動きを測る所)、黒い縁の白い三角の輪郭は海域火山データベースの火山です。押すと、名前と設置水深・標高などが出ます。サーバーが 1 日 1 回取り直します。海しるの API のキーが無いサーバーでは出ません。三角の輪郭は火山の警戒の段とは関係がありません (噴火警報・予報の火山は、色で塗った三角です)",
  },
  {
    label: "海上保安部署・潮汐推算の地点 (海しる)",
    note: `白い縁の紺の丸に「海」は海上保安部署等 (ズーム ${OFFICE_MINZOOM} から)、黒い縁の白い丸に「潮」は潮汐推算の地点 (ズーム ${TIDE_MINZOOM} から) です。海上保安部署を押すと所在地と電話番号が、潮汐推算の地点を押すと今日の推算の潮位 (満潮・干潮の時刻と高さ、1 日の図) が出ます。推算の潮位は月と太陽の動きから計算した値で、津波や高潮の観測ではありません。海しるの API のキーが無いサーバーでは出ません`,
  },
  {
    label: "火山の監視カメラ",
    note: `白い縁の暗い四角に白いカメラの形。気象庁が火山を見ているカメラの位置です (ズーム ${CAMERA_MINZOOM} から出します)。押すと、気象庁ホームページのいちばん新しい画像が出ます。画像は 2〜3 分ごとに替わりますが、気象庁の配信で 10 分ほど遅れることがあり、吹き出しを開いている間は 10 分ごとに読み直します。位置はおおよそで、どの向きを撮っているかは火山の活動で変わります`,
  },
  {
    label: "YouTube のライブカメラ",
    note: `白い縁の暗い四角に白い再生の三角。国や自治体が YouTube で流している、川と港のライブカメラの位置です (ズーム ${CAMERA_MINZOOM} から出します)。押すと、吹き出しで YouTube のプレーヤーが音を消して再生します。配信中かはサーバーが 5 分ごとに確かめ、配信していないときは再生しません。YouTube の API のキーが無いサーバーでは、YouTube のページへのリンクだけを出します`,
  },
  {
    label: "通行止め (災害)",
    note: "白い縁の赤い太い線。国土交通省が災害ごとに出す「通れるマップ」の道路規制情報のうち、いま全面通行止めの区間です。押すと、路線名・区間・規制の内容と理由・更新の時刻が出ます。国土交通省 道路局のページで見つけた災害 (と、サーバーの管理者が登録した URL) の分を出します (30 分ごとに取り直します)。ここに無くても通れるとは限りません",
  },
  {
    label: "通れた道 (目安)",
    note: `細い線。通れるマップの ETC2.0 の平均速度で、車が通った道の目安です。橙は時速 20 km 以下、水色は 21 km 以上。線は車の記録の点を直線でつないだもので、道路の形ではありません。道路から数百 m ずれて、野原や山の上を通る所があります (国土交通省の地図でも同じ線です)。ずれが目立つので、寄せるほど薄くし、大きく寄せたとき (ズーム ${ROAD_SPEED_MAXZOOM} 以上) は隠します。いま通れるとは限らず、工事の車のこともあります。重ねる図のどれかを選んでいる間も隠します`,
  },
  {
    label: "道路・地名・施設の記号",
    note: "国土地理院の地理院地図Vector。寄せるほど細い道と小さな地名まで出ます。高速道路は橙・国道は黄・ほかの道は白",
  },
  {
    label: "指定緊急避難場所・指定避難所",
    note: "大きく寄せたとき (ズーム 14 以上) だけ、緑の「避」の印で出します。福祉避難所 (高齢の人や障がいのある人など、配慮の要る人のための指定避難所) は、白地に緑の「福」の印です。押すと、どの災害に対応する指定緊急避難場所か、指定避難所か、福祉避難所なら受け入れる人が出ます。国土地理院のデータで最新でないことや載っていない施設があるので、避難先は市町村の情報で確かめてください。指定緊急避難場所は災害のときに逃げる場所 (災害の種類ごと)、指定避難所は家に戻れないときに過ごす場所です。福祉避難所は受け入れる人が決まっているので、行く前に市町村の情報で確かめてください",
  },
  {
    label: "ハザードマップ",
    note:
      "地図の右下の「重ねる」で、雨雲・キキクルなどと一緒に 1 つを選べます。見出し「ハザードマップ (水害・土砂災害)」は、ハザードマップポータルサイトの洪水 (浸水の深さ。凡例の上で、浸水が続く時間と家屋倒壊等氾濫想定区域に切り替えられます)・内水・高潮・津波 (どれも想定最大規模などの浸水想定)・土砂災害 (警戒区域) です。色の意味は選んだときに出る公式の凡例のとおりです。想定の無い川や地域は塗られていないので、色が無くても安全とは限りません。" +
      "選んでいる間は、色がぶつからないよう、気象警報・注意報の塗りと縁取り・震度の塗り (数字のラベルは残ります)・緊急地震速報の地域の塗り・通れた道 (目安) の線を隠します。いま出ている特別警報の市町村等は白い縁の黒い線で縁取り、緊急地震速報の地域は赤い縁取りで、津波の警報・注意報の線もそのまま残します。「なし」に戻すと元に戻ります",
  },
  {
    label: "雨雲",
    note:
      "地図の右下で「雨雲 (いま)」を選んだときだけ、気象庁の高解像度降水ナウキャストの、いまの降水強度 (mm/h) を重ねます。色は気象庁の配色で、凡例と、いつの観測か (5 分ごとに更新) を地図の右下に出します。15 分より古い雨雲しか取れていないときは、凡例にそう書きます。雨雲の 1 時間先までの予測は出さず、先の雨は「今後の雨 (予測)」で見ます。" +
      "選んでいる間は、色がぶつからないよう、ハザードマップと同じく気象警報・注意報の塗り・緊急地震速報の地域の塗り・通れた道 (目安) の線を隠し、特別警報と緊急地震速報は縁取りで残します。雨雲の色は震度の色と同じ色を使うので、地震を選んでいる間は雨雲を隠します",
  },
  {
    label: "キキクル",
    note:
      "地図の右下で「キキクル」の土砂・大雨・浸水・洪水のどれかを選んだときだけ、気象庁のキキクル (危険度分布) を重ねます。土砂は土砂災害の、大雨は低地の浸水と中小河川の氾濫を重ねた、浸水は低地の浸水の危険度で、気象庁が雨の実況と予測から判定したものです。洪水は格子を塗らず、川の線を危険度の色で引きます (中小河川は灰色の縁の細い線、国や都道府県が洪水予報をする指定河川は黒い縁の太い線と区間の名前。水色の線は「今後の情報等に留意」)。" +
      "色は気象庁の配色のままで、黒は災害切迫 (警戒レベル 5 相当)、紫は危険 (4 相当)、赤は警戒 (3 相当)、黄は注意 (2 相当) です。いちばん低い「今後の情報等に留意」は塗りません。凡例と、いつの判定か (10 分ごとに更新) を地図の右下に出し、40 分より古いものしか取れていないときは凡例にそう書きます。" +
      "指定河川の洪水予報の中身は、一覧の「気象」の指定河川洪水予報で読めます。選んでいる間は雨雲と同じく、気象警報・注意報の塗り・緊急地震速報の地域の塗り・通れた道 (目安) の線を隠し、地震を選んでいる間はキキクルを隠します",
  },
  {
    label: "今後の雨 (予測)",
    note: "地図の右下で「今後の雨 (予測)」を選んだときだけ、気象庁の降水短時間予報の 1 時間の雨量の予測を重ねます。凡例に「◯時◯分までの予測」を大きく出し、その下に何時間先かを出し、‹ › で先の時刻へ動かせます (自動では動きません)。色は気象庁の配色のままで、sonae が先の雨を予想することはしません。雨雲と同じく、選んでいる間は気象警報・注意報の塗り・緊急地震速報の地域の塗り・通れた道 (目安) の線を隠し、地震を選んでいる間は今後の雨を隠します",
  },
  {
    label: "雷・竜巻",
    note: "地図の右下で「雷 (いま)」か「竜巻 (いま)」を選んだときだけ、気象庁の雷ナウキャスト (雷活動度 1〜4) か竜巻発生確度ナウキャスト (確度 1・2) の、いまの解析を重ねます。色は気象庁の配色のままです。凡例と、いつの解析か (10 分ごとに更新) を地図の右下に出します。雨雲と同じく、選んでいる間は気象警報・注意報の塗り・緊急地震速報の地域の塗り・通れた道 (目安) の線を隠し、地震を選んでいる間は雷・竜巻を隠します",
  },
  {
    label: "線状降水帯",
    note: "気象庁が線状降水帯の雨域を解析している間だけ、その範囲を白い縁の赤い線で囲み、地図の右下にいつの解析かを出します。重ねる図や地震の選択にかかわらず出します。出ていないときは何も描きません",
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
    note: "都市圏活断層図。地形の分類で塗った全面の図なので、いつもは重ねず、地図の右下の「重ねる」の見出し「地震の備え」で「活断層」を選んだときだけ出します。大きく寄せたとき (ズーム 11 以上) だけ出ます",
  },
  {
    label: "地震の揺れの確率・地盤の揺れやすさ",
    note: "防災科研の J-SHIS の図。地図の右下の「重ねる」の見出し「地震の備え」で選んだときだけ出します。「揺れの確率 (30 年)」は今後 30 年に震度 6 弱以上の揺れに見舞われる確率 (2024 年版)、「地盤の揺れやすさ」は表層地盤で揺れが何倍になるかの目安 (地盤増幅率) です。どちらも評価にもとづく計算で、誤差を含みます。確率が低い所でも、強い揺れに見舞われないとは限りません。選んでいる間は、ハザードマップと同じく面で塗る色を隠します",
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
  /**
   * 段が分からないときに、三角の横に出す字 (色だけに頼らない。docs/design.md の 6.2)。
   * 噴火速報は「噴火速報」、ほかは種類の名前。段があれば無し (三角の中の数字で書く)
   */
  label?: string;
  /** 字の地の色の段。噴火速報は一覧と同じくいちばん重い色 (5)、ほかは無し (灰色) */
  labelLevel?: number;
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
      // 噴火速報には段が無いので、いまの段を残す
      const level = a.level ?? prev?.level;
      out.set(a.code, {
        code: a.code,
        name: a.name,
        at,
        level,
        label:
          level !== undefined
            ? undefined
            : v.code === "VFVO56"
              ? "噴火速報"
              : volcanoKindText(a.kind) || "火山",
        labelLevel: level === undefined && v.code === "VFVO56" ? 5 : undefined,
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
  /** 雨雲のいまの 1 枚。まだ時刻の表を読んでいなければ null (雨雲の層は出さない) */
  rain: RainFrame | null = null,
  /** キキクルのいまの 1 枚。まだ時刻の表を読んでいなければ null (キキクルの層は出さない) */
  risk: RiskFrame | null = null,
): Record<string, unknown> {
  const hazardShown = hazardVisibility(hazard);
  const overlay = overlayVisibility(hazard);
  const rainOn = rainVisibility(hazard, false, rain !== null);
  const riskOn = riskVisibility(hazard, false, risk !== null);
  const gridRisk = riskOf(hazard);
  // 時刻が分かるまでは、出さない層に仮の URL を持たせる (MapLibre は出さない層の source を読まない)
  const rainUrl = rainTiles(
    rain ?? { basetime: "19700101000000", validtime: "19700101000000" },
  );
  const riskUrl = riskTiles(
    risk ?? {
      basetime: "19700101000000",
      validtime: "19700101000000",
      member: "none",
    },
    gridRisk?.draw === "grid" ? gridRisk.element : "land",
  );
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
              tileSize: h.tileSize ?? 256,
              minzoom: h.minzoom,
              maxzoom: h.fetchMaxzoom ?? h.maxzoom,
              ...(i === 0 ? { attribution: h.attribution } : {}),
            },
          ]),
        ),
      ),
      // 雨雲。タイルは偶数のズームにしか無いので、段ごとに source を分け、その段のズームだけを読む
      ...Object.fromEntries(
        RAIN_TILE_ZOOMS.map((n, i) => [
          `rain-${n}`,
          {
            type: "raster",
            tiles: [rainUrl],
            tileSize: 256,
            minzoom: n,
            maxzoom: n,
            ...(i === 0 ? { attribution: RAIN_ATTRIBUTION } : {}),
          },
        ]),
      ),
      // キキクル。雨雲と同じく偶数のズームにしか無いので、段ごとに source を分ける。土砂と大雨は URL を替えて同じ source を使う
      ...Object.fromEntries(
        RISK_TILE_ZOOMS.map((n, i) => [
          `risk-${n}`,
          {
            type: "raster",
            tiles: [riskUrl],
            tileSize: 256,
            minzoom: n,
            maxzoom: n,
            ...(i === 0 ? { attribution: RISK_ATTRIBUTION } : {}),
          },
        ]),
      ),
      // 洪水キキクル (選んだときだけ)。中小河川の危険度はベクトルタイルで、偶数のズームにしか無いので段ごとに source を分ける。
      // URL は時刻の表を読んでから差し替える
      ...Object.fromEntries(
        RISK_TILE_ZOOMS.map((n) => [
          `riskflood-${n}`,
          {
            type: "vector",
            tiles: [PLACEHOLDER_FLOOD],
            minzoom: n,
            maxzoom: n,
          },
        ]),
      ),
      // 指定河川の地図 (水色の線。変わらない)。洪水を選んだときに画面が URL を入れる
      "river-map": {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
      // 洪水予報の出ている指定河川の区間 (段のあるもの)。画面が時刻ごとに読んで差し込む (`#lib/map/risk.ts` の `riverFeatures`)
      river: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
      // 雷・竜巻 (選んだときだけ)。偶数のズームの 4〜8 にしか無いので、段ごとに source を分ける。URL は時刻の表を読んでから差し替える
      ...Object.fromEntries(
        N3_TILE_ZOOMS.map((n, i) => [
          `nowc-${n}`,
          {
            type: "raster",
            tiles: [PLACEHOLDER_TILE],
            tileSize: 256,
            minzoom: n,
            maxzoom: n,
            ...(i === 0 ? { attribution: NOWC_ATTRIBUTION } : {}),
          },
        ]),
      ),
      // 今後の雨 (選んだときだけ)。雨雲と同じく偶数のズームの 4〜10
      ...Object.fromEntries(
        RASRF_TILE_ZOOMS.map((n, i) => [
          `rasrf-${n}`,
          {
            type: "raster",
            tiles: [PLACEHOLDER_TILE],
            tileSize: 256,
            minzoom: n,
            maxzoom: n,
            ...(i === 0 ? { attribution: RASRF_ATTRIBUTION } : {}),
          },
        ]),
      ),
      // 雨雲 (いま→予測。選んだときだけ)。枚ごとに source を分け (0 がいまの観測、1〜3 が予測)、段は雨雲と同じ 4〜10。
      // URL は時刻の表を読んでから差し替える
      ...Object.fromEntries(
        LOOP_SLOTS.flatMap((s) =>
          RAIN_TILE_ZOOMS.map((n) => [
            loopLayerId(s, n),
            {
              type: "raster",
              tiles: [PLACEHOLDER_TILE],
              tileSize: 256,
              minzoom: n,
              maxzoom: n,
            },
          ]),
        ),
      ),
      // 線状降水帯の雨域 (出ている間だけ線が入る)。画面が時刻の表と GeoJSON を読んで差し込む (`#lib/map/nowc.ts`)
      slmcs: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        attribution: SLMCS_ATTRIBUTION,
      },
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
      // 災害時の通行止めと通れた道 (目安)。画面が /api/roads から読んで差し込む (`#lib/map/roads.ts`)
      roads: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        attribution: ROADS_ATTRIBUTION,
      },
      // 海しるの点 (海底地殻変動観測点・海域火山)。画面が /api/marine から読んで差し込む (`#lib/map/marine.ts`)
      marine: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        attribution: MARINE_ATTRIBUTION,
      },
      // 気象庁の火山の監視カメラの位置。画面が /cameras/volcano-cameras.json を読んで差し込む (`#lib/map/cameras.ts`)
      cameras: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        attribution: CAMERAS_ATTRIBUTION,
      },
      // YouTube のライブカメラの位置。表 (`#lib/map/livecams.ts` の LIVECAMS) から作る
      livecams: {
        type: "geojson",
        data: livecamFeatures(),
        attribution: LIVECAMS_ATTRIBUTION,
      },
      hypocenters: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
      // 選んだ地震の観測点ごとの震度 (`#lib/map/stations.ts` の `stationFeatures`)
      stations: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        attribution: STATIONS_ATTRIBUTION,
      },
      me: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
      // 選んだ降灰予報の範囲 (`#lib/map/ash.ts`)
      ...ashSources(),
      // 台風の予報円・暴風警戒域と中心 (`#lib/map/typhoon.ts`)
      ...typhoonSources(),
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
      // 雨雲 (選んだときだけ。ハザードマップと同じ所に、透かして重ねる)。段ごとに、その段のタイルが合うズームだけ出す。
      // 色は凡例の 8 色だけなので、間の色を作らないよう引き伸ばしても混ぜない (nearest)。差し替えで動きを付けない
      ...RAIN_TILE_ZOOMS.map((n) => ({
        id: `rain-${n}`,
        type: "raster",
        source: `rain-${n}`,
        ...rainLayerZoom(n),
        paint: {
          "raster-opacity": RAIN_OPACITY,
          "raster-resampling": "nearest",
          "raster-fade-duration": 0,
        },
        layout: { visibility: rainOn[`rain-${n}`] ? "visible" : "none" },
      })),
      // キキクル (選んだときだけ。雨雲と同じ所・同じ出し方)。色は凡例の 4 色だけなので、引き伸ばしても混ぜない
      ...RISK_TILE_ZOOMS.map((n) => ({
        id: `risk-${n}`,
        type: "raster",
        source: `risk-${n}`,
        ...rainLayerZoom(n),
        paint: {
          "raster-opacity": RISK_OPACITY,
          "raster-resampling": "nearest",
          "raster-fade-duration": 0,
        },
        layout: { visibility: riskOn[`risk-${n}`] ? "visible" : "none" },
      })),
      // 洪水キキクル (選んだときだけ。キキクルと同じ所)。気象庁の画面と同じ重ね方で、下から中小河川の危険度・
      // 指定河川の地図・洪水予報の区間・区間の名前。色・縁・太さは気象庁の画面の設定のまま (docs/map.md の「キキクル」)
      ...riverLayers(riskOn),
      // 雷・竜巻と今後の雨 (選んだときだけ。雨雲と同じ所・同じ出し方)。出し入れは画面が時刻の表を読んでから決める
      ...N3_TILE_ZOOMS.map((n) => ({
        id: `nowc-${n}`,
        type: "raster",
        source: `nowc-${n}`,
        ...stepLayerZoom(n, N3_TILE_ZOOMS),
        paint: {
          "raster-opacity": NOWC_OPACITY,
          "raster-resampling": "nearest",
          "raster-fade-duration": 0,
        },
        layout: { visibility: "none" },
      })),
      ...RASRF_TILE_ZOOMS.map((n) => ({
        id: `rasrf-${n}`,
        type: "raster",
        source: `rasrf-${n}`,
        ...stepLayerZoom(n, RASRF_TILE_ZOOMS),
        paint: {
          "raster-opacity": NOWC_OPACITY,
          "raster-resampling": "nearest",
          "raster-fade-duration": 0,
        },
        layout: { visibility: "none" },
      })),
      // 雨雲 (いま→予測。選んだときだけ)。読めた枚は全部出してタイルを持ち、見せる枚だけ透明度を上げる (画面が替える)。
      // 枚を替えるときに透かしの移り変わりを付けない (MapLibre が描き続けないよう、移り変わりの時間を 0 にする)
      ...LOOP_SLOTS.flatMap((s) =>
        RAIN_TILE_ZOOMS.map((n) => ({
          id: loopLayerId(s, n),
          type: "raster",
          source: loopLayerId(s, n),
          ...rainLayerZoom(n),
          paint: {
            "raster-opacity": loopOpacity(s, 0),
            "raster-opacity-transition": { duration: 0, delay: 0 },
            "raster-resampling": "nearest",
            "raster-fade-duration": 0,
          },
          layout: { visibility: "none" },
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
        paint: {
          "fill-color": TRANSPARENT,
          "fill-opacity": QUAKE_FILL_OPACITY,
        },
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
      // 選んだ降灰予報の範囲 (`#lib/map/ash.ts`)。警報・注意報と震度の塗りの上、津波の線と特別警報の縁取りの下
      ...ashLayers(),
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
      // 台風の予報円・暴風警戒域・暴風域・強風域の線 (塗らない。警報・注意報の塗りの上、道路と震源の丸の下)
      ...typhoonLineLayers(),
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
      // 線状降水帯の雨域 (出ている間だけ)。気象庁の画面と同じ白い縁の赤い線。警報の面の上、震源の丸の下に置き、
      // 重ねる図・地震の選択にかかわらずいつも出す (線なので面の色を隠さない。docs/map.md の「線状降水帯」)
      {
        id: "slmcs-casing",
        type: "line",
        source: "slmcs",
        layout: { "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": 6 },
      },
      {
        id: "slmcs-line",
        type: "line",
        source: "slmcs",
        layout: { "line-join": "round" },
        paint: { "line-color": SLMCS_COLOR, "line-width": 3 },
      },
      // 台湾の観測点のいまの揺れ (TREM-RTS)。見た目は下の stationLayer
      stationLayer("rts"),
      // 有志の観測点のいまの揺れ (Wolfx SeisJS)。見た目は台湾の観測点と同じ
      stationLayer("seis"),
      // 震源の丸 (新しい 50 件。押すとその地震を選ぶ)。通行止めと通れた道の線・海しるの点の下に置く。
      // 大きく透けた丸の上に細い線と小さな点を描くと、両方が見えて押し分けられる (docs/map.md の「押せる所が重なったとき」)
      {
        id: "hypocenters",
        type: "circle",
        source: "hypocenters",
        paint: {
          "circle-radius": radiusExpr(HYPO_RADIUS),
          "circle-color": depthColorExpr(),
          "circle-opacity": 0.8,
          "circle-stroke-color": "rgba(0,0,0,0.6)",
          "circle-stroke-width": 1,
        },
        layout: { "circle-sort-key": ["get", "order"] },
      },
      // 海外の地震の丸 (白い縁。押すとその地震を選ぶ)
      {
        id: "foreign",
        type: "circle",
        source: "foreign",
        paint: {
          "circle-radius": radiusExpr(FOREIGN_RADIUS),
          "circle-color": depthColorExpr(),
          "circle-opacity": 0.55,
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 1.5,
        },
        layout: { "circle-sort-key": ["get", "order"] },
      },
      // 通れた道 (目安)。ETC2.0 の平均速度の細い線。時速 20 km 以下は橙、21 km 以上は水色 (通れるマップの凡例の色の向き)。
      // 線は道路から数百 m ずれる所があるので、寄せるほど薄くし、ROAD_SPEED_MAXZOOM から上では描かない
      {
        id: "road-speed",
        type: "line",
        source: "roads",
        maxzoom: ROAD_SPEED_MAXZOOM,
        filter: ["==", ["get", "kind"], "speed"],
        layout: {
          "line-cap": "round",
          "line-join": "round",
          ...vis("road-speed"),
        },
        paint: {
          "line-color": [
            "case",
            ["get", "slow"],
            ROAD_SLOW_COLOR,
            ROAD_FAST_COLOR,
          ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 1.5],
          "line-opacity": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            0.85,
            ROAD_SPEED_MAXZOOM,
            0.45,
          ],
        },
      },
      // 通行止め (災害)。白い縁の上に赤の太い線。面の赤 (震度・警報) と見分けられるよう、縁を付けて線で引く
      {
        id: "road-closed-casing",
        type: "line",
        source: "roads",
        filter: ["==", ["get", "kind"], "closed"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            6,
            4,
            10,
            7,
            14,
            11,
          ],
        },
      },
      {
        id: "road-closed",
        type: "line",
        source: "roads",
        filter: ["==", ["get", "kind"], "closed"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ROAD_CLOSED_COLOR,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            6,
            2.5,
            10,
            4.5,
            14,
            7,
          ],
        },
      },
      // 台風の実況の中心と予報円の中心 (押すと吹き出し)。通行止めの線の上、海しるの点の下
      ...typhoonPointLayers(),
      // 海しるの海上保安部署等 (白い縁の紺の丸に「海」) と潮汐推算の地点 (黒い縁の白い丸に「潮」)。いつも出し、押すと
      // 吹き出し。港ごとに詰まって並ぶので、寄せたときだけ出す (`OFFICE_MINZOOM`・`TIDE_MINZOOM`)。海しるのほかの点の下
      ...(
        [
          ["marine-office", "office", OFFICE_MINZOOM],
          ["marine-tide", "tide", TIDE_MINZOOM],
        ] as const
      ).map(([id, kind, minzoom]): Record<string, unknown> => ({
        id,
        type: "symbol",
        source: "marine",
        minzoom,
        filter: ["==", ["get", "kind"], kind],
        layout: {
          "icon-image": id,
          "icon-allow-overlap": true,
          "icon-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            minzoom,
            0.85,
            12,
            1,
          ],
        },
      })),
      // 海しるの点 (海底地殻変動観測点は水色のひし形、海域火山は黒い縁の白い三角の輪郭)。いつも出し、押すと吹き出し。
      // 震源の丸と観測点の揺れの上 (小さな点なので、大きく透けた丸の下に隠れないように)。観測点ごとの震度の丸の下
      {
        id: "marine",
        type: "symbol",
        source: "marine",
        filter: ["in", ["get", "kind"], ["literal", ["gnssa", "volcano"]]],
        layout: {
          "icon-image": [
            "match",
            ["get", "kind"],
            "gnssa",
            "marine-gnssa",
            "marine-volcano",
          ],
          "icon-allow-overlap": true,
          "icon-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            4,
            0.9,
            8,
            1.2,
            12,
            1.5,
          ],
        },
      },
      // 火山の監視カメラ (白い縁の暗い角丸の四角に白いカメラの形)。いつも出し、押すと吹き出しに気象庁の画像。
      // 引いた縮尺では火山の印と重なって読めないので、ズーム 7 から出す (`CAMERA_MINZOOM`)。海しるの点の上、観測点ごとの震度の丸の下
      {
        id: "cameras",
        type: "symbol",
        source: "cameras",
        minzoom: CAMERA_MINZOOM,
        layout: {
          "icon-image": "camera",
          "icon-allow-overlap": true,
          "icon-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            7,
            1,
            10,
            1.25,
            13,
            1.5,
          ],
        },
      },
      // YouTube のライブカメラ (火山の監視カメラと同じ地に、白い再生の三角)。いつも出し、押すと吹き出しにプレーヤー。
      // 火山の監視カメラと同じく、ズーム 7 から (`CAMERA_MINZOOM`)
      {
        id: "livecams",
        type: "symbol",
        source: "livecams",
        minzoom: CAMERA_MINZOOM,
        layout: {
          "icon-image": "livecam",
          "icon-allow-overlap": true,
          "icon-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            7,
            1,
            10,
            1.25,
            13,
            1.5,
          ],
        },
      },
      // 観測点ごとの震度 (選んだ地震だけ)。気象庁の地図と同じく震度の色の丸で、大きい震度を上に描く。
      // 震源の丸より上 (選んだ地震の中身なので)。震度 1 の白い丸も写真の上で見えるよう、黒い細い縁を付ける
      {
        id: "intensity-stations",
        type: "circle",
        source: "stations",
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            4,
            2.5,
            7,
            4,
            10,
            7,
            13,
            9,
          ],
          "circle-color": ["get", "color"],
          "circle-stroke-color": "rgba(0,0,0,0.65)",
          "circle-stroke-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            4,
            0.5,
            10,
            1,
          ],
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
          // 福祉避難所は「福」の印で、ほかの避難所 (「避」) と見分ける (docs/map.md)
          "icon-image": [
            "case",
            ["get", "welfare"],
            "shelter-welfare",
            "shelter",
          ],
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
