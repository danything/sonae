/**
 * 台風の暴風域に入る確率 (VPTA50〜55) から、住んでいる地域の分を取り出す (docs/design.md の 2.8)。
 * 値は電文のまま (%) で、足したり補ったりしない。画面の台風の詳しい内容だけで使い、通知には使わない
 * (暴風の警報は気象警報・注意報で知らせる)
 */

import type { TyphoonProbability } from "./model.ts";

export const TYPHOON_PROBABILITY_URL = "/api/typhoon-probability";
/** 詳しい内容を開いている間に読み直す間隔 (確率は台風解析・予報情報と同じく 3〜6 時間ごとに出る) */
export const TYPHOON_PROBABILITY_REFRESH_MS = 10 * 60_000;

export interface HomeProbability {
  /** 地域 (市町村等をまとめた地域) の名前 */
  name: string;
  /** どの時刻も 0% (電文に並ぶ全部の地域のうち、値の無い地域) */
  zero: boolean;
  /** 積算 (24 時間先まで・48 時間先まで…)。`until` はその終わりの時刻 */
  days: { hours: number; until: string; p: number }[];
  /**
   * 3 時間ごと。0% でない最初の区切りから最後の区切りまで (間の 0% も並べる)。前後の 0% は並べない
   */
  steps: { from: string; to: string; p: number }[];
}

const plus = (iso: string, hours: number) =>
  new Date(Date.parse(iso) + hours * 3600_000).toISOString();

/** `area` は市町村等をまとめた地域のコード (`cities.json` の 5 列目) */
export function homeProbability(
  prob: TyphoonProbability,
  area: string,
  name: string,
): HomeProbability {
  const a = prob.areas[area];
  const days = prob.dayHours.map((hours, i) => ({
    hours,
    until: plus(prob.baseTime, hours),
    p: a?.days[i] ?? 0,
  }));
  const all = prob.stepTimes.map((from, i) => ({
    from,
    to: prob.stepTimes[i + 1] ?? plus(from, 3),
    p: a?.steps[i] ?? 0,
  }));
  const first = all.findIndex((s) => s.p > 0);
  const last = all.findLastIndex((s) => s.p > 0);
  return {
    name: a?.name ?? name,
    zero: !a,
    days,
    steps: first < 0 ? [] : all.slice(first, last + 1),
  };
}
