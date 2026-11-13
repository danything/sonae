/**
 * 新旧の判定 (docs/design.md の 2.2)。どれも「いまの姿」と「受けた 1 つの報」から次の姿を返す。
 * 何も変わらないなら null (重複・古い報・取消の後の報)。DB にも時計にも触らない。
 */

import type {
  Advisory,
  Eew,
  LongPeriod,
  Quake,
  QuakeReport,
  Status,
  Tsunami,
} from "#lib/model.ts";
import { intensityRank } from "#lib/model.ts";

import type {
  EewReport,
  LongPeriodReport,
  TsunamiReport,
} from "./sources/types.ts";
import { ms } from "./time.ts";

const union = <T>(a: readonly T[], b: readonly T[]) => [
  ...new Set([...a, ...b]),
];

/**
 * 緊急地震速報。鍵は地震識別番号。報数が今より大きいものだけを採る。同じ報数が別の情報源から
 * 来たら sources に足し、警報の地域は和を取る。取消を受けたら、その地震の速報はそこで終わり。
 */
export function mergeEew(
  prev: Eew | undefined,
  r: EewReport,
  now: string,
): Eew | null {
  const { source, ...fields } = r;
  if (!prev) return { ...fields, sources: [source], updatedAt: now };
  if (prev.cancelled) return null;
  if (r.cancelled) {
    if (r.serial < prev.serial) return null;
    return {
      ...prev,
      serial: r.serial,
      issuedAt: r.issuedAt,
      cancelled: true,
      sources: union(prev.sources, [source]),
      updatedAt: now,
    };
  }
  if (r.serial > prev.serial) {
    return {
      ...fields,
      // 一度出た警報は、取消でしか消えない。続報が予報の形で来ても警報のまま見せる
      kind: prev.kind === "warning" ? "warning" : r.kind,
      final: r.final || prev.final,
      warnAreas: union(prev.warnAreas, r.warnAreas),
      sources: union(prev.sources, [source]),
      updatedAt: now,
    };
  }
  if (r.serial === prev.serial) {
    const next: Eew = {
      ...prev,
      kind:
        prev.kind === "warning" || r.kind === "warning"
          ? "warning"
          : "forecast",
      final: prev.final || r.final,
      warnAreas: union(prev.warnAreas, r.warnAreas),
      sources: union(prev.sources, [source]),
    };
    const changed =
      next.kind !== prev.kind ||
      next.final !== prev.final ||
      next.warnAreas.length !== prev.warnAreas.length ||
      next.sources.length !== prev.sources.length;
    return changed ? { ...next, updatedAt: now } : null;
  }
  return null;
}

/** 同じ報を二度受けたか */
const sameReport = (a: QuakeReport, b: QuakeReport) =>
  a.source === b.source &&
  a.kind === b.kind &&
  a.code === b.code &&
  a.infoType === b.infoType &&
  a.reportedAt === b.reportedAt;

const byTime = (a: QuakeReport, b: QuakeReport) =>
  ms(a.reportedAt) - ms(b.reportedAt);

/** 報の並びから、いまの姿を組む。気象庁の XML の報があれば、そちらを正とする */
export function summarizeQuake(
  base: Pick<Quake, "id" | "eventId" | "status" | "updatedAt">,
  reports: QuakeReport[],
): Quake {
  const sorted = [...reports].sort(byTime);
  const live = sorted.filter((r) => !r.cancelled && r.infoType !== "取消");
  const jma = live.filter((r) => r.source === "jma");
  const pool = jma.length > 0 ? jma : live.filter((r) => r.source === "p2p");
  const latest = <K extends keyof QuakeReport>(k: K) =>
    pool.findLast((r) => r[k] !== undefined && r[k] !== null)?.[k];
  const withHypo = pool.findLast((r) => r.hypocenter !== undefined);
  const withInt = pool.findLast(
    (r) =>
      r.areas.length > 0 || r.stations.length > 0 || r.maxInt !== undefined,
  );
  const withStations = pool.findLast((r) => r.stations.length > 0);
  let maxInt = withInt?.maxInt;
  // 震度の最大は、地域・観測点の最大と食い違わないように大きいほうを採る
  for (const a of withInt?.areas ?? []) {
    if (maxInt === undefined || intensityRank(a.int) > intensityRank(maxInt))
      maxInt = a.int;
  }
  return {
    ...base,
    originTime:
      latest("originTime") ??
      sorted.find((r) => r.targetTime !== undefined)?.targetTime,
    hypocenter: withHypo?.hypocenter,
    magnitude: withHypo?.magnitude,
    magnitudeText: withHypo?.magnitudeText,
    maxInt,
    areas: withInt?.areas ?? [],
    stations: withStations?.stations ?? [],
    comments: pool.findLast((r) => r.comments.length > 0)?.comments ?? [],
    foreign: pool.some((r) => r.kind === "foreign"),
    cancelled: reports.length > 0 && live.length === 0,
    provisional: jma.length === 0,
    sources: union(
      [],
      sorted.map((r) => r.source),
    ),
    reports: sorted,
  };
}

/**
 * 地震情報。取消は一連の情報 (同じ種別) 全体を取り消す。同じ報の二度目は捨てる。
 * どの地震に結ぶかは store.ts が決める (地震識別番号、無ければ時刻)。
 */
export function mergeQuake(
  prev: Quake | undefined,
  r: QuakeReport,
  meta: { id: string; eventId?: string; status: Status },
  now: string,
): Quake | null {
  const reports = prev?.reports ?? [];
  if (reports.some((x) => sameReport(x, r))) return null;
  let next = [...reports];
  if (r.infoType === "取消") {
    next = next.map((x) =>
      x.source === r.source && x.code === r.code
        ? { ...x, cancelled: true }
        : x,
    );
  }
  next.push(r);
  return summarizeQuake(
    {
      id: prev?.id ?? meta.id,
      eventId: prev?.eventId ?? meta.eventId,
      status: prev?.status ?? meta.status,
      updatedAt: now,
    },
    next,
  );
}

/**
 * 番号が合わないときに同じ地震とみなす、発生の時刻 (震度速報は TargetDateTime) の差の上限。
 * 気象庁の文書に結び方の規則は無い (番号がずれうることだけが書かれている。docs/design.md の 9 章の 5)
 * ので、自前の値。震度速報の TargetDateTime は最初に検知した時刻で分までしか意味が無く
 * (地震火山関連 解説資料 Ⅰ-2)、震度速報は発生の約 1 分半後に出る (気象庁の解説)。
 * 分の切り捨て (最大 59 秒) と検知までの遅れを足しても収まる幅として 90 秒。
 */
export const LINK_WINDOW_MS = 90_000;

/**
 * 報と地震が同じ地震か (地震識別番号が合わないとき)。自動の電文 (震度速報) と手動の電文で
 * 番号が一致しないことがあるので、発生の時刻が近く、震度の地域が 1 つでも重なるもので結ぶ
 * (どちらかに地域が無ければ時刻だけ)。閾値は自前 (LINK_WINDOW_MS)。
 */
export function sameQuakeByTime(q: Quake, r: QuakeReport): boolean {
  const t = ms(r.originTime ?? r.targetTime);
  const qt = ms(q.originTime);
  if (!Number.isFinite(t) || !Number.isFinite(qt)) return false;
  if (Math.abs(t - qt) > LINK_WINDOW_MS) return false;
  if (r.areas.length === 0 || q.areas.length === 0) return true;
  const names = new Set(q.areas.map((a) => a.name));
  return r.areas.some((a) => names.has(a.name));
}

const highest = (t: Pick<Tsunami, "areas">) =>
  t.areas.some((a) => a.grade !== "none");

/**
 * 津波。VTSE41・VTSE51 の予報区の並びは、その時点の全部なので置き換える。観測は付け足す
 * (同じ観測点は新しいほうで置き換える)。P2P の 552 は、気象庁の XML が来るまでのつなぎ。
 */
export function mergeTsunami(
  prev: Tsunami | undefined,
  r: TsunamiReport,
  id: string,
  now: string,
): Tsunami | null {
  if (prev && r.source === "p2p" && !prev.provisional) return null;
  // 古い報は捨てる。ただし P2P のつなぎの上には、気象庁の XML を時刻に関わらず重ねる
  const replacesP2p = prev?.provisional === true && r.source === "jma";
  if (
    prev &&
    !replacesP2p &&
    ms(r.reportedAt) < ms(prev.issuedAt) &&
    r.code !== "VTSE52"
  )
    return null;
  if (
    prev &&
    r.reportedAt === prev.issuedAt &&
    r.source === "p2p" &&
    prev.sources.includes("p2p")
  )
    return null;
  const base: Tsunami = prev ?? {
    id,
    eventIds: [],
    status: r.status,
    issuedAt: r.reportedAt,
    areas: [],
    observations: [],
    cancelled: false,
    ended: false,
    provisional: true,
    sources: [],
    updatedAt: now,
  };
  if (r.infoType === "取消") {
    if (r.code === "VTSE52" || r.code === "VTSE51") {
      return {
        ...base,
        observations: base.observations.filter((o) =>
          r.code === "VTSE52" ? !o.offshore : o.offshore,
        ),
        updatedAt: now,
      };
    }
    return { ...base, cancelled: true, ended: true, updatedAt: now };
  }
  const observations = [...base.observations];
  for (const o of r.observations) {
    const i = observations.findIndex(
      (x) => x.station === o.station && x.offshore === o.offshore,
    );
    if (i >= 0) observations[i] = o;
    else observations.push(o);
  }
  const areas = r.areas ?? base.areas;
  // 気象庁の予報区の並びを受けたら、P2P のつなぎは終わり
  const jmaAreas = r.source === "jma" && r.areas !== undefined;
  const next: Tsunami = {
    ...base,
    eventIds: union(base.eventIds, r.eventIds),
    issuedAt: r.code === "VTSE52" ? base.issuedAt : r.reportedAt,
    headline: r.headline ?? base.headline,
    areas,
    observations,
    ended: !highest({ areas }),
    provisional: base.provisional && !jmaAreas,
    sources: union(base.sources, [r.source]),
    updatedAt: now,
  };
  return next;
}

/** お知らせ。同じ番号の新しい報で置き換え、取消で無効にする */
export function mergeAdvisory(
  prev: Advisory | undefined,
  a: Omit<Advisory, "updatedAt" | "cancelled">,
  now: string,
): Advisory | null {
  if (prev && ms(a.reportedAt) < ms(prev.reportedAt)) return null;
  if (prev && a.reportedAt === prev.reportedAt && a.infoType === prev.infoType)
    return null;
  if (a.infoType === "取消") {
    if (!prev) return { ...a, cancelled: true, updatedAt: now };
    return {
      ...prev,
      infoType: "取消",
      reportedAt: a.reportedAt,
      cancelled: true,
      updatedAt: now,
    };
  }
  return { ...a, cancelled: false, updatedAt: now };
}

/**
 * 長周期地震動に関する観測情報。報は観測の全体をまるごと持つので、新しい報で置き換える
 * (続報で地域が足されたり階級が直されたりする。解説資料の Revise)。古い報と同じ報は捨てる。
 * 取消は、前の報の中身を残して取消の印を付ける
 */
export function mergeLongPeriod(
  prev: LongPeriod | undefined,
  r: LongPeriodReport,
  id: string,
  now: string,
): LongPeriod | null {
  if (prev && ms(r.reportedAt) < ms(prev.reportedAt)) return null;
  if (prev && r.reportedAt === prev.reportedAt && r.infoType === prev.infoType)
    return null;
  if (r.infoType === "取消") {
    const base = prev ?? { ...r, id };
    return {
      ...base,
      id,
      infoType: "取消",
      reportedAt: r.reportedAt,
      cancelled: true,
      updatedAt: now,
    };
  }
  return { ...r, id, cancelled: false, updatedAt: now };
}
