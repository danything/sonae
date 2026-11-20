/**
 * 海しる (海上保安庁の海洋状況表示システム) から取った点の層。海底地殻変動観測点 (GNSS-A) と海域火山データベース
 * (docs/map.md の「海しるの点」)。サーバーが 1 日 1 回取って DB に置き (`#lib/server/sources/msil.ts`)、画面は
 * `/api/marine` から読む。ブラウザには API のキーを渡さない。
 *
 * ここは画面とサーバーの両方から読む。点の properties の形と、吹き出しの中身を組む所
 */

/** 海しるの層。`gnssa` は海底地殻変動観測点、`volcano` は海域火山データベース */
export type MarineKind = "gnssa" | "volcano";

/** 点の properties。サーバーが海しるの属性から作る (画面は海しるの属性の名前を知らない) */
export interface MarinePoint {
  kind: MarineKind;
  /** 観測点の名前・火山の名前 */
  name: string;
  /** 海域火山: 位置を示す点の名前 (「三原新山」)。火山の名前と同じなら空 */
  point?: string;
  /** 海底地殻変動観測点: 設置水深 (m) */
  depthM?: number;
  /** 海域火山: 標高 (m)。海の下は負 */
  heightM?: number;
  /** 海底地殻変動観測点: 設置機関 */
  org?: string;
  /** 海底地殻変動観測点: 設置した年と月 (「2000/07」) */
  since?: string;
  /** 海域火山: 位置の出どころ (「日本活火山総覧（第4版）」) */
  basis?: string;
  /** 海上保安庁のページ (https だけ) */
  url?: string;
}

export interface MarineFeature {
  type: "Feature";
  properties: MarinePoint;
  geometry: { type: "Point"; coordinates: [number, number] };
}

export interface MarineCollection {
  type: "FeatureCollection";
  features: MarineFeature[];
}

/** `/api/marine` の答え。キーが無ければ `enabled` が false で点は空 (層を出さない) */
export interface MarineResponse {
  enabled: boolean;
  /** 層ごとに、いちばん新しく取れた時刻 (ISO 8601) */
  fetchedAt: Partial<Record<MarineKind, string>>;
  data: MarineCollection;
}

export const MARINE_URL = "/api/marine";

/** 海しるのトップ。出典の文に出す */
export const MSIL_SITE = "https://www.msil.go.jp/";

/** 海しる API 利用規約 5 条で、使ったサービスに出す文 (文のまま) */
export const MSIL_DISCLAIMER =
  "このサービスは、海しるAPIを利用して取得した情報をもとに作成しているが、サービスの内容は海上保安庁によって保証されたものではない";

export const MARINE_KIND_LABEL: Record<MarineKind, string> = {
  gnssa: "海底地殻変動観測点 (GNSS-A)",
  volcano: "海域火山",
};

const nf = new Intl.NumberFormat("ja-JP");

/** 吹き出しの 1 行 */
export interface PopupLine {
  text: string;
  /** 太字・小さく・控えた字・とても小さく (QuakeMap の吹き出しの class と同じ) */
  cls?: string;
  href?: string;
}

/**
 * 押した点の吹き出しの中身 (上から)。名前・種類・水深か標高・設置機関や位置の出どころ・海上保安庁のページ・出典。
 * 文は DOM で組み、HTML として読まない
 */
export function marinePopup(p: MarinePoint): PopupLine[] {
  const lines: PopupLine[] = [{ text: p.name, cls: "bold" }];
  lines.push({ text: MARINE_KIND_LABEL[p.kind], cls: "small" });
  if (p.kind === "gnssa") {
    if (p.depthM !== undefined)
      lines.push({
        text: `設置水深 ${nf.format(p.depthM)} m`,
        cls: "small muted",
      });
    const by = [
      p.org ? `設置機関 ${p.org}` : "",
      p.since
        ? `${p.since.replace(/^(\d{4})\/0?(\d{1,2})$/, "$1 年 $2 月")} 設置`
        : "",
    ].filter(Boolean);
    if (by.length > 0) lines.push({ text: by.join("・"), cls: "small muted" });
    if (p.url)
      lines.push({
        text: "観測の結果 (海上保安庁)",
        cls: "small",
        href: p.url,
      });
  } else {
    if (p.point) lines.push({ text: p.point, cls: "small muted" });
    if (p.heightM !== undefined)
      lines.push({
        text:
          p.heightM < 0
            ? `水深 ${nf.format(-p.heightM)} m (いちばん浅い所)`
            : `標高 ${nf.format(p.heightM)} m`,
        cls: "small muted",
      });
    if (p.basis) lines.push({ text: `位置: ${p.basis}`, cls: "small muted" });
    if (p.url)
      lines.push({
        text: "海域火山データベース (海上保安庁)",
        cls: "small",
        href: p.url,
      });
  }
  lines.push({
    text: "出典：海洋状況表示システム (海しる)。海上保安庁が保証するものではありません",
    cls: "tiny muted",
  });
  return lines;
}

/**
 * 地図の印 (MapLibre の addImage に渡す。pixelRatio 2)。画面だけで呼ぶ。
 * 海底地殻変動観測点は黒い縁の水色のひし形、海域火山は黒い縁の白い三角の輪郭。
 * 噴火警報・予報の火山の印 (段の色で塗った三角) と見分けられるよう、海域火山は塗らない
 */
export function marineIcons(): Record<string, ImageData> {
  const draw = (
    s: number,
    path: (g: CanvasRenderingContext2D) => void,
    paint: (g: CanvasRenderingContext2D) => void,
  ) => {
    const c = document.createElement("canvas");
    c.width = s;
    c.height = s;
    const g = c.getContext("2d");
    if (!g) return new ImageData(s, s);
    g.lineJoin = "round";
    path(g);
    paint(g);
    return g.getImageData(0, 0, s, s);
  };
  return {
    "marine-gnssa": draw(
      24,
      (g) => {
        g.beginPath();
        g.moveTo(12, 2);
        g.lineTo(22, 12);
        g.lineTo(12, 22);
        g.lineTo(2, 12);
        g.closePath();
      },
      (g) => {
        g.fillStyle = "#4fd8e6";
        g.fill();
        g.strokeStyle = "rgba(0,0,0,0.75)";
        g.lineWidth = 2.5;
        g.stroke();
      },
    ),
    "marine-volcano": draw(
      28,
      (g) => {
        g.beginPath();
        g.moveTo(14, 4);
        g.lineTo(25, 23);
        g.lineTo(3, 23);
        g.closePath();
      },
      (g) => {
        g.strokeStyle = "rgba(0,0,0,0.75)";
        g.lineWidth = 6;
        g.stroke();
        g.strokeStyle = "#ffffff";
        g.lineWidth = 2.5;
        g.stroke();
      },
    ),
  };
}

/**
 * 押した所に近い点を選ぶ。点は小さいので、押せる範囲を点より広く取る (観測点の丸と同じ。指は 22px、マウスは 10px)。
 * `d2` は押した所からの距離 (px) の 2 乗
 */
export function nearestMarine<T extends { d2: number }>(
  hits: readonly T[],
): T | undefined {
  let best: T | undefined;
  for (const h of hits) if (!best || h.d2 < best.d2) best = h;
  return best;
}
