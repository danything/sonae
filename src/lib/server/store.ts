/**
 * 受けたものを DB に入れ、変わった姿を events に足す。情報源の中の重複は raw_messages の鍵で、
 * 情報源をまたいだ重複は merge.ts の新旧の判定で除く。
 */

import type { Database } from "bun:sqlite";
import { gzipSync } from "node:zlib";

import type {
  Advisory,
  Eew,
  EventType,
  LongPeriod,
  Quake,
  SonaeEvent,
  SourceId,
  Status,
  Tsunami,
  Volcano,
} from "#lib/model.ts";
import { latestPerVolcano } from "#lib/model.ts";

import {
  mergeAdvisory,
  mergeEew,
  mergeLongPeriod,
  mergeQuake,
  mergeTsunami,
  sameQuakeByTime,
} from "./merge.ts";
import type {
  Incoming,
  Normalized,
  QuakeIncoming,
  TsunamiReport,
} from "./sources/types.ts";
import { ms, nowIso } from "./time.ts";

const DAY = 24 * 60 * 60 * 1000;

/** eews の鍵。通常は地震識別番号のまま、訓練・試験は後ろに付けて分ける */
const eewKey = (eventId: string, status: Status) =>
  status === "normal" ? eventId : `${eventId}-${status}`;
/** 原文を残す期間 (docs/design.md の未決の点 8) */
export const RAW_RETENTION_DAYS = 30;

export class Store {
  constructor(
    readonly db: Database,
    private readonly now: () => string = nowIso,
  ) {}

  seen(source: SourceId, key: string): boolean {
    return (
      this.db
        .query("SELECT 1 FROM raw_messages WHERE source = ? AND key = ?")
        .get(source, key) !== null
    );
  }

  /**
   * 1 通を入れる。もう受けた鍵なら何もしない。変わった姿を、足した順に返す。
   * 読み取りに失敗した電文も原文は残す (正規化を直したら流し直せるように)。
   */
  ingest(m: Incoming): SonaeEvent[] {
    return this.db.transaction(() => {
      const inserted = this.db
        .query(
          `INSERT OR IGNORE INTO raw_messages (source, key, code, received_at, body, error)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          m.source,
          m.key,
          m.code,
          this.now(),
          m.body === undefined ? null : gzipSync(m.body),
          m.error ?? null,
        );
      if (inserted.changes === 0) return [];
      return m.items.flatMap((item) => this.apply(item));
    })();
  }

  private apply(item: Normalized): SonaeEvent[] {
    const now = this.now();
    switch (item.type) {
      case "eew": {
        // 訓練・試験が本番と同じ地震識別番号で来ても混ぜない (Wolfx・P2P がそうしない保証は無い)
        const prev = this.eew(item.report.eventId, item.report.status);
        const next = mergeEew(prev, item.report, now);
        if (!next) return [];
        const key = eewKey(next.eventId, next.status);
        this.db
          .query(
            `INSERT INTO eews (event_id, status, issued_at, data) VALUES (?, ?, ?, ?)
             ON CONFLICT (event_id) DO UPDATE SET status = excluded.status,
               issued_at = excluded.issued_at, data = excluded.data`,
          )
          .run(key, next.status, next.issuedAt, JSON.stringify(next));
        return [this.event("eew", key, next)];
      }
      case "quake": {
        const prev = this.findQuake(item);
        const suffix = item.status === "normal" ? "" : `-${item.status}`;
        const id = item.eventId
          ? `${item.eventId}${suffix}`
          : `p2p-${(item.report.originTime ?? item.report.reportedAt).replace(/[^0-9]/g, "").slice(0, 14)}${suffix}`;
        const next = mergeQuake(
          prev,
          item.report,
          { id, eventId: item.eventId, status: item.status },
          now,
        );
        if (!next) return [];
        // P2P だけの地震に気象庁の XML が来たら、地震識別番号を付ける
        if (!next.eventId && item.eventId) next.eventId = item.eventId;
        this.db
          .query(
            `INSERT INTO quakes (id, event_id, status, origin_time, updated_at, data)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET event_id = excluded.event_id,
               origin_time = excluded.origin_time, updated_at = excluded.updated_at,
               data = excluded.data`,
          )
          .run(
            next.id,
            next.eventId ?? null,
            next.status,
            next.originTime ?? null,
            next.updatedAt,
            JSON.stringify(next),
          );
        return [this.event("quake", next.id, next)];
      }
      case "tsunami": {
        const prev = this.findTsunami(item.report);
        // 訓練・試験は地震と同じく後ろに付けて分ける。P2P の 552 には訓練の印が無い (仕様書 v2.3.0)
        // ので、P2P だけの津波はいまは必ず normal になる (docs/design.md の 2.2)
        const suffix =
          item.report.status === "normal" ? "" : `-${item.report.status}`;
        const id =
          prev?.id ??
          (item.report.eventIds[0]
            ? `${item.report.eventIds[0]}${suffix}`
            : `p2p-${item.report.reportedAt.replace(/[^0-9]/g, "").slice(0, 14)}${suffix}`);
        const next = mergeTsunami(prev, item.report, id, now);
        if (!next) return [];
        this.db
          .query(
            `INSERT INTO tsunamis (id, status, ended, issued_at, data) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET ended = excluded.ended,
               issued_at = excluded.issued_at, data = excluded.data`,
          )
          .run(
            next.id,
            next.status,
            next.ended ? 1 : 0,
            next.issuedAt,
            JSON.stringify(next),
          );
        return [this.event("tsunami", next.id, next)];
      }
      case "advisory": {
        const prev = this.advisory(item.advisory.id);
        const next = mergeAdvisory(prev, item.advisory, now);
        if (!next) return [];
        this.db
          .query(
            `INSERT INTO advisories (id, status, reported_at, data) VALUES (?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET reported_at = excluded.reported_at,
               data = excluded.data`,
          )
          .run(next.id, next.status, next.reportedAt, JSON.stringify(next));
        return [this.event("advisory", next.id, next)];
      }
      case "volcano":
        return this.applyVolcano(item.volcano, now);
      case "longperiod": {
        const r = item.report;
        const id = eewKey(r.eventId, r.status);
        const next = mergeLongPeriod(this.longPeriod(id), r, id, now);
        if (!next) return [];
        this.db
          .query(
            `INSERT INTO long_periods (id, event_id, status, reported_at, data) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET reported_at = excluded.reported_at, data = excluded.data`,
          )
          .run(
            next.id,
            next.eventId,
            next.status,
            next.reportedAt,
            JSON.stringify(next),
          );
        return [this.event("longperiod", next.id, next)];
      }
      case "other":
        return [];
    }
  }

  /**
   * 火山の報は 1 つずつ行にする。取消は、同じ一連の情報 (種別と識別番号) のいちばん新しい報に印を付ける
   * (取り消す報が無ければ、取消の報そのものを取消の印つきで残す)
   */
  private applyVolcano(
    v: Omit<Volcano, "updatedAt" | "cancelled">,
    now: string,
  ): SonaeEvent[] {
    const series = `${v.code}-${v.eventId}`;
    let next: Volcano = {
      ...v,
      cancelled: v.infoType === "取消",
      updatedAt: now,
    };
    if (v.infoType !== "発表") {
      const row = this.db
        .query<{ data: string }, [string, string]>(
          `SELECT data FROM volcanoes WHERE series = ? AND status = ?
           ORDER BY datetime(reported_at) DESC LIMIT 1`,
        )
        .get(series, v.status);
      const prev = row ? (JSON.parse(row.data) as Volcano) : undefined;
      if (prev && v.infoType === "取消") {
        if (prev.cancelled) return [];
        next = { ...prev, cancelled: true, updatedAt: now };
      } else if (prev) {
        // 訂正は前の報を置き換える (同じ id のまま。一覧に 2 つ並べない)
        next = { ...next, id: prev.id };
      }
    }
    this.db
      .query(
        `INSERT INTO volcanoes (id, series, status, reported_at, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET reported_at = excluded.reported_at,
           data = excluded.data`,
      )
      .run(next.id, series, next.status, next.reportedAt, JSON.stringify(next));
    return [this.event("volcano", next.id, next)];
  }

  private event(type: EventType, key: string, data: unknown): SonaeEvent {
    const row = this.db
      .query<{ seq: number }, [string, string, string, string]>(
        "INSERT INTO events (at, type, key, data) VALUES (?, ?, ?, ?) RETURNING seq",
      )
      .get(this.now(), type, key, JSON.stringify(data));
    return { seq: row?.seq ?? 0, type, data } as SonaeEvent;
  }

  /** 地震識別番号で、無ければ時刻の近い地震で結ぶ (merge.ts の sameQuakeByTime) */
  private findQuake(item: QuakeIncoming): Quake | undefined {
    if (item.eventId) {
      const row = this.db
        .query<{ data: string }, [string, string]>(
          "SELECT data FROM quakes WHERE event_id = ? AND status = ?",
        )
        .get(item.eventId, item.status);
      if (row) return JSON.parse(row.data) as Quake;
    }
    const t = ms(item.report.originTime ?? item.report.targetTime);
    if (!Number.isFinite(t)) return undefined;
    const from = new Date(t - 5 * 60_000).toISOString();
    const to = new Date(t + 5 * 60_000).toISOString();
    const candidates = this.db
      .query<{ data: string }, [string, string, string]>(
        `SELECT data FROM quakes WHERE status = ?
           AND datetime(origin_time) BETWEEN datetime(?) AND datetime(?)`,
      )
      .all(item.status, from, to)
      .map((r) => JSON.parse(r.data) as Quake);
    return candidates.find(
      (q) =>
        // 番号が付いた地震どうしは、番号が違えば別の地震 (震度速報だけは自動で、番号がずれうる)
        (!q.eventId ||
          !item.eventId ||
          item.report.kind === "scale" ||
          q.reports.every((r) => r.kind === "scale")) &&
        sameQuakeByTime(q, item.report),
    );
  }

  /** 地震識別番号が重なる津波、無ければ (P2P だけの) いま続いている津波に結ぶ */
  private findTsunami(r: TsunamiReport): Tsunami | undefined {
    const recent = this.db
      .query<{ data: string }, [string, string]>(
        "SELECT data FROM tsunamis WHERE status = ? AND issued_at >= ? ORDER BY issued_at DESC",
      )
      .all(r.status, new Date(ms(r.reportedAt) - 2 * DAY).toISOString())
      .map((row) => JSON.parse(row.data) as Tsunami);
    if (r.eventIds.length > 0) {
      const byId = recent.find((t) =>
        t.eventIds.some((id) => r.eventIds.includes(id)),
      );
      if (byId) return byId;
      // P2P で先に受けた津波 (番号なし) が続いていれば、そこに XML を重ねる
      return recent.find(
        (t) =>
          t.eventIds.length === 0 &&
          !t.ended &&
          Math.abs(ms(r.reportedAt) - ms(t.issuedAt)) < 60 * 60_000,
      );
    }
    return recent.find((t) => !t.ended && !t.cancelled);
  }

  eew(eventId: string, status: Status = "normal"): Eew | undefined {
    const row = this.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM eews WHERE event_id = ?",
      )
      .get(eewKey(eventId, status));
    return row ? (JSON.parse(row.data) as Eew) : undefined;
  }

  quake(id: string): Quake | undefined {
    const row = this.db
      .query<{ data: string }, [string]>("SELECT data FROM quakes WHERE id = ?")
      .get(id);
    return row ? (JSON.parse(row.data) as Quake) : undefined;
  }

  tsunami(id: string): Tsunami | undefined {
    const row = this.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM tsunamis WHERE id = ?",
      )
      .get(id);
    return row ? (JSON.parse(row.data) as Tsunami) : undefined;
  }

  advisory(id: string): Advisory | undefined {
    const row = this.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM advisories WHERE id = ?",
      )
      .get(id);
    return row ? (JSON.parse(row.data) as Advisory) : undefined;
  }

  /** 長周期地震動に関する観測情報。id は地震識別番号 (訓練・試験は後ろに付く) */
  longPeriod(id: string): LongPeriod | undefined {
    const row = this.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM long_periods WHERE id = ?",
      )
      .get(id);
    return row ? (JSON.parse(row.data) as LongPeriod) : undefined;
  }

  longPeriodOf(eventId: string, status: Status): LongPeriod | undefined {
    return this.longPeriod(eewKey(eventId, status));
  }

  longPeriods(limit = 50, includeTraining = false): LongPeriod[] {
    return this.db
      .query<{ data: string }, [number]>(
        `SELECT data FROM long_periods ${includeTraining ? "" : "WHERE status = 'normal'"}
         ORDER BY datetime(reported_at) DESC LIMIT ?`,
      )
      .all(limit)
      .map((r) => JSON.parse(r.data) as LongPeriod);
  }

  /** 新しい順の地震。発生の時刻が無いもの (震度速報だけ) は更新の時刻で並べる */
  quakes(limit = 50, includeTraining = false): Quake[] {
    return this.db
      .query<{ data: string }, [number]>(
        `SELECT data FROM quakes ${includeTraining ? "" : "WHERE status = 'normal'"}
         ORDER BY datetime(COALESCE(origin_time, updated_at)) DESC LIMIT ?`,
      )
      .all(limit)
      .map((r) => JSON.parse(r.data) as Quake);
  }

  tsunamis(limit = 20, includeTraining = false): Tsunami[] {
    return this.db
      .query<{ data: string }, [number]>(
        `SELECT data FROM tsunamis ${includeTraining ? "" : "WHERE status = 'normal'"}
         ORDER BY datetime(issued_at) DESC LIMIT ?`,
      )
      .all(limit)
      .map((r) => JSON.parse(r.data) as Tsunami);
  }

  eews(limit = 20, includeTraining = false): Eew[] {
    return this.db
      .query<{ data: string }, [number]>(
        `SELECT data FROM eews ${includeTraining ? "" : "WHERE status = 'normal'"}
         ORDER BY datetime(issued_at) DESC LIMIT ?`,
      )
      .all(limit)
      .map((r) => JSON.parse(r.data) as Eew);
  }

  volcano(id: string): Volcano | undefined {
    const row = this.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM volcanoes WHERE id = ?",
      )
      .get(id);
    return row ? (JSON.parse(row.data) as Volcano) : undefined;
  }

  /** 新しい順の火山の報 */
  volcanoes(limit = 50, includeTraining = false): Volcano[] {
    return this.db
      .query<{ data: string }, [number]>(
        `SELECT data FROM volcanoes ${includeTraining ? "" : "WHERE status = 'normal'"}
         ORDER BY datetime(reported_at) DESC LIMIT ?`,
      )
      .all(limit)
      .map((r) => JSON.parse(r.data) as Volcano);
  }

  /**
   * 火山ごとの、いまの噴火警報・予報 (受けた中でいちばん新しいもの。取り消されたものは除く)。
   * 地図の火山の印に使う。受けていない火山 (発表が長く変わっていない火山) は入らない
   */
  volcanoLevels(): Volcano[] {
    const rows = this.db
      .query<{ data: string }, []>(
        `SELECT data FROM volcanoes WHERE series LIKE 'VFVO50-%' AND status = 'normal'
         ORDER BY datetime(reported_at) DESC LIMIT 2000`,
      )
      .all()
      .map((r) => JSON.parse(r.data) as Volcano);
    return latestPerVolcano(rows);
  }

  advisories(limit = 20, includeTraining = false): Advisory[] {
    return this.db
      .query<{ data: string }, [number]>(
        `SELECT data FROM advisories ${includeTraining ? "" : "WHERE status = 'normal'"}
         ORDER BY datetime(reported_at) DESC LIMIT ?`,
      )
      .all(limit)
      .map((r) => JSON.parse(r.data) as Advisory);
  }

  /** SSE の埋め直し。seq より後のものを古い順に */
  eventsAfter(seq: number, limit = 500): SonaeEvent[] {
    return this.db
      .query<{ seq: number; type: EventType; data: string }, [number, number]>(
        "SELECT seq, type, data FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
      )
      .all(seq, limit)
      .map(
        (r) =>
          ({
            seq: r.seq,
            type: r.type,
            data: JSON.parse(r.data),
          }) as SonaeEvent,
      );
  }

  lastSeq(): number {
    return (
      this.db
        .query<{ seq: number | null }, []>("SELECT MAX(seq) AS seq FROM events")
        .get()?.seq ?? 0
    );
  }

  /** 古い原文を捨てる。重複の除去の鍵は残す (取り直さないように) */
  prune(days = RAW_RETENTION_DAYS): number {
    const before = new Date(ms(this.now()) - days * DAY).toISOString();
    return this.db
      .query(
        "UPDATE raw_messages SET body = NULL WHERE body IS NOT NULL AND received_at < ?",
      )
      .run(before).changes;
  }
}
