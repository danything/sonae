/**
 * GeoNet (ニュージーランド) の地震の API (`https://api.geonet.org.nz/quake?MMI=4`)。
 * ニュージーランドで改正メルカリ震度 4 以上が見込まれた地震 (新しい 100 件まで) を 2 分ごとに取る。
 *
 * - `Accept: application/vnd.geo+json;version=2` を付ける。`If-None-Match`・`If-Modified-Since` も付ける
 * - 取り消された地震 (`quality` が `deleted`) は採らない
 * - 鍵は publicID・時刻・M・位置 (更新の時刻が無いので、値が変わったら別の鍵にする)
 *
 * 仕様: https://api.geonet.org.nz/ 。CC BY 3.0 NZ。出典は GeoNet の求める謝辞の文
 * (https://www.geonet.org.nz/policy)。
 */

import type { ForeignReport } from "#lib/model.ts";

import { type PollOptions, pollSource } from "./poll.ts";
import type { Incoming, Source, SourceContext } from "./types.ts";

export const GEONET_URL = "https://api.geonet.org.nz/quake?MMI=4";

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** GeoJSON を読む。形が違えば例外 (その回を捨てる) */
export function parseGeonet(text: string): Incoming[] {
  const doc = JSON.parse(text) as Record<string, unknown>;
  if (doc.type !== "FeatureCollection" || !Array.isArray(doc.features))
    throw new Error("GeoJSON の FeatureCollection ではありません");
  return doc.features.flatMap((f): Incoming[] => {
    if (typeof f !== "object" || f === null) return [];
    const o = f as Record<string, unknown>;
    const p = (o.properties ?? {}) as Record<string, unknown>;
    const g = (o.geometry ?? {}) as Record<string, unknown>;
    const c = Array.isArray(g.coordinates) ? g.coordinates : [];
    const id = str(p.publicID);
    const time = str(p.time);
    const lon = num(c[0]);
    const lat = num(c[1]);
    if (!id || !time || lat === undefined || lon === undefined) return [];
    if (!Number.isFinite(Date.parse(time)) || p.quality === "deleted")
      return [];
    const mag = num(p.magnitude);
    const depth = num(p.depth);
    const report: ForeignReport = {
      source: "geonet",
      sourceId: id,
      url: /^[0-9a-z]+$/i.test(id)
        ? `https://www.geonet.org.nz/earthquake/${id}`
        : undefined,
      originTime: new Date(time).toISOString(),
      lat,
      lon,
      depthKm: depth,
      magnitude: mag === undefined ? undefined : Math.round(mag * 10) / 10,
      place: str(p.locality) ?? "New Zealand",
    };
    const r1 = (v: number | undefined) => (v === undefined ? "" : v.toFixed(1));
    return [
      {
        source: "geonet",
        key: `${id}@${report.originTime}:${r1(mag)}:${lat.toFixed(2)}:${lon.toFixed(2)}:${r1(depth)}`,
        code: "geojson",
        body: JSON.stringify(f),
        items: [{ type: "foreign", report }],
      },
    ];
  });
}

export function geonetSource(
  ctx: SourceContext,
  opts: Partial<PollOptions> = {},
): Source {
  return pollSource(ctx, {
    id: "geonet",
    url: GEONET_URL,
    intervalMs: 120_000,
    minIntervalMs: 60_000,
    headers: { accept: "application/vnd.geo+json;version=2" },
    parse: parseGeonet,
    ...opts,
  });
}
