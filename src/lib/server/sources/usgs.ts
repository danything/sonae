/**
 * USGS (米国地質調査所) の地震の GeoJSON フィード。M4.5 以上の 1 時間分を 60 秒ごとに取る。
 *
 * - フィードは毎分作り直され、`Cache-Control: max-age=60`。60 秒より短く取りに行かない
 * - 起動したときと、長く途切れた後に 1 回だけ 1 日分 (`4.5_day`) を読む
 * - 地震ごとに「id と更新の時刻」を鍵にする (続報で震源や M が直ったら、もう一度受ける)
 *
 * 仕様: https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php 。
 * U.S. Public Domain。出典は「Credit: U.S. Geological Survey」
 * (https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)。
 */

import type { ForeignReport } from "#lib/model.ts";

import { type PollOptions, pollSource } from "./poll.ts";
import type { Incoming, Source, SourceContext } from "./types.ts";

const FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";
export const USGS_FEED = `${FEED}/4.5_hour.geojson`;
export const USGS_DAY_FEED = `${FEED}/4.5_day.geojson`;

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** GeoJSON の 1 つの地震を、海外の地震の発表に読む。地震でないもの (爆破など) と読めないものは null */
export function readUsgsFeature(f: unknown): ForeignReport | null {
  if (typeof f !== "object" || f === null) return null;
  const o = f as Record<string, unknown>;
  const p = (o.properties ?? {}) as Record<string, unknown>;
  const g = (o.geometry ?? {}) as Record<string, unknown>;
  const coords = Array.isArray(g.coordinates) ? g.coordinates : [];
  const id = str(o.id);
  const time = num(p.time);
  const lon = num(coords[0]);
  const lat = num(coords[1]);
  if (!id || time === undefined || lon === undefined || lat === undefined)
    return null;
  if (p.type !== undefined && p.type !== "earthquake") return null;
  const updated = num(p.updated);
  return {
    source: "usgs",
    sourceId: id,
    url: str(p.url),
    originTime: new Date(time).toISOString(),
    lat,
    lon,
    depthKm: num(coords[2]),
    magnitude: num(p.mag),
    magType: str(p.magType),
    place: str(p.place) ?? str(p.title) ?? "",
    tsunami: p.tsunami === 1,
    updatedAt:
      updated === undefined ? undefined : new Date(updated).toISOString(),
  };
}

/** フィード 1 つを読む。形が違えば例外を投げる (その回を捨てる) */
export function parseUsgs(text: string): Incoming[] {
  const doc = JSON.parse(text) as Record<string, unknown>;
  if (doc.type !== "FeatureCollection" || !Array.isArray(doc.features))
    throw new Error("GeoJSON の FeatureCollection ではありません");
  return doc.features.flatMap((f): Incoming[] => {
    const r = readUsgsFeature(f);
    if (!r) return [];
    return [
      {
        source: "usgs",
        key: `${r.sourceId}@${r.updatedAt ?? r.originTime}`,
        code: "geojson",
        body: JSON.stringify(f),
        items: [{ type: "foreign", report: r }],
      },
    ];
  });
}

export function usgsSource(
  ctx: SourceContext,
  opts: Partial<PollOptions> = {},
): Source {
  return pollSource(ctx, {
    id: "usgs",
    url: USGS_FEED,
    backfillUrl: USGS_DAY_FEED,
    intervalMs: 60_000,
    minIntervalMs: 60_000,
    parse: parseUsgs,
    ...opts,
  });
}
