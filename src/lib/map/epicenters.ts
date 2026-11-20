/**
 * 震源の丸 (新しい 50 件の地震と海外の地震) の大きさと、押した所から選ぶ地震を決める所 (docs/map.md の「震源の丸を押したとき」)。
 * 丸を押すと、一覧でその地震を選んだのと同じになる
 */

/** 丸の大きさの段 ([M, 半径 px])。間は線で結ぶ。範囲の外は端の大きさ */
export type RadiusStops = readonly (readonly [number, number])[];

/** 国内の地震の丸 (M1 で 3 px、M5 で 7 px、M8 で 16 px) */
export const HYPO_RADIUS: RadiusStops = [
  [1, 3],
  [5, 7],
  [8, 16],
];
/** 海外の地震の丸 (M4 で 5 px、M6 で 9 px、M9 で 18 px) */
export const FOREIGN_RADIUS: RadiusStops = [
  [4, 5],
  [6, 9],
  [9, 18],
];

/** 丸の半径の MapLibre の式 (M の `m` で線で結ぶ) */
export function radiusExpr(stops: RadiusStops): unknown[] {
  return ["interpolate", ["linear"], ["get", "m"], ...stops.flat()];
}

/** M から丸の半径 (px)。`radiusExpr` と同じ値 */
export function radiusAt(stops: RadiusStops, m: number): number {
  const first = stops[0];
  const last = stops.at(-1);
  if (!first || !last) return 0;
  if (!(m > first[0])) return first[1];
  if (m >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i++) {
    const [m1, r1] = stops[i] ?? last;
    const [m0, r0] = stops[i - 1] ?? first;
    if (m <= m1) return r0 + ((r1 - r0) * (m - m0)) / (m1 - m0);
  }
  return last[1];
}

/**
 * 押せる範囲 (押した所からの px)。観測点の丸と同じく、指は 22 px (44 px 四方。denpa の design.md の押せる大きさ)、
 * マウスは 10 px。丸がこれより大きいときは丸の中ならどこでも押せる
 */
export function epicenterReach(touch: boolean): number {
  return touch ? 22 : 10;
}

/** 押した所の近くにある丸 1 つ */
export interface EpicenterHit {
  /** 国内の地震か海外の地震か (選ぶときの種類) */
  kind: "quake" | "foreign";
  id: string;
  /** 押した所から丸の中心までの距離 (px) の 2 乗 */
  d2: number;
  /** 丸の半径 (px) */
  radius: number;
  /** 描く順 (新しいほど大きい。上に描く) */
  order: number;
}

/**
 * 押した所から選ぶ地震。押せる範囲 (`reach` と丸の半径の大きいほう) にある丸のうち、中心が押した所にいちばん近いもの。
 * 同じ近さなら上に描いているもの (海外の地震の丸は国内の丸の上。同じ層では新しいもの) を選ぶ
 */
export function nearestEpicenter<T extends EpicenterHit>(
  hits: readonly T[],
  reach: number,
): T | undefined {
  let best: T | undefined;
  for (const h of hits) {
    const r = Math.max(reach, h.radius);
    if (h.d2 > r * r) continue;
    if (!best || h.d2 < best.d2 || (h.d2 === best.d2 && above(h, best)))
      best = h;
  }
  return best;
}

/** `a` が `b` より上に描かれているか */
function above(a: EpicenterHit, b: EpicenterHit): boolean {
  if (a.kind !== b.kind) return a.kind === "foreign";
  return a.order > b.order;
}
