/** 画面の書き方。時刻はいつも日本時間で出す (気象庁の発表に合わせる) */

import type { Hypocenter, Quake, SourceId, Status } from "./model.ts";

const dateTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const fullDateTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const clock = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const valid = (iso: string | undefined): iso is string =>
  iso !== undefined && Number.isFinite(Date.parse(iso));

/** 「11/13 08:43」 */
export const jst = (iso: string | undefined) =>
  valid(iso) ? dateTime.format(new Date(iso)) : "—";
/** 「2026/11/13 08:43:12」 */
export const jstFull = (iso: string | undefined) =>
  valid(iso) ? fullDateTime.format(new Date(iso)) : "—";
/** 「08:43」(一覧の行の時刻) */
export const jstTime = (iso: string | undefined) => jstClock(iso).slice(0, 5);
/** 「08:43:12」 */
export const jstClock = (iso: string | undefined) =>
  valid(iso) ? clock.format(new Date(iso)) : "—";

export function depthText(h: Hypocenter | undefined): string {
  if (h?.depthKm === undefined) return "不明";
  return h.depthKm === 0 ? "ごく浅い" : `約 ${h.depthKm} km`;
}

/** 震源の名前。まだ決まっていなければ「震源は調査中」 */
export const placeName = (h: Hypocenter | undefined) =>
  h?.name ?? "震源は調査中";

/** 地震の名前。震源が決まる前 (震度速報だけ) は、震度を観測した最初の地域で「〜 など」 */
export const quakeName = (q: Pick<Quake, "hypocenter" | "areas">) =>
  q.hypocenter?.name ??
  (q.areas[0] ? `${q.areas[0].name} など` : placeName(undefined));

/** 訓練・試験の印 (通常は空) */
export const STATUS_LABEL: Record<Status, string> = {
  normal: "",
  training: "訓練",
  test: "試験",
};

/** 情報源の名前 (状態・発表された情報・緊急地震速報の帯) */
export const SOURCE_LABEL: Record<SourceId, string> = {
  jma: "気象庁 防災情報 XML",
  p2p: "P2P地震情報",
  wolfx: "Wolfx Project",
};

/** M の書き方 (「M3.5」)。M が無ければ電文の文のまま、それも無ければ「—」 */
export function magnitudeText(
  q: Pick<Quake, "magnitude" | "magnitudeText">,
): string {
  if (typeof q.magnitude === "number") return `M${q.magnitude.toFixed(1)}`;
  // 「Ｍ不明」「Ｍ８を超える巨大地震」は電文の文のまま
  return q.magnitudeText ?? "—";
}

/** 気象庁の「震度の色」(配色の指針 表 2-2) と、その上に置く字の色 */
export const INTENSITY_COLORS: Record<string, { bg: string; fg: string }> = {
  "7": { bg: "rgb(180 0 104)", fg: "#fff" },
  "6+": { bg: "rgb(165 0 33)", fg: "#fff" },
  "6-": { bg: "rgb(255 40 0)", fg: "#fff" },
  "5+": { bg: "rgb(255 153 0)", fg: "#000" },
  "5-": { bg: "rgb(255 230 0)", fg: "#000" },
  "5-?": { bg: "rgb(255 230 0)", fg: "#000" },
  "4": { bg: "rgb(250 230 150)", fg: "#000" },
  "3": { bg: "rgb(0 65 255)", fg: "#fff" },
  "2": { bg: "rgb(0 170 255)", fg: "#000" },
  "1": { bg: "rgb(242 242 255)", fg: "#000" },
};

/** 気象庁の「津波の色」(同じ指針の表 1-2)。津波予報は指針に無いので自分で決めた青系 */
export const TSUNAMI_COLORS: Record<string, { bg: string; fg: string }> = {
  major: { bg: "rgb(200 0 255)", fg: "#fff" },
  warning: { bg: "rgb(255 40 0)", fg: "#fff" },
  watch: { bg: "rgb(250 245 0)", fg: "#000" },
  forecast: { bg: "rgb(120 160 220)", fg: "#000" },
  none: { bg: "rgb(200 200 203)", fg: "#000" },
};

/**
 * 噴火警報・予報の色 (同じ指針の表 1-2)。段 (`volcanoLevel`) ごとに、5 は 200,0,255、4 は 255,40,0、
 * 3 は 255,170,0、2 は 250,245,0、1 は 242,242,255
 */
export const VOLCANO_COLORS: Record<number, { bg: string; fg: string }> = {
  5: { bg: "rgb(200 0 255)", fg: "#fff" },
  4: { bg: "rgb(255 40 0)", fg: "#fff" },
  3: { bg: "rgb(255 170 0)", fg: "#000" },
  2: { bg: "rgb(250 245 0)", fg: "#000" },
  1: { bg: "rgb(242 242 255)", fg: "#000" },
};

/**
 * 火山の種類の名前を短くする (「レベル３（入山規制）」→「レベル3 入山規制」)。
 * 全角の数字を半角に、終わりの全角の括弧を空白に替える
 */
export const volcanoKindText = (kind: string) =>
  kind
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/（([^（）]*)）$/, " $1")
    .trim();
