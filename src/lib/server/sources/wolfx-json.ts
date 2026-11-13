/**
 * Wolfx Open API の気象庁の緊急地震速報 (jma_eew) を読む。
 *
 * 仕様: Wolfx Open API Usage Guidelines (https://wolfx.jp/en/docs/open-api/) の
 * 「JMA Earthquake Early Warning JSON API」の項目の一覧と、WebSocket の説明
 * (https://wolfx.jp/en/docs/websocket/)。
 *
 * **原文 (`OriginalText`) は読まない・残さない** (Wolfx の規約で公開の再配布が禁じられている)。
 * 最大予測震度 (`MaxIntensity`・`WarnArea[].Shindo1/2`) も読まない (docs/design.md の 5 章)。
 */

import type { Status } from "#lib/model.ts";
import { jstToIso } from "#lib/server/time.ts";

import type { EewReport } from "./types.ts";

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
    warnAreas: (Array.isArray(o.WarnArea) ? o.WarnArea : [])
      .map(obj)
      .filter((a) => a.Type === "Warning")
      .map((a) => str(a.Chiiki))
      .filter((n): n is string => n !== undefined),
  };
  return {
    type: "eew",
    report,
    key: `${eventId}-${serial}${report.cancelled ? "-cancel" : ""}`,
  };
}
