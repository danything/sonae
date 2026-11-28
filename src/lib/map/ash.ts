/**
 * 降灰予報 (定時・速報・詳細) の範囲を地図に描く (docs/map.md の「降灰予報の範囲」)。範囲は電文の多角形
 * (`jmx_eb:Polygon`) のまま描き、色は気象庁ホームページの降灰予報の地図の色に合わせる。範囲を広げたり、
 * 時刻の間を補ったり、降灰の量を自分で決めたりはしない (docs/design.md の 5 章)。
 */

import type { AshArea, AshWindow, Volcano, VolcanoAshMap } from "#lib/model.ts";

/** 降灰予報の範囲を読む所 (`src/routes/api/volcano-ash`) */
export const VOLCANO_ASH_URL = "/api/volcano-ash";

/** 範囲を描く報か (降灰予報の定時・速報・詳細で、取り消されていない) */
export const ashDrawn = (v: Volcano | null | undefined): v is Volcano =>
  !!v &&
  !v.cancelled &&
  (v.code === "VFVO53" || v.code === "VFVO54" || v.code === "VFVO55");

/** 範囲の見た目 (気象庁ホームページの降灰予報の地図の色・縁・透かし) */
interface AshStyle {
  /** 凡例の名前 (気象庁の地図の凡例のまま) */
  legend: string;
  fill: string;
  line: string;
  opacity: number;
  /** 塗らずに縞にする (小さな噴石の落下範囲。白地に赤の斜めの縞) */
  stripe?: boolean;
  /** 重ねる順 (大きいほど上。気象庁の地図はコードの数の順) */
  order: number;
}

/**
 * 気象庁ホームページの降灰予報の地図 (`bosai/map.html` の降灰予報。2026-11-28 に読んだ) の色。
 * 降灰 (定時) と少量は灰色、やや多量は黄、多量は赤、小さな噴石の落下範囲は赤の縞
 */
const ASH_STYLES: Record<"70" | "71" | "72" | "73" | "75", AshStyle> = {
  "70": {
    legend: "降灰の範囲",
    fill: "#b0b0b4",
    line: "#c8c8cb",
    opacity: 0.8,
    order: 70,
  },
  "71": {
    legend: "少量の降灰",
    fill: "#b0b0b4",
    line: "#c8c8cb",
    opacity: 0.8,
    order: 71,
  },
  "72": {
    legend: "やや多量の降灰",
    fill: "#faf500",
    line: "#faf500",
    opacity: 0.5,
    order: 72,
  },
  "73": {
    legend: "多量の降灰",
    fill: "#ff2800",
    line: "#ff2800",
    opacity: 0.5,
    order: 73,
  },
  "75": {
    legend: "小さな噴石の落下範囲",
    fill: "#ffffff",
    line: "#ff0000",
    opacity: 1,
    stripe: true,
    order: 75,
  },
};

/**
 * 種類のコードから見た目を引く。火山灰予報 (名前が変わったあとの電文。2026-11-18 の技術資料) の深さのコード
 * (31〜37) は、気象庁の地図の色がまだ無いので、降灰量階級の境 (少量 0.1 mm 未満・やや多量 0.1 mm 以上 1 mm 未満・
 * 多量 1 mm 以上) で今の色に当てる。小さな噴石の落下 (40) は 75 と同じ。重ねる順は深いものほど上
 */
export function ashStyle(a: Pick<AshArea, "code" | "name">): AshStyle {
  const c = a.code ?? "";
  if (c in ASH_STYLES) return ASH_STYLES[c as keyof typeof ASH_STYLES];
  const n = Number(c);
  if (c === "40" || a.name.includes("噴石"))
    return { ...ASH_STYLES["75"], order: 80 };
  if (n === 31) return { ...ASH_STYLES["71"], order: n };
  if (n === 32) return { ...ASH_STYLES["72"], order: n };
  if (n >= 33 && n <= 37) return { ...ASH_STYLES["73"], order: n };
  return ASH_STYLES["70"];
}

const empty = { type: "FeatureCollection", features: [] };

/** 描く範囲 (選んだ時刻の区切りの多角形)。色・縁・透かし・順は `ashStyle` */
export function ashFeatures(windows: AshWindow[], index: number) {
  const w = windows[index];
  if (!w) return empty;
  return {
    type: "FeatureCollection",
    features: w.areas.map((a, i) => {
      const s = ashStyle(a);
      return {
        type: "Feature",
        id: i,
        properties: {
          name: a.name,
          fill: s.fill,
          line: s.line,
          opacity: s.opacity,
          stripe: s.stripe === true,
          order: s.order,
        },
        geometry:
          a.polygons.length === 1
            ? { type: "Polygon", coordinates: a.polygons }
            : {
                type: "MultiPolygon",
                coordinates: a.polygons.map((p) => [p]),
              },
      };
    }),
  };
}

/**
 * 選んだ時刻の区切りに出ている種類の凡例 (重い順)。同じ見た目の種類 (火山灰予報の 1 mm 以上〜30 cm 以上など) は
 * 1 行にまとめ、名前を電文のまま「・」でつなぐ。名前は全角の英数字を半角にする
 */
export function ashLegend(
  w: AshWindow | undefined,
): { name: string; style: AshStyle }[] {
  if (!w) return [];
  const rows = new Map<string, { names: string[]; style: AshStyle }>();
  for (const a of w.areas) {
    const s = ashStyle(a);
    const k = `${s.fill}|${s.line}|${s.stripe === true}`;
    const name = a.name.normalize("NFKC");
    const row = rows.get(k);
    if (!row) rows.set(k, { names: [name], style: s });
    else {
      if (!row.names.includes(name)) row.names.push(name);
      if (s.order > row.style.order) row.style = s;
    }
  }
  return [...rows.values()]
    .map((r) => ({ name: r.names.join("・"), style: r.style }))
    .sort((a, b) => b.style.order - a.style.order);
}

/**
 * 初めに見せる時刻の区切り。まだ終わっていない区切りのいちばん早いもの (定時なら、いまの 3 時間)。
 * どれも終わっていれば最後のもの
 */
export function ashDefaultWindow(windows: AshWindow[], now: number): number {
  const i = windows.findIndex((w) => !w.end || Date.parse(w.end) > now);
  return i >= 0 ? i : Math.max(0, windows.length - 1);
}

/** 全部の区切りの範囲が入る [西, 南, 東, 北] */
export function ashBounds(
  windows: AshWindow[],
): [number, number, number, number] | undefined {
  let b: [number, number, number, number] | undefined;
  for (const w of windows)
    for (const a of w.areas)
      for (const p of a.polygons)
        for (const [x, y] of p)
          b = b
            ? [
                Math.min(b[0], x),
                Math.min(b[1], y),
                Math.max(b[2], x),
                Math.max(b[3], y),
              ]
            : [x, y, x, y];
  return b;
}

/** 日本時間の「14日15時」(分が 0 でなければ「14日12時31分」) */
function jstHour(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  const m = d.getUTCMinutes();
  return `${d.getUTCDate()}日${d.getUTCHours()}時${m ? `${m}分` : ""}`;
}

/**
 * 時刻の区切りを大きく出す文。気象庁の降灰予報の地図と同じ見せ方で、定時は区切りの初めと終わり
 * (「17日15時〜18時」)、詳細は噴火から積み上げた終わり (「14日14時まで」)、速報は「噴火から 1 時間以内」。
 * スマホの形の細い凡例でも 1〜2 行に収まるよう短くし、何の予想かは `ashExplain` で書く
 */
export function ashWindowTitle(
  code: VolcanoAshMap["code"],
  w: AshWindow | undefined,
): string {
  if (!w) return "";
  if (code === "VFVO54") return "噴火から 1 時間以内";
  if (code === "VFVO55") return `${jstHour(w.end)}まで`;
  const end = jstHour(w.end).replace(/^\d+日/, "");
  return `${jstHour(w.start)}〜${end}`;
}

/**
 * 何の予想かの 1 文。定時は噴火していなくても出る (気象庁の言葉で「仮に噴火した場合」の予想) ので、
 * いま降っている所と取り違えないよう、いつも書く
 */
export function ashExplain(
  code: VolcanoAshMap["code"],
  eventTime: string | undefined,
): string {
  if (code === "VFVO53")
    return "噴火した場合の予想で、いま降っている所ではありません (噴火していなくても 3 時間ごとに出ます)。";
  const t = eventTime ? `${jstHour(eventTime)}頃の` : "";
  return code === "VFVO54"
    ? `${t}噴火から 1 時間以内の予想です。`
    : `${t}噴火から、その時刻までに降る量の予想です。`;
}

/** 有効期限を過ぎたか (詳しい内容の「◯時まで有効」と同じ `validUntil`) */
export const ashExpired = (v: Pick<Volcano, "validUntil">, now: number) =>
  v.validUntil !== undefined && Date.parse(v.validUntil) < now;

/** 地図の source の出典 */
const ASH_ATTRIBUTION = "気象庁 (降灰予報)";

/** 小さな噴石の落下範囲の縞の画像 (白地に赤の斜めの縞。気象庁の地図と同じ形)。`map.addImage` に渡す */
export function ashStripeImage(size = 10): {
  width: number;
  height: number;
  data: Uint8Array;
} {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      // 右上がりの斜めの線 (幅 3 px)。縞の間は白
      const red = (x + y) % size < 3;
      const o = (y * size + x) * 4;
      data[o] = 255;
      data[o + 1] = red ? 0 : 255;
      data[o + 2] = red ? 0 : 255;
      data[o + 3] = 255;
    }
  return { width: size, height: size, data };
}
export const ASH_STRIPE = "ash-stripe";

export function ashSources(): Record<string, unknown> {
  return {
    ash: { type: "geojson", data: empty, attribution: ASH_ATTRIBUTION },
  };
}

/**
 * 塗りと縁の層。警報・注意報と震度の塗りの上、津波の線と特別警報の縁取りの下に置く。塗りは種類ごとの透かしで、
 * 重い種類を上に重ねる (`fill-sort-key`)。縁は写真の上で読めるよう、黒い細い縁の上に種類の色で引く
 */
export function ashLayers(): Record<string, unknown>[] {
  const order = ["get", "order"];
  return [
    {
      id: "ash-fill",
      type: "fill",
      source: "ash",
      filter: ["!", ["get", "stripe"]],
      layout: { "fill-sort-key": order },
      paint: {
        "fill-color": ["get", "fill"],
        "fill-opacity": ["get", "opacity"],
      },
    },
    {
      id: "ash-stripe",
      type: "fill",
      source: "ash",
      filter: ["get", "stripe"],
      layout: { "fill-sort-key": order },
      paint: { "fill-pattern": ASH_STRIPE, "fill-opacity": 0.85 },
    },
    {
      id: "ash-casing",
      type: "line",
      source: "ash",
      layout: { "line-join": "round", "line-sort-key": order },
      paint: { "line-color": "rgba(0,0,0,0.5)", "line-width": 3.5 },
    },
    {
      id: "ash-line",
      type: "line",
      source: "ash",
      layout: { "line-join": "round", "line-sort-key": order },
      paint: { "line-color": ["get", "line"], "line-width": 2 },
    },
  ];
}
