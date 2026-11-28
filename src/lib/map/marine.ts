/**
 * 海しる (海上保安庁の海洋状況表示システム) から取った点の層。海底地殻変動観測点 (GNSS-A)・海域火山データベース・
 * 海上保安部署等・潮汐推算の地点 (docs/map.md の「海しるの点」)。サーバーが 1 日 1 回取って DB に置き
 * (`#lib/server/sources/msil.ts`)、画面は `/api/marine` から読む。潮汐推算の値は、地点を押したときに `/api/tide` から読む。
 * ブラウザには API のキーを渡さない。
 *
 * ここは画面とサーバーの両方から読む。点の properties の形と、吹き出しの中身を組む所
 */

/**
 * 海しるの層。`gnssa` は海底地殻変動観測点、`volcano` は海域火山データベース、`office` は海上保安部署等、
 * `tide` は潮汐推算の地点
 */
export type MarineKind = "gnssa" | "volcano" | "office" | "tide";

/** 点の properties。サーバーが海しるの属性から作る (画面は海しるの属性の名前を使わない) */
export interface MarinePoint {
  kind: MarineKind;
  /** 観測点・火山・部署・地点の名前 */
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
  /** 海上保安部署等: 所在地 (郵便番号を前に付けたもの) */
  address?: string;
  /** 海上保安部署等: 電話番号 */
  phone?: string;
  /** 潮汐推算の地点: 地点のコード (`/api/tide?station=` に渡す) */
  code?: string;
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

const MARINE_KIND_LABEL: Record<MarineKind, string> = {
  gnssa: "海底地殻変動観測点 (GNSS-A)",
  volcano: "海域火山",
  office: "海上保安部署 (海上保安庁)",
  tide: "潮汐推算の地点 (海上保安庁)",
};

/** 海上保安部署等の印を出すズーム (191 か所。引いた縮尺では港ごとに重なるため) */
export const OFFICE_MINZOOM = 7;
/** 潮汐推算の地点の印を出すズーム (海上保安部署より多く、湾の中に詰まって並ぶため) */
export const TIDE_MINZOOM = 8;

export const TIDE_URL = "/api/tide";

/**
 * 潮汐推算の吹き出しにいつも出す注意。推算の値で、いまの海面ではないことを先に言う (docs/design.md の 2.11)。
 * 「航海には潮汐表を」は、海しるの潮汐推算 API の説明の文に沿う
 */
const TIDE_NOTE =
  "月と太陽の動きから計算した推算の潮位です。津波や高潮の観測ではなく、気圧や風による潮位の変化は入っていません。津波・高潮は気象庁の警報と潮位の観測で確かめてください。航海には海上保安庁の「潮汐表」を使ってください。";

/** `/api/tide` の答え。1 日分の推算の潮位 (cm)。`stepSec` ごとに `tide` が並ぶ */
export interface TideDay {
  /** 地点のコード */
  code: string;
  /** 推算した日 (日本時間の YYYY-MM-DD) */
  date: string;
  /** 最初の値の時刻 (ISO 8601) */
  start: string;
  /** 値の間 (秒) */
  stepSec: number;
  /** 推算の潮位 (cm。海しるの値のまま) */
  tide: number[];
}

/** `/api/tide` の答え (キーが無い・地点が無い・取れないとき) */
export interface TideError {
  error: string;
}

/** 満潮・干潮 (推算の値の山と谷)。`at` は時刻のミリ秒 */
interface TideTurn {
  kind: "high" | "low";
  at: number;
  cm: number;
}

/**
 * 1 日の推算の値から満潮と干潮を取り出す。値を計算し直さず、並んだ値の山と谷 (前後 90 分でいちばん高い・低い所) を
 * 読むだけ。同じ値が続く所は真ん中の時刻にする。日の端の値は、前後が分からないので満潮・干潮にしない
 */
export function tideTurns(d: TideDay, windowMin = 90): TideTurn[] {
  const v = d.tide;
  const t0 = Date.parse(d.start);
  if (!Number.isFinite(t0) || v.length < 3 || !(d.stepSec > 0)) return [];
  const w = Math.max(1, Math.round((windowMin * 60) / d.stepSec));
  const out: TideTurn[] = [];
  let i = 0;
  while (i < v.length) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[i]) j++;
    const before = v[i - 1];
    const after = v[j + 1];
    if (before !== undefined && after !== undefined) {
      const x = v[i] as number;
      const lo = Math.max(0, i - w);
      const hi = Math.min(v.length - 1, j + w);
      const around = v.slice(lo, hi + 1);
      const kind =
        x > before && x > after && x >= Math.max(...around)
          ? "high"
          : x < before && x < after && x <= Math.min(...around)
            ? "low"
            : undefined;
      if (kind) {
        const mid = Math.round((i + j) / 2);
        out.push({ kind, at: t0 + mid * d.stepSec * 1000, cm: x });
      }
    }
    i = j + 1;
  }
  return out;
}

/**
 * 吹き出しの小さな図の線 (SVG の polyline の points)。`stepMin` 分ごとに間引く。値の高さは図の中で
 * 上下を合わせるだけで、値は変えない
 */
export function tidePolyline(
  d: TideDay,
  width: number,
  height: number,
  stepMin = 10,
): { points: string; min: number; max: number } {
  const v = d.tide;
  if (v.length === 0) return { points: "", min: 0, max: 0 };
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = Math.max(1, max - min);
  const every = Math.max(1, Math.round((stepMin * 60) / d.stepSec));
  const pts: string[] = [];
  const last = v.length - 1;
  for (let i = 0; i <= last; i += every) pts.push(pt(i));
  if (last % every !== 0) pts.push(pt(last));
  return { points: pts.join(" "), min, max };
  function pt(i: number) {
    const x = last === 0 ? 0 : (i / last) * width;
    const y = height - (((v[i] as number) - min) / span) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }
}

const nf = new Intl.NumberFormat("ja-JP");

/** 吹き出しの 1 行 (地図の吹き出しはどれもこの形。`roads.ts`・`cameras.ts`・`livecams.ts`・`typhoon.ts` も使う) */
export interface PopupLine {
  text: string;
  /** 太字・小さく・控えた字・とても小さく (QuakeMap の吹き出しの class と同じ) */
  cls?: string;
  href?: string;
}

/**
 * 押した点の吹き出しの中身 (上から)。名前・種類・点ごとの中身 (水深か標高・設置機関や位置の出どころ、部署の所在地と
 * 電話番号、潮汐推算の注意)・海上保安庁のページ・出典。文は DOM で組み、HTML として読まない
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
  } else if (p.kind === "office") {
    if (p.address) lines.push({ text: p.address, cls: "small muted" });
    if (p.phone) lines.push({ text: `電話 ${p.phone}`, cls: "small muted" });
    lines.push({
      text: "海の事件・事故は 118 番 (海上保安庁)",
      cls: "small",
    });
    if (p.url)
      lines.push({
        text: "部署のページ (海上保安庁)",
        cls: "small",
        href: p.url,
      });
  } else if (p.kind === "tide") {
    // 推算の値と満潮・干潮は、押した後に /api/tide から読んで画面が足す (QuakeMap の openMarine)
    lines.push({ text: TIDE_NOTE, cls: "tiny muted" });
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
    // 海上保安部署等: 白い縁の紺の丸に白い「海」。避難場所の「避」と同じく字で見分ける
    "marine-office": draw(
      40,
      (g) => {
        g.beginPath();
        g.arc(20, 20, 17, 0, Math.PI * 2);
      },
      (g) => {
        g.fillStyle = "#1d3a78";
        g.fill();
        g.strokeStyle = "#ffffff";
        g.lineWidth = 3;
        g.stroke();
        glyph(g, "海", "#ffffff");
      },
    ),
    // 潮汐推算の地点: 黒い縁の白い丸に紺の「潮」。海上保安部署と地と字の色を入れ替える
    "marine-tide": draw(
      40,
      (g) => {
        g.beginPath();
        g.arc(20, 20, 17, 0, Math.PI * 2);
      },
      (g) => {
        g.fillStyle = "#ffffff";
        g.fill();
        g.strokeStyle = "rgba(0,0,0,0.75)";
        g.lineWidth = 2.5;
        g.stroke();
        glyph(g, "潮", "#1d3a78");
      },
    ),
  };
}

/** 印の真ん中に 1 字を書く (太字) */
function glyph(g: CanvasRenderingContext2D, ch: string, color: string): void {
  g.fillStyle = color;
  // 避難場所の印と同じ字体 (`#lib/map/style.ts` の `TEXT_FONT_CSS`)
  g.font = 'bold 22px "Noto Sans JP", sans-serif';
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(ch, 20, 21);
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

/** 海しるの点を描く層 (押したときに見る。海上保安部署等と潮汐推算の地点は寄せたときだけ描く) */
export const MARINE_LAYERS = ["marine", "marine-office", "marine-tide"];

const hm = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "numeric",
  minute: "2-digit",
});
const md = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  weekday: "short",
});

/** 「満潮 4:12 152 cm」 */
export const tideTurnText = (t: TideTurn) =>
  `${t.kind === "high" ? "満潮" : "干潮"} ${hm.format(t.at)} ${t.cm} cm`;

/** 推算した日 (`YYYY-MM-DD`、日本時間) を「11/28(土)」に */
export const tideDayLabel = (date: string) =>
  md.format(Date.parse(`${date}T12:00:00+09:00`));
