/**
 * 災害時の通行止め (国土交通省が災害ごとに出す「通れるマップ」などの GeoJSON。docs/design.md の 2.12)。
 * サーバーが 30 分ごとに取って DB に置き (`#lib/server/sources/roads.ts`)、画面は `/api/roads` から読む。
 *
 * ここは画面とサーバーの両方から読む。線の properties の形と、吹き出しの中身を組む所
 */

/** `closed` は全面通行止め、`speed` は ETC2.0 の平均速度 (通れた道の目安) */
type RoadKind = "closed" | "speed";

export interface RoadLine {
  kind: RoadKind;
  /** 通行止め: 路線名 (「南九州自動車道」)。無ければ道路種別 */
  route?: string;
  /** 通行止め: 区間 (「八代JCT〜八代南IC」・「八代市宮地町〜八代市泉町」) */
  section?: string;
  /** 通行止め: 規制の内容 (「全面通行止め」) */
  rule?: string;
  /** 通行止め: 規制の理由 (「落石」) */
  reason?: string;
  /** 通行止め: 規制を始めた時刻 (元の書き方のまま。「2026/7/28 19:00」) */
  since?: string;
  /** 通行止め: 延長 (km) */
  lengthKm?: number;
  /** 速度: 平均速度が時速 20 km 以下か */
  slow?: boolean;
  /** 元のファイルの更新の時刻 (応答の Last-Modified。無ければ取った時刻。ISO 8601) */
  updated: string;
}

export interface RoadFeature {
  type: "Feature";
  properties: RoadLine;
  geometry:
    | { type: "LineString"; coordinates: [number, number][] }
    | { type: "MultiLineString"; coordinates: [number, number][][] };
}

export interface RoadCollection {
  type: "FeatureCollection";
  features: RoadFeature[];
}

/** `/api/roads` の答え。自動で見つけた災害も、登録した URL も無ければ `enabled` が false で線は空 */
export interface RoadResponse {
  enabled: boolean;
  data: RoadCollection;
}

export const ROADS_URL = "/api/roads";
/** 画面が読み直す間隔 (サーバーは 30 分ごとに取る) */
export const ROADS_REFRESH_MS = 10 * 60_000;

/** 通れるマップの一覧 (国土交通省 道路局の災害情報) */
export const MLIT_ROAD_DISASTER =
  "https://www.mlit.go.jp/road/road_fr4_000201.html";

/**
 * 入れない (有料・転載禁止の) 道路交通の情報。リンクだけを置く (docs/design.md の 2.12)
 */
export const ROAD_LINKS: { text: string; href: string }[] = [
  {
    text: "道路情報提供システム (国土交通省)",
    href: "https://www.road-info-prvs.mlit.go.jp/roadinfo/pc/",
  },
  {
    text: "日本道路交通情報センター (JARTIC)",
    href: "https://www.jartic.or.jp/",
  },
  {
    text: "NEXCO 東日本 (ドラぷら)",
    href: "https://www.driveplaza.com/traffic/",
  },
  {
    text: "NEXCO 中日本 (アイハイウェイ中日本)",
    href: "https://www.c-ihighway.jp/",
  },
  { text: "NEXCO 西日本 (アイハイウェイ)", href: "https://ihighway.jp/" },
];

/** 吹き出しの 1 行 (`#lib/map/marine.ts` と同じ形) */
export interface PopupLine {
  text: string;
  cls?: string;
  href?: string;
}

/** ISO 8601 を日本の時刻の「2026/11/20 23:30」に */
export function jstShort(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t + 9 * 60 * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 押した線の吹き出しの中身 (上から)。通行止めは路線名・区間・規制の内容と理由・始めた時刻・延長・更新の時刻・出典、
 * 通れた道は平均速度の区分・道路の形ではないこと・更新の時刻・出典。文は DOM で組み、HTML として読まない
 */
export function roadPopup(p: RoadLine): PopupLine[] {
  const updated = {
    text: `${jstShort(p.updated)} 更新 (国土交通省)`,
    cls: "small muted",
  };
  const credit = {
    text: "出典：国土交通省「通れるマップ」を加工して作成",
    cls: "tiny muted",
  };
  if (p.kind === "speed")
    return [
      { text: "通れた道 (目安)", cls: "bold" },
      {
        text: p.slow
          ? "ETC2.0 の平均速度が時速 20 km 以下"
          : "ETC2.0 の平均速度が時速 21 km 以上",
        cls: "small",
      },
      {
        text: "車の記録の点を直線でつないだ目安の線で、道路の形ではありません。道路から数百 m ずれる所があります",
        cls: "tiny muted",
      },
      {
        text: "車が通った記録で、いま通れるとは限りません。工事の車のこともあります",
        cls: "tiny muted",
      },
      updated,
      credit,
    ];
  const lines: PopupLine[] = [
    { text: p.route ?? "道路", cls: "bold" },
    { text: `通行止め (災害)・${p.rule ?? "全面通行止め"}`, cls: "small" },
  ];
  if (p.section) lines.push({ text: p.section, cls: "small muted" });
  const why = [
    p.reason ? `理由: ${p.reason}` : "",
    p.since ? `${p.since} から` : "",
    p.lengthKm !== undefined ? `延長 ${p.lengthKm} km` : "",
  ].filter(Boolean);
  if (why.length > 0) lines.push({ text: why.join("・"), cls: "small muted" });
  lines.push(updated, credit);
  return lines;
}
