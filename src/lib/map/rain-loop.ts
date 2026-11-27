/**
 * 雨雲 (いま→予測)。docs/map.md の「雨雲 (いま→予測)」。
 * 雨雲 (高解像度降水ナウキャストのいまの観測。`#lib/map/rain.ts`) の 1 枚と、今後の雨 (降水短時間予報の 1 時間の雨量。
 * `#lib/map/nowc.ts`) の 3 時間先までの枚を、決めた間で順に見せ続ける。どれも気象庁の 1 枚を色も値も変えずに出すだけで、
 * 枚の間を補ったり、sonae が先を予想したりはしない (docs/design.md の 5 章)。
 * 枚ごとに source と層を分けて全部を読んでおき、見せる枚だけ透明度を上げる (MapLibre は透明度 0 の層を描かないが、
 * タイルは読んだまま持つので、替えたときに白く抜けない)。DOM にも MapLibre にも触らない (試験できるように)
 */

import { hoursAhead, type NowcFrame } from "#lib/map/nowc.ts";
import { RAIN_TILE_ZOOMS } from "#lib/map/rain.ts";

/** 枚の数。0 がいまの観測、1〜3 が 1・2・3 時間先の予測 */
export const LOOP_SLOTS = [0, 1, 2, 3] as const;
export type LoopSlot = (typeof LOOP_SLOTS)[number];
/** 予測を何時間先まで見せるか */
export const LOOP_HOURS = 3;

/** 1 枚を見せる間 */
export const LOOP_FRAME_MS = 2500;
/** 最後の枚 (いちばん先の予測) を見せる間。少し長く止めてから、いまへ戻る */
export const LOOP_LAST_MS = 4500;
/** 次の枚のタイルがまだ読めていないときに、待ってから確かめ直す間 */
export const LOOP_WAIT_MS = 500;
/** タイルを待つのはここまで。読めないままでも次へ進む (止まったままにしない) */
export const LOOP_WAIT_MAX_MS = 5000;

/** 枚ごとの source と層の名前 (タイルのズーム n の段) */
export const loopLayerId = (slot: number, n: number) => `rainloop-${slot}-${n}`;
/** すべての枚と段の層の名前 */
export const LOOP_LAYER_IDS = LOOP_SLOTS.flatMap((s) =>
  RAIN_TILE_ZOOMS.map((n) => loopLayerId(s, n)),
);

/**
 * 今後の雨の並び (`forecastFrames`) から、見せる予測を選ぶ。いまの観測 (`after`。UTC の `YYYYMMDDhhmmss`) より先の
 * 時刻のものを、近い順に `LOOP_HOURS` 枚まで。予測の解析が古くて、いまより前の時刻の枚があっても出さない
 */
export function loopForecast(
  frames: readonly NowcFrame[],
  after: string | null,
): NowcFrame[] {
  return frames
    .filter((f) => after === null || f.validtime > after)
    .filter((f) => hoursAhead(f) > 0)
    .slice(0, LOOP_HOURS);
}

/** 枚ごとに出せるか (時刻の表を読めているか)。0 はいまの観測、1〜3 は予測の何枚目まであるか */
export const loopReady = (rain: boolean, forecasts: number): boolean[] =>
  LOOP_SLOTS.map((s) => (s === 0 ? rain : s <= forecasts));

/** 次に見せる枚。出せる枚だけを順に回り、最後の次はいまへ戻る。出せる枚が無ければそのまま */
export function nextSlot(step: number, ready: readonly boolean[]): number {
  for (let i = 1; i <= ready.length; i++) {
    const s = (step + i) % ready.length;
    if (ready[s]) return s;
  }
  return step;
}

/** 出せる枚のうち、いちばん先のもの (無ければ -1) */
export const lastSlot = (ready: readonly boolean[]) => ready.lastIndexOf(true);

/** その枚を見せる間。最後の枚だけ少し長い */
export const slotDelay = (step: number, ready: readonly boolean[]) =>
  step === lastSlot(ready) ? LOOP_LAST_MS : LOOP_FRAME_MS;

/** 見せる枚が出せなくなったら (予測が減った・読めなくなった)、出せる最初の枚へ移す */
export function settleSlot(step: number, ready: readonly boolean[]): number {
  if (ready[step]) return step;
  const first = ready.indexOf(true);
  return first === -1 ? 0 : first;
}

/** 枚の名前 (並びのボタンと、大きく出す見出し)。いまの観測は「いま」、予測は「+1 時間」のように */
export const slotName = (slot: number, frame: NowcFrame | null) =>
  slot === 0 ? "いま" : `+${frame ? hoursAhead(frame) : slot} 時間`;
