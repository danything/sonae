/**
 * Wolfx Open API の気象庁の緊急地震速報 (jma_eew) と地震情報の一覧 (jma_eqlist、下) を読む。
 *
 * 仕様: Wolfx Open API 利用ガイド (https://wolfx.jp/docs/open-api) の「気象庁 緊急地震速報 JSON API」の
 * 項目の一覧と公式の応答の例 (https://wolfx.jp/examples/jma_eew/)、WebSocket の説明 (https://wolfx.jp/docs/websocket)。
 * 日本語の文書が正で、英語の文書は 2026-11-25 まで `WarnArea[].Type` を違って書いていた。
 *
 * **原文 (`OriginalText`) は読まない・残さない** (中身は気象庁の電文で、Wolfx の規約の五条で気象庁の条件に従う。配り直してよいと確かめられない。docs/design.md の 5 章)。
 * 最大予測震度 (`MaxIntensity`・`WarnArea[].Shindo1/2`) も読まない (docs/design.md の 5 章)。
 */

import {
  isIntensity,
  type ObservedIntensity,
  type QuakeKind,
  type QuakeReport,
} from "#lib/model.ts";
import { jstToIso } from "#lib/server/time.ts";

import { STATUS } from "./jma-xml.ts";
import type { EewReport, Normalized, QuakeIncoming } from "./types.ts";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

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

/**
 * 警報の地域か (`WarnArea[].Type`)。実際の JSON と公式の例は `警報`・`予報` で来る
 * (日本語の文書もそう書く)。英語の文書は 2026-11-25 まで `Warning`・`Forecast` と書いていたので、そちらも受ける
 */
const isWarningArea = (a: Json) => a.Type === "警報" || a.Type === "Warning";

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
  // Magunitude は古い綴りで、同じ値 (いずれ無くなる)
  const magnitude = num(o.Magnitude) ?? num(o.Magunitude);
  // レベル法 (最大予測震度だけの速報) は震源が地方の名前だけで、M は 0、深さは 10 km の仮の値。
  // 仮定震源要素は M が 1.0、深さが 10 km の決まった値。M が 0 なのは値が無いときの互換の値
  // (Wolfx の文書、2026-11-15)。どれも実際の値ではないので、M と深さを持たない
  const level = str(o.CodeType)?.includes("最大予測震度のみ") === true;
  const assumed = o.isAssumption === true || level;
  const placeholder = assumed || magnitude === 0;
  const report: EewReport = {
    source: "wolfx",
    eventId,
    serial,
    issuedAt,
    kind: o.isWarn === true ? "warning" : "forecast",
    final: o.isFinal === true,
    cancelled: o.isCancel === true,
    status: o.isTraining === true ? "training" : issueStatus,
    assumed,
    originTime: jstToIso(o.OriginTime),
    hypocenter: name
      ? {
          name,
          lat: num(o.Latitude),
          lon: num(o.Longitude),
          depthKm:
            !placeholder && depth !== undefined && depth >= 0
              ? depth
              : undefined,
        }
      : undefined,
    magnitude: placeholder ? undefined : magnitude,
    warnAreas: names(o.WarnArea, isWarningArea),
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

/** 南海トラフ・北海道・三陸沖の情報の電文の種別 (`jma_special_eq` の `reports[].product`) */
const SPECIAL_PRODUCTS = ["VYSE50", "VYSE51", "VYSE52", "VYSE60"] as const;
type SpecialProduct = (typeof SPECIAL_PRODUCTS)[number];
const isSpecialProduct = (v: unknown): v is SpecialProduct =>
  (SPECIAL_PRODUCTS as readonly unknown[]).includes(v);

const SPECIAL_INFO_TYPE = {
  issued: "発表",
  corrected: "訂正",
  cancelled: "取消",
} as const;

export interface WolfxAdvisory {
  /** 情報源の中での重複の除去の鍵。電文の種別・Wolfx の報告の ID・状態 */
  key: string;
  item: Extract<Normalized, { type: "advisory" }>;
}

/**
 * 南海トラフ地震臨時情報など (jma_special_eq) を読む。気象庁 XML の VYSE50・51・52・60 の予備
 * (docs/design.md の 2.2 の「お知らせ」)。電文の種別ごとに、いちばん新しい報だけが来る。
 *
 * - お知らせの id は気象庁 XML と同じ `<種別>-<地震識別番号>` にし、XML と同じ報なら 1 つにまとめる (merge.ts)
 * - 見出し (Headline) は来ないので空にする。通知の本文は本文の最初の段落にする (notify.ts)
 * - 訓練・試験の印は無い。表題に「訓練」「試験」とあるものは、そう扱う (本番として知らせないため)。
 *   本文の語では決めない (本番の解説の文に「訓練」の語が出ても、知らせなくならないように)
 * - 補足 (`notice`。取消の説明など) は本文の後ろに、次の発表の予定 (`next`) はそのまま持つ。
 *   参考解説 (`appendices`) は気象庁 XML の Appendix と同じく読まない
 */
export function parseWolfxSpecialEq(value: unknown): WolfxAdvisory[] {
  const o = obj(value);
  const out: WolfxAdvisory[] = [];
  for (const r of (Array.isArray(o.reports) ? o.reports : []).map(obj)) {
    const code = r.product;
    if (!isSpecialProduct(code)) continue;
    const reportedAt = str(r.time);
    if (!reportedAt || !Number.isFinite(Date.parse(reportedAt))) continue;
    const infoType =
      SPECIAL_INFO_TYPE[str(r.status) as keyof typeof SPECIAL_INFO_TYPE] ??
      "発表";
    const eventId =
      (Array.isArray(r.eventIds) ? r.eventIds.map(str) : []).find(
        (v): v is string => v !== undefined,
      ) ?? reportedAt;
    const title = str(r.title) ?? str(r.kind) ?? code;
    const text = [str(r.text), str(r.notice)].filter(Boolean).join("\n\n");
    out.push({
      key: `special-${code}-${str(r.id) ?? reportedAt}-${infoType}`,
      item: {
        type: "advisory",
        advisory: {
          id: `${code}-${eventId}`,
          code,
          source: "wolfx",
          eventId,
          title,
          serialName: str(r.label),
          status: title.includes("訓練")
            ? "training"
            : title.includes("試験")
              ? "test"
              : "normal",
          infoType,
          reportedAt,
          headline: "",
          text,
          next: str(r.next),
        },
      },
    });
  }
  return out;
}
