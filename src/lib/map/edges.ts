/**
 * 地図の端に重なっているもの (隅の出典・右下の操作) を避けて吹き出しを置くための余白。DOM にも MapLibre にも触らない。
 * 広い形は出典も操作も下の端、スマホの形は出典が上の端・操作が下の端 (docs/map.md の「出典の出し方」)。
 * どちらも右の端に寄せているので、左右は空けない (左右に置くものを足したら、ここも見る)
 */

/** 画面の上の箱 (getBoundingClientRect の形) */
export type Box = { top: number; bottom: number; left: number; right: number };

/** 重なるものとのすき間 (px) */
export const EDGE_GAP = 8;

/**
 * 吹き出しの余白 (MapLibre の Popup の `padding`)。地図の上半分にあるものは上の端から、下半分にあるものは下の端から、
 * その端までを空ける。地図に重ならないもの・大きさの無いものは見ない。上と下で地図の高さの 6 割を超えるときは詰める
 * (吹き出しの置き場が無くならないように)
 */
export function edgePadding(
  map: Box,
  covers: readonly (Box | undefined)[],
): Box {
  let top = 0;
  let bottom = 0;
  const h = map.bottom - map.top;
  for (const c of covers) {
    if (!c || c.bottom <= c.top || c.right <= c.left) continue;
    if (c.bottom <= map.top || c.top >= map.bottom) continue;
    if (c.right <= map.left || c.left >= map.right) continue;
    if ((c.top + c.bottom) / 2 < map.top + h / 2)
      top = Math.max(top, c.bottom - map.top + EDGE_GAP);
    else bottom = Math.max(bottom, map.bottom - c.top + EDGE_GAP);
  }
  const k = h > 0 && top + bottom > h * 0.6 ? (h * 0.6) / (top + bottom) : 1;
  return { top: top * k, bottom: bottom * k, left: 0, right: 0 };
}
