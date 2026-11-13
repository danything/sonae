/**
 * 台湾の中央氣象署 (CWA) のオープンデータ「顯著有感地震報告」(E-A0015-001)。台湾付近の地震 (与那国・沖縄に近い)。
 *
 * - 授権碼 (会員登録で発行される鍵) が要る。環境変数 `CWA_API_KEY` が無ければ、この情報源は作らない
 *   (ほかは普段どおり。登録の手順は docs/cwa.md)
 * - 新しい 10 件を 2 分ごとに取る。鍵は地震の番号 (EarthquakeNo) と時刻・M・位置
 * - 時刻 (OriginTime) は台湾の時刻 (UTC+8) で、時差の印が無い
 *
 * 仕様: https://opendata.cwa.gov.tw/dist/opendata-swagger.html 。政府資料開放授權條款 第 1 版
 * (https://data.gov.tw/license。CC BY 4.0 と両立)。出典の表示が要る。
 * **授権碼が無いので、実物では確かめていない** (形は仕様の項目の名前に合わせた)。
 */

import type { ForeignReport } from "#lib/model.ts";

import { type PollOptions, pollSource } from "./poll.ts";
import type { Incoming, Source, SourceContext } from "./types.ts";

export const CWA_URL =
  "https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0015-001";

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;
const str = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** 「2026-11-13 10:20:30」(台湾の時刻) を ISO 8601 (UTC) に。時差が付いていればそれに従う */
export function cwaTime(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim().replace(" ", "T");
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}+08:00`;
  const t = Date.parse(withZone);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** 応答を読む。形が違えば例外 (その回を捨てる) */
export function parseCwa(text: string): Incoming[] {
  const doc = JSON.parse(text) as Record<string, unknown>;
  if (doc.success !== "true" && doc.success !== true)
    throw new Error("CWA の応答が success ではありません");
  const records = (doc.records ?? {}) as Record<string, unknown>;
  const list = records.Earthquake;
  if (!Array.isArray(list)) throw new Error("records.Earthquake がありません");
  return list.flatMap((e): Incoming[] => {
    if (typeof e !== "object" || e === null) return [];
    const o = e as Record<string, unknown>;
    const info = (o.EarthquakeInfo ?? {}) as Record<string, unknown>;
    const epi = (info.Epicenter ?? {}) as Record<string, unknown>;
    const mag = (info.EarthquakeMagnitude ?? {}) as Record<string, unknown>;
    const no = num(o.EarthquakeNo);
    const time = cwaTime(str(info.OriginTime));
    const lat = num(epi.EpicenterLatitude);
    const lon = num(epi.EpicenterLongitude);
    if (no === undefined || !time || lat === undefined || lon === undefined)
      return [];
    const m = num(mag.MagnitudeValue);
    const depth = num(info.FocalDepth);
    const web = str(o.Web);
    const report: ForeignReport = {
      source: "cwa",
      sourceId: String(no),
      // 画面にリンクとして出すので、CWA の https だけを採る
      url:
        web && /^https:\/\/[a-z0-9.-]*cwa\.gov\.tw\//.test(web)
          ? web
          : undefined,
      originTime: time,
      lat,
      lon,
      depthKm: depth,
      magnitude: m,
      magType: str(mag.MagnitudeType),
      place: str(epi.Location) ?? "台湾付近",
    };
    return [
      {
        source: "cwa",
        key: `${no}@${time}:${m ?? ""}:${lat}:${lon}`,
        code: "E-A0015-001",
        body: JSON.stringify(e),
        items: [{ type: "foreign", report }],
      },
    ];
  });
}

/** 授権碼があれば CWA の情報源を作る。無ければ undefined (受信の一覧に入れない) */
export function cwaSource(
  ctx: SourceContext,
  key: string | undefined = process.env.CWA_API_KEY,
  opts: Partial<PollOptions> = {},
): Source | undefined {
  if (!key?.trim()) return undefined;
  // 授権碼は仕様のとおり query の Authorization で渡す。取りに行く輪は、ログと状態の欄で鍵を伏せる (poll.ts の redact)
  const url = `${CWA_URL}?${new URLSearchParams({
    Authorization: key.trim(),
    format: "JSON",
    limit: "10",
  })}`;
  return pollSource(ctx, {
    id: "cwa",
    url,
    intervalMs: 120_000,
    minIntervalMs: 60_000,
    headers: { accept: "application/json" },
    parse: parseCwa,
    ...opts,
  });
}
