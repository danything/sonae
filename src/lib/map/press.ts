/**
 * 地図の右クリック・長押しのメニュー (docs/map.md の「地図のメニュー」) の決め方。DOM にも MapLibre にも触らない。
 * 長押しそのもの (指 1 本・500 ミリ秒・動いたら取りやめ) は MapLibre が数える。ここはその上の念押しと、出す文
 */

/** 指を置いた所からこれより離れた所で長押しが来たら、出さない (地図を動かしている) */
export const LONG_PRESS_SLOP = 10;

/**
 * 指を置いてから長押しが来るまでの様子で、メニューを出してよいか。
 * 指が 1 本で、ほとんど動かず、地図も動いていないときだけ (2 本指の拡大・ドラッグを邪魔しない)
 */
export function longPressOk(p: {
  /** 置いた所からの動き (px) */
  dx: number;
  dy: number;
  /** 置いている指の数 */
  touches: number;
  /** 置いてから地図が動いた (ドラッグ・拡大・慣性) */
  mapMoved: boolean;
}): boolean {
  return (
    p.touches === 1 && !p.mapMoved && Math.hypot(p.dx, p.dy) <= LONG_PRESS_SLOP
  );
}

/** 写す緯度・経度の文 (小数 5 桁 = 約 1 m。地図アプリに貼れる「緯度, 経度」の順) */
export const coordText = (lat: number, lon: number): string =>
  `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

/** メニューの見出しに出す、押した所 (北緯・東経。南半球・西半球はそう書く) */
export function coordLabel(lat: number, lon: number): string {
  const ns = lat >= 0 ? "北緯" : "南緯";
  const ew = lon >= 0 ? "東経" : "西経";
  return `${ns} ${Math.abs(lat).toFixed(4)}・${ew} ${Math.abs(lon).toFixed(4)}`;
}
