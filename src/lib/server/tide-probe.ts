/**
 * 気象庁 bosai の潮位観測情報 (tidelevel) の遅れを測る (docs/design.md の「潮位観測情報を測った結果」)。
 *
 * - 津波の警報・注意報の間、震度 5 弱以上か津波に触れたコメントのある地震から 2 時間、波浪警報の間だけ動く
 * - 動いている間は `tide_time.json` だけを 1 分ごとに取る (`If-None-Match`・`If-Modified-Since` を付ける)。
 *   検潮所ごとの値は取らない
 * - 中の時刻が変わったら 1 行を `tide_latency` に足し、`tide-latency` で始まる 1 行をログに出力する
 * - 画面・通知には出さない。失敗してもほかの受信には響かない。`SONAE_TIDE_PROBE=off` で切る
 */

import type { Database } from "bun:sqlite";

import {
  intensityRank,
  type Quake,
  type Tsunami,
  type WeatherWarning,
} from "#lib/model.ts";

import { sleep, USER_AGENT } from "./sources/retry.ts";

export const TIDE_TIME_URL =
  "https://www.jma.go.jp/bosai/tidelevel/data/tide/tide_time.json";

/** 動かす理由。津波の警報・注意報 (tsunami)・大きな地震の後 (quake)・波浪警報 (wave) */
export type TideTrigger = "tsunami" | "quake" | "wave";

/** 地震の後に測る時間 */
export const QUAKE_WINDOW_MS = 2 * 60 * 60_000;
/** 残す期間と行の数 */
const KEEP_DAYS = 90;
export const KEEP_ROWS = 10_000;
/** 前に取れた時刻からこれより空いていれば、その回の「取った時刻からの遅れ」は更新の時刻を表さない */
const GAP_MS = 90_000;

/** 動かすかを決めるのに使う、いまの状態 */
export interface ProbeState {
  tsunamis: readonly Tsunami[];
  quakes: readonly Quake[];
  warnings: readonly WeatherWarning[];
}

/**
 * 津波に触れたコメントか。「津波の心配はありません」「津波の影響はありません」は外す。
 * 「若干の海面変動」は入れる
 */
export function tsunamiComment(c: string): boolean {
  if (!/津波|海面変動/.test(c)) return false;
  return !/津波の(心配|影響)はありません/.test(c);
}

const QUAKE_5_LOWER = intensityRank("5-");

/** いま動かす理由。無ければ空 */
export function tideTriggers(s: ProbeState, now: number): TideTrigger[] {
  const out: TideTrigger[] = [];
  // 大津波警報・津波警報・津波注意報のどれかが、どこかの予報区に出ている (津波予報だけなら入れない)
  if (
    s.tsunamis.some(
      (t) =>
        t.status === "normal" &&
        !t.ended &&
        !t.cancelled &&
        t.areas.some(
          (a) =>
            a.grade === "major" || a.grade === "warning" || a.grade === "watch",
        ),
    )
  )
    out.push("tsunami");
  if (
    s.quakes.some((q) => {
      if (q.status !== "normal" || q.cancelled) return false;
      const at = Date.parse(q.originTime ?? q.updatedAt);
      if (!Number.isFinite(at) || now - at >= QUAKE_WINDOW_MS) return false;
      const strong =
        q.maxInt !== undefined && intensityRank(q.maxInt) >= QUAKE_5_LOWER;
      return strong || q.comments.some(tsunamiComment);
    })
  )
    out.push("quake");
  // 波浪 (VPWW59) で警報以上 (波浪警報・波浪特別警報) がどこかの市町村等に出ている
  if (
    s.warnings.some(
      (w) =>
        w.status === "normal" &&
        w.code === "VPWW59" &&
        w.areas.some((a) => a.kinds.some((k) => k.level >= 3)),
    )
  )
    out.push("wave");
  return out;
}

/** `tide_time.json` の時刻をミリ秒で。読めなければ例外 */
export function parseTideTime(text: string): number {
  const v: unknown = JSON.parse(text);
  const time =
    v && typeof v === "object" && "time" in v
      ? (v as { time: unknown }).time
      : undefined;
  // 気象庁の書き方は `2026-11-16T19:14:45+09:00`。時差の無い書き方は読まない (どの時刻か決まらない)
  if (
    typeof time !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(time)
  )
    throw new Error("tide_time.json の time が読めません");
  const at = Date.parse(time);
  if (!Number.isFinite(at))
    throw new Error("tide_time.json の time が読めません");
  return at;
}

/** 1 回の更新の記録 (時刻は ISO 8601 の UTC、遅れは秒) */
export interface TideRow {
  fetchedAt: string;
  dataTime: string;
  lastModified: string | null;
  fetchDelaySec: number;
  modifiedDelaySec: number | null;
  triggers: TideTrigger[];
  /** 前に取れた回から 90 秒より空いている (起動・測り始め・失敗の後)。この回の fetchDelaySec は更新の時刻を表さない */
  afterGap: boolean;
}

/** ログに出力する 1 行。`grep tide-latency` で探せる */
const logLine = (r: TideRow) =>
  `tide-latency data=${r.dataTime} fetched=${r.fetchedAt} lastModified=${r.lastModified ?? "-"} fetchDelay=${r.fetchDelaySec}s modifiedDelay=${r.modifiedDelaySec === null ? "-" : `${r.modifiedDelaySec}s`} triggers=${r.triggers.join(",")} afterGap=${r.afterGap ? 1 : 0}`;

export interface TideProbeOptions {
  state(): ProbeState;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (m: string) => void;
  now?: () => number;
  intervalMs?: number;
}

export class TideProbe {
  private readonly doFetch: typeof fetch;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private readonly interval: number;
  private etag?: string;
  private modified?: string;
  private lastData?: string;
  private lastOkAt?: number;
  private active: TideTrigger[] = [];

  constructor(
    private readonly db: Database,
    private readonly o: TideProbeOptions,
  ) {
    this.doFetch = o.fetch ?? fetch;
    this.wait = o.sleep ?? sleep;
    this.log = o.log ?? ((m: string) => console.log(m));
    this.now = o.now ?? Date.now;
    this.interval = o.intervalMs ?? 60_000;
    // 再起動の前と同じ更新を、もう一度足さない
    this.lastData =
      db
        .query<{ data_time: string }, []>(
          "SELECT data_time FROM tide_latency ORDER BY id DESC LIMIT 1",
        )
        .get()?.data_time ?? undefined;
  }

  /** 1 分ごとの 1 回。動かす理由があれば取り、新しい更新なら記録を返す */
  async step(signal: AbortSignal): Promise<TideRow | undefined> {
    const triggers = tideTriggers(this.o.state(), this.now());
    const was = this.active.join(",");
    this.active = triggers;
    if (triggers.join(",") !== was)
      this.log(
        triggers.length > 0
          ? `[tide-probe] 潮位観測情報の遅れを測ります (${triggers.join(",")})`
          : "[tide-probe] 潮位観測情報の遅れを測るのをやめます",
      );
    if (triggers.length === 0) {
      this.lastOkAt = undefined;
      return undefined;
    }
    return this.fetchOnce(triggers, signal);
  }

  private async fetchOnce(
    triggers: TideTrigger[],
    signal: AbortSignal,
  ): Promise<TideRow | undefined> {
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    if (this.etag) headers["if-none-match"] = this.etag;
    if (this.modified) headers["if-modified-since"] = this.modified;
    const res = await this.doFetch(TIDE_TIME_URL, {
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      redirect: "follow",
    });
    const fetchedAt = this.now();
    const afterGap =
      this.lastOkAt === undefined || fetchedAt - this.lastOkAt > GAP_MS;
    if (res.status === 304) {
      this.lastOkAt = fetchedAt;
      return undefined;
    }
    if (!res.ok) throw new Error(`${res.status} が返りました`);
    const data = parseTideTime(await res.text());
    this.lastOkAt = fetchedAt;
    this.etag = res.headers.get("etag") ?? undefined;
    const modifiedHeader = res.headers.get("last-modified") ?? undefined;
    this.modified = modifiedHeader;
    const dataTime = new Date(data).toISOString();
    if (dataTime === this.lastData) return undefined;
    const modifiedAt = modifiedHeader ? Date.parse(modifiedHeader) : Number.NaN;
    const row: TideRow = {
      fetchedAt: new Date(fetchedAt).toISOString(),
      dataTime,
      lastModified: Number.isFinite(modifiedAt)
        ? new Date(modifiedAt).toISOString()
        : null,
      fetchDelaySec: Math.round((fetchedAt - data) / 1000),
      modifiedDelaySec: Number.isFinite(modifiedAt)
        ? Math.round((modifiedAt - data) / 1000)
        : null,
      triggers,
      afterGap,
    };
    this.save(row);
    this.lastData = dataTime;
    this.log(logLine(row));
    return row;
  }

  private save(r: TideRow): void {
    this.db
      .query(
        `INSERT INTO tide_latency (fetched_at, data_time, last_modified, fetch_delay_s,
           modified_delay_s, triggers, after_gap) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.fetchedAt,
        r.dataTime,
        r.lastModified,
        r.fetchDelaySec,
        r.modifiedDelaySec,
        r.triggers.join(","),
        r.afterGap ? 1 : 0,
      );
    const before = new Date(
      Date.parse(r.fetchedAt) - KEEP_DAYS * 24 * 60 * 60_000,
    ).toISOString();
    this.db.query("DELETE FROM tide_latency WHERE fetched_at < ?").run(before);
    this.db
      .query(
        `DELETE FROM tide_latency WHERE id <= (
           SELECT id FROM tide_latency ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      )
      .run(KEEP_ROWS);
  }

  /** 止めるまで 1 分ごとに回す。失敗はログに出力するだけで、続けて失敗したら間隔を空ける (上限 15 分) */
  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        await this.step(signal);
        failures = 0;
      } catch (err) {
        if (signal.aborted) break;
        failures++;
        this.lastOkAt = undefined;
        this.log(`[tide-probe] 測れませんでした: ${err}`);
      }
      const delay =
        failures === 0
          ? this.interval
          : Math.min(15 * 60_000, this.interval * 2 ** (failures - 1));
      await this.wait(delay, signal);
    }
  }
}
