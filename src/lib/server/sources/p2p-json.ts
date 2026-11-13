/**
 * P2P地震情報 API v2 の JSON (551 地震情報・552 津波予報・556 緊急地震速報 (警報)) を読む。
 *
 * 仕様: P2P地震情報 API 仕様書 v2.3.0 (https://www.p2pquake.net/develop/json_api_v2/ 、
 * OpenAPI は https://www.p2pquake.net/swagger-ui/specification.yaml)。
 * 欠けた値は -200 (緯度・経度)・-1 (深さ・M・震度) で来るので、無いものとして扱う。
 */

import type {
  AreaIntensity,
  Hypocenter,
  ObservedIntensity,
  QuakeKind,
  QuakeReport,
  StationIntensity,
  TsunamiArea,
  TsunamiGrade,
} from "#lib/model.ts";
import { jstToIso } from "#lib/server/time.ts";

import type { Normalized } from "./types.ts";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const SCALES: Record<number, ObservedIntensity> = {
  10: "1",
  20: "2",
  30: "3",
  40: "4",
  45: "5-",
  46: "5-?",
  50: "5+",
  55: "6-",
  60: "6+",
  70: "7",
};
export const p2pScale = (v: unknown): ObservedIntensity | undefined =>
  typeof v === "number" ? SCALES[Math.trunc(v)] : undefined;

const KINDS: Record<string, QuakeKind> = {
  ScalePrompt: "scale",
  Destination: "hypocenter",
  ScaleAndDestination: "detail",
  DetailScale: "detail",
  Foreign: "foreign",
  Other: "other",
};

const DOMESTIC_TSUNAMI: Record<string, string> = {
  None: "この地震による津波の心配はありません。",
  Checking: "津波の有無を調査中です。",
  NonEffective: "若干の海面変動が予想されますが、被害の心配はありません。",
  Watch: "津波注意報を発表しています。",
  Warning: "津波予報を発表しています。",
};

function hypocenterOf(h: Json): Hypocenter | undefined {
  const name = str(h.name);
  if (!name) return undefined;
  const lat = num(h.latitude);
  const lon = num(h.longitude);
  const depth = num(h.depth);
  const located = lat !== undefined && lat > -200 && lon !== undefined;
  return {
    name,
    lat: located ? lat : undefined,
    lon: located ? lon : undefined,
    depthKm: depth !== undefined && depth >= 0 ? Math.trunc(depth) : undefined,
  };
}

const magnitudeOf = (v: unknown) => {
  const m = num(v);
  return m !== undefined && m >= 0 ? m : undefined;
};

function quake(o: Json): Normalized[] {
  const issue = obj(o.issue);
  const eq = obj(o.earthquake);
  const reportedAt = jstToIso(issue.time);
  if (!reportedAt) return [];
  const kind = KINDS[str(issue.type) ?? ""] ?? "other";
  const areas: AreaIntensity[] = [];
  const stations: StationIntensity[] = [];
  for (const p of arr(o.points).map(obj)) {
    const int = p2pScale(p.scale);
    const name = str(p.addr);
    if (!int || !name) continue;
    const item = { name, pref: str(p.pref), int };
    (p.isArea === true ? areas : stations).push(item);
  }
  const comments: string[] = [];
  const tsunami = DOMESTIC_TSUNAMI[str(eq.domesticTsunami) ?? ""];
  if (tsunami) comments.push(tsunami);
  const free = str(obj(o.comments).freeFormComment);
  if (free) comments.push(free);
  const report: QuakeReport = {
    kind,
    source: "p2p",
    infoType: "発表",
    reportedAt,
    originTime: jstToIso(eq.time),
    hypocenter: hypocenterOf(obj(eq.hypocenter)),
    magnitude: magnitudeOf(obj(eq.hypocenter).magnitude),
    maxInt: p2pScale(eq.maxScale),
    areas,
    stations,
    comments,
  };
  return [{ type: "quake", status: "normal", report }];
}

const GRADES: Record<string, TsunamiGrade> = {
  MajorWarning: "major",
  Warning: "warning",
  Watch: "watch",
};
const GRADE_NAMES: Record<string, string> = {
  MajorWarning: "大津波警報",
  Warning: "津波警報",
  Watch: "津波注意報",
  Unknown: "種類不明",
};

function tsunami(o: Json): Normalized[] {
  const issue = obj(o.issue);
  const reportedAt = jstToIso(issue.time);
  if (!reportedAt) return [];
  const areas: TsunamiArea[] =
    o.cancelled === true
      ? []
      : arr(o.areas)
          .map(obj)
          .flatMap((a): TsunamiArea[] => {
            const name = str(a.name);
            if (!name) return [];
            const g = str(a.grade) ?? "Unknown";
            const first = obj(a.firstHeight);
            return [
              {
                name,
                // 種類が分からないものは、軽く見せないよう注意報として扱う
                grade: GRADES[g] ?? "watch",
                kindName: GRADE_NAMES[g] ?? g,
                immediate: a.immediate === true || undefined,
                arrivalTime: jstToIso(first.arrivalTime),
                condition: str(first.condition),
                maxHeightText: str(obj(a.maxHeight).description),
              },
            ];
          });
  return [
    {
      type: "tsunami",
      report: {
        code: "P2P552",
        source: "p2p",
        eventIds: [],
        status: "normal",
        infoType: "発表",
        reportedAt,
        areas,
        observations: [],
      },
    },
  ];
}

function eew(o: Json): Normalized[] {
  const issue = obj(o.issue);
  const eventId = str(issue.eventId);
  const serial = Number(issue.serial);
  const issuedAt = jstToIso(issue.time);
  if (!eventId || !Number.isFinite(serial) || !issuedAt) return [];
  const eq = obj(o.earthquake);
  const h = obj(eq.hypocenter);
  return [
    {
      type: "eew",
      report: {
        source: "p2p",
        eventId,
        serial,
        issuedAt,
        // P2P の 556 は緊急地震速報 (警報) だけを流す
        kind: "warning",
        final: false,
        cancelled: o.cancelled === true,
        status: o.test === true ? "test" : "normal",
        assumed: str(eq.condition) === "仮定震源要素",
        originTime: jstToIso(eq.originTime),
        hypocenter: hypocenterOf(h),
        magnitude: magnitudeOf(h.magnitude),
        // 予測震度 (scaleFrom・scaleTo) と到達予測時刻は読まない (docs/design.md の 5 章)
        warnAreas: arr(o.areas)
          .map((a) => str(obj(a).name))
          .filter((n): n is string => n !== undefined),
      },
    },
  ];
}

/** P2P の 1 件を読む。扱わない code (感知情報など) は空の並び */
export function parseP2p(value: unknown): Normalized[] {
  const o = obj(value);
  switch (o.code) {
    case 551:
      return quake(o);
    case 552:
      return tsunami(o);
    case 556:
      return eew(o);
    default:
      return [];
  }
}

/** 受けて扱う code。張り直したときの埋め直しもこれで絞る */
export const P2P_CODES = [551, 552, 556] as const;
