/**
 * Wolfx Open API の気象庁の緊急地震速報 (jma_eew) と地震情報の一覧 (jma_eqlist、下) を読む。
 *
 * 仕様: Wolfx Open API Usage Guidelines (https://wolfx.jp/en/docs/open-api/) の
 * 「JMA Earthquake Early Warning JSON API」の項目の一覧と、WebSocket の説明
 * (https://wolfx.jp/en/docs/websocket/)。
 *
 * **原文 (`OriginalText`) は読まない・残さない** (中身は気象庁の電文で、Wolfx の規約の五条で気象庁の条件に従う。配り直してよいと確かめられない。docs/design.md の 5 章)。
 * 最大予測震度 (`MaxIntensity`・`WarnArea[].Shindo1/2`) も読まない (docs/design.md の 5 章)。
 */

import {
  isIntensity,
  type ObservedIntensity,
  type QuakeKind,
  type QuakeReport,
  type Status,
} from "#lib/model.ts";
import { jstToIso } from "#lib/server/time.ts";

import type { EewReport, QuakeIncoming } from "./types.ts";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const STATUS: Record<string, Status> = {
  通常: "normal",
  訓練: "training",
  試験: "test",
};

export type WolfxMessage =
  | { type: "heartbeat" }
  | { type: "pong" }
  | { type: "eew"; report: EewReport; key: string }
  | { type: "unknown" };

/** `WarnArea` のうち、`keep` に合う地域の名前 (`Chiiki`) */
const names = (v: unknown, keep: (a: Json) => boolean): string[] =>
  (Array.isArray(v) ? v : [])
    .map(obj)
    .filter(keep)
    .map((a) => str(a.Chiiki))
    .filter((n): n is string => n !== undefined);

/** WebSocket の 1 通 (または HTTP の jma_eew.json) を読む */
export function parseWolfx(value: unknown): WolfxMessage {
  const o = obj(value);
  if (o.type === "heartbeat") return { type: "heartbeat" };
  if (o.type === "pong") return { type: "pong" };
  // HTTP の jma_eew.json には type が無い
  if (o.type !== undefined && o.type !== "jma_eew") return { type: "unknown" };
  const eventId = str(o.EventID);
  const serial = num(o.Serial);
  const issuedAt = jstToIso(o.AnnouncedTime);
  if (!eventId || serial === undefined || !issuedAt) return { type: "unknown" };
  const issueStatus = STATUS[str(obj(o.Issue).Status) ?? ""] ?? "normal";
  const name = str(o.Hypocenter);
  const depth = num(o.Depth);
  const report: EewReport = {
    source: "wolfx",
    eventId,
    serial,
    issuedAt,
    kind: o.isWarn === true ? "warning" : "forecast",
    final: o.isFinal === true,
    cancelled: o.isCancel === true,
    status: o.isTraining === true ? "training" : issueStatus,
    assumed: o.isAssumption === true,
    originTime: jstToIso(o.OriginTime),
    hypocenter: name
      ? {
          name,
          lat: num(o.Latitude),
          lon: num(o.Longitude),
          depthKm: depth !== undefined && depth >= 0 ? depth : undefined,
        }
      : undefined,
    // Magunitude は古い綴りで、同じ値 (いずれ無くなる)
    magnitude: num(o.Magnitude) ?? num(o.Magunitude),
    warnAreas: names(o.WarnArea, (a) => a.Type === "Warning"),
    // 予報の地域も含めた全部 (名前だけ。Shindo1/2 は読まない)。通知の「住んでいる地域と現在地」の判定に使う
    areas: names(o.WarnArea, () => true),
  };
  return {
    type: "eew",
    report,
    key: `${eventId}-${serial}${report.cancelled ? "-cancel" : ""}`,
  };
}

/**
 * 地震情報の一覧 (jma_eqlist) の 1 件の見出し (`Title`)。気象庁ホームページの地震情報の一覧と
 * 同じ見出しで来る。分からない見出しは「その他」にする
 */
const EQ_KINDS: Record<string, QuakeKind> = {
  震度速報: "scale",
  震源に関する情報: "hypocenter",
  "震源・震度情報": "detail",
  "震源・震度に関する情報": "detail",
  遠地地震に関する情報: "foreign",
  顕著な地震の震源要素更新のお知らせ: "update",
};

/** 「5弱」「5-」「５－」などを気象庁の XML の書き方 (`5-`) にする。読めなければ undefined */
export function wolfxShindo(v: unknown): ObservedIntensity | undefined {
  const s = str(v)
    ?.normalize("NFKC")
    .replace(/弱|−|－|ー/g, "-")
    .replace(/強/g, "+")
    .trim();
  return isIntensity(s) ? s : undefined;
}

/** 数字の文字列 (「3.4」「-200」でない緯度など)。読めなければ undefined */
const decimal = (v: unknown) => {
  const s = str(v)?.normalize("NFKC").trim();
  return s !== undefined && /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : undefined;
};

/** 「40km」「ごく浅い」。読めなければ undefined */
function depthOf(v: unknown) {
  const s = str(v)?.normalize("NFKC").trim();
  if (s === "ごく浅い") return 0;
  const m = s === undefined ? null : /^(\d+)\s*km$/i.exec(s);
  return m ? Number(m[1]) : undefined;
}

export interface WolfxQuake {
  /** 情報源の中での重複の除去の鍵。地震識別番号と中身の要約 (続報で中身が変われば別の鍵になる) */
  key: string;
  item: QuakeIncoming;
}

/**
 * 地震情報の一覧 (jma_eqlist) を読む。一覧は気象庁の最新の 50 件 (`No1`〜`No50`、新しい順) を
 * 毎回まるごと持ち、1 件は 1 つの地震のいまの姿 (続報が出ると同じ地震の行が書き換わる)。
 *
 * - 発表の時刻が無いので、受けた時刻 (`receivedAt`) を報の時刻にする
 * - 地震識別番号 (`EventID`) は文書の項目の一覧に無いが、実際の JSON にある (2026-11-16 に確かめた)。
 *   あれば使い、無ければ発生の時刻で結ぶ (store.ts)
 * - 訓練・試験の印が無いので、P2P の 551 と同じく本番 (`normal`) として持つ
 *
 * 古い順に並べて返す (store に古い順に入れるため)。
 */
export function parseWolfxEqlist(
  value: unknown,
  receivedAt: string,
): WolfxQuake[] {
  const o = obj(value);
  const out: WolfxQuake[] = [];
  for (let i = 50; i >= 1; i--) {
    const e = obj(o[`No${i}`]);
    const originTime = jstToIso(e.time_full) ?? jstToIso(e.time);
    if (!originTime) continue;
    const title = str(e.Title) ?? "";
    const name = str(e.location);
    const lat = decimal(e.latitude);
    const lon = decimal(e.longitude);
    const located = lat !== undefined && lon !== undefined;
    const info = str(e.info);
    const report: QuakeReport = {
      kind: EQ_KINDS[title] ?? "other",
      source: "wolfx",
      infoType: "発表",
      reportedAt: receivedAt,
      originTime,
      hypocenter: name
        ? {
            name,
            lat: located ? lat : undefined,
            lon: located ? lon : undefined,
            depthKm: depthOf(e.depth),
          }
        : undefined,
      magnitude: decimal(e.magnitude),
      maxInt: wolfxShindo(e.shindo),
      areas: [],
      stations: [],
      comments: info ? [info] : [],
    };
    const eventId = str(e.EventID);
    // 中身が前と同じ行は鍵も同じになり、もう受けた鍵として捨てられる
    const digest = Bun.hash(
      JSON.stringify([
        title,
        originTime,
        name,
        e.magnitude,
        e.shindo,
        e.depth,
        e.latitude,
        e.longitude,
        info,
      ]),
    ).toString(16);
    out.push({
      key: `eqlist-${eventId ?? originTime}-${digest}`,
      item: { type: "quake", eventId, status: "normal", report },
    });
  }
  return out;
}
