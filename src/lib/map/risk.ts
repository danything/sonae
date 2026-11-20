/**
 * キキクル (気象庁の大雨の危険度分布)。docs/map.md の「キキクル」。
 * 気象庁ホームページのキキクルの画面が読むタイルを、ブラウザから直接読む。公式の API ではなく、予告なく変わる。
 * 気象庁が判定した危険度の 1 枚を、色も値も変えずに重ねるだけで、sonae が危険度を判定し直すことはしない
 * (docs/design.md の 5 章)。DOM にも MapLibre にも触らない (試験できるように)
 */

import { RAIN_TILE_ZOOMS } from "#lib/map/rain.ts";

export const RISK = "https://www.jma.go.jp/bosai/jmatile/data/risk";
/** 時刻の表 (10 分ごと。新しい順。いまと過去 6 時間ほど) */
export const RISK_TIMES_URL = `${RISK}/targetTimes.json`;
/** 気象庁ホームページのキキクルの画面 (凡例と出典のリンク) */
export const RISK_PAGE = "https://www.jma.go.jp/bosai/risk/";
export const RISK_ATTRIBUTION = `<a href="${RISK_PAGE}" target="_blank" rel="noopener">気象庁 キキクル</a> を加工`;

/** 地図の隅の短い出典は「気象庁」をもう含むので足さない。凡例に出す出典 */
export const RISK_CREDIT = "気象庁 (キキクル)";

/**
 * タイルのあるズーム。雨雲と同じく偶数の 4〜10 だけで、ほかのズームは何も塗っていない空のタイル (334 バイト) が返る
 * (2026-11-21 に確かめた。キキクルの画面の設定も `zoomUse="even"`)
 */
export const RISK_TILE_ZOOMS = RAIN_TILE_ZOOMS;

/** 選べるキキクル。気象庁の 2026 年 5 月からの体系の土砂・大雨。浸水と洪水は大雨にまとまる (docs/map.md) */
export interface RiskKind {
  id: "risk-land" | "risk-heavyrain";
  /** タイルの要素の名前 (時刻の表の `elements`) */
  element: "land" | "rain_mesh";
  /** 選択肢の名前 (見出し「キキクル」の下) */
  label: string;
  /** 凡例の上に出す名前 */
  title: string;
  /** 凡例の下に出す、何の危険度か */
  about: string;
}

export const RISKS: RiskKind[] = [
  {
    id: "risk-land",
    element: "land",
    label: "土砂",
    title: "土砂キキクル (土砂災害の危険度)",
    about:
      "土砂災害の危険度を、実況と 2 時間先までの雨の予測から気象庁が判定したものです。",
  },
  {
    id: "risk-heavyrain",
    element: "rain_mesh",
    label: "大雨 (浸水・洪水)",
    title: "大雨キキクル (浸水・洪水の危険度)",
    about:
      "低地の浸水と中小河川の氾濫の危険度を、気象庁が浸水キキクルと洪水キキクルを重ねて判定したものです。大きな川の氾濫は、一覧の「気象」の指定河川洪水予報を見てください。",
  },
];

export const riskOf = (id: string): RiskKind | undefined =>
  RISKS.find((r) => r.id === id);

/** 1 枚のキキクル。時刻は UTC の `YYYYMMDDhhmmss` (表のまま)。member はタイルの URL の途中の名前 */
export interface RiskFrame {
  basetime: string;
  validtime: string;
  member: string;
}

const STAMP = /^\d{14}$/;
const MEMBER = /^[a-z0-9_]+$/;

/** 時刻の表から、その要素のいちばん新しい 1 枚を選ぶ。読めなければ null */
export function latestRisk(
  raw: unknown,
  element: RiskKind["element"],
): RiskFrame | null {
  if (!Array.isArray(raw)) return null;
  let best: RiskFrame | null = null;
  for (const row of raw as unknown[]) {
    if (typeof row !== "object" || row === null) continue;
    const { basetime, validtime, member, elements } = row as Record<
      string,
      unknown
    >;
    if (typeof basetime !== "string" || typeof validtime !== "string") continue;
    if (!STAMP.test(basetime) || !STAMP.test(validtime)) continue;
    // 表の行は basetime と validtime が同じ (その時刻の判定)。違う行が来ても使わない
    if (basetime !== validtime) continue;
    // 新しい 3 枚は immed0〜2、それより前は none (2026-11-21 に読んだ)。URL に入れるので形を確かめる
    if (typeof member !== "string" || !MEMBER.test(member)) continue;
    if (!Array.isArray(elements) || !elements.includes(element)) continue;
    if (!best || validtime > best.validtime)
      best = { basetime, validtime, member };
  }
  return best;
}

/** タイルの URL の型 (`{z}/{x}/{y}` は MapLibre が埋める) */
export const riskTiles = (f: RiskFrame, element: RiskKind["element"]) =>
  `${RISK}/${f.basetime}/${f.member}/${f.validtime}/surf/${element}/{z}/{x}/{y}.png`;

/** 判定の時刻 (ISO 8601。画面は `#lib/format.ts` の `jst` で出す) */
export function riskIso(f: RiskFrame): string {
  const t = f.validtime;
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}Z`;
}

/** 更新の間隔 (10 分ごと) */
export const RISK_STEP_MS = 10 * 60_000;
/**
 * 判定の時刻から、その時刻の表が取れるまでの待ち。表はその時刻の約 10 分 10 秒後に書き換わり、配信の CDN が
 * 60 秒覚えるので、11 分 30 秒待てば取れる (2026-11-21 に確かめた)
 */
export const RISK_PUBLISH_MS = 11.5 * 60_000;
/** 次の時刻がまだ無かったとき・読めなかったときに、取り直すまでの間 */
export const RISK_RETRY_MS = 60_000;
/**
 * 判定の時刻からこれより経ったら古いとみなし、凡例にそう書く。ふだんでも表に載るまでに 10 分ほど掛かり、
 * 次の時刻が載る直前には 21 分 30 秒ほど前のものになる。そこから 2 回続けて更新が取れていない
 */
export const RISK_STALE_MS = 40 * 60_000;

/**
 * 次に時刻の表を取るまでのミリ秒。いまの 1 枚の次の時刻が表に載る頃 (判定の時刻 + 10 分 + 11 分 30 秒) に取り、
 * もう過ぎていれば (遅れている・まだ取れていない) 1 分後に取り直す
 */
export function nextRiskPoll(frame: RiskFrame | null, now: number): number {
  if (!frame) return RISK_RETRY_MS;
  const due = Date.parse(riskIso(frame)) + RISK_STEP_MS + RISK_PUBLISH_MS;
  const wait = due - now;
  return wait > 0
    ? Math.min(wait, RISK_STEP_MS + RISK_PUBLISH_MS)
    : RISK_RETRY_MS;
}

/** 判定が古いか (更新が取れていない) */
export const riskStale = (frame: RiskFrame, now: number) =>
  now - Date.parse(riskIso(frame)) > RISK_STALE_MS;

/**
 * 凡例 (危険度の高いものから)。色はタイルの PNG のパレットのまま (2026-11-21 に読んだ)。気象庁の配色の指針の
 * 表 1-1 (大雨の警戒レベルと相当する情報) の 12,0,12・170,0,170・255,40,0・242,231,0 と同じで、言葉はキキクルの
 * 画面の凡例のまま (「警戒レベル」は凡例の幅に収めるため「レベル」と書く)。いちばん低い「今後の情報等に留意」(白) はタイルでは透明で、塗らない
 */
export const RISK_LEGEND: { color: string; label: string; level: string }[] = [
  { color: "rgb(12 0 12)", label: "災害切迫", level: "レベル 5 相当" },
  { color: "rgb(170 0 170)", label: "危険", level: "レベル 4 相当" },
  { color: "rgb(255 40 0)", label: "警戒", level: "レベル 3 相当" },
  { color: "rgb(242 231 0)", label: "注意", level: "レベル 2 相当" },
];
