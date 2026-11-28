/**
 * 受けたものを DB に入れ、変わった姿を events に足す。情報源の中の重複は raw_messages の鍵で、
 * 情報源をまたいだ重複は merge.ts の新旧の判定で除く。
 */

import type { Database } from "bun:sqlite";
import { gzipSync } from "node:zlib";

import { type TrackPoint, trackPoints } from "#lib/map/typhoon.ts";
import type {
  Advisory,
  AshWindow,
  Eew,
  EventType,
  ForeignQuake,
  ForeignReport,
  LongPeriod,
  Quake,
  SonaeEvent,
  SourceId,
  Status,
  Tsunami,
  TyphoonProbability,
  Volcano,
  VolcanoAshMap,
  WarningOutlook,
  WeatherInfo,
  WeatherWarning,
} from "#lib/model.ts";
import {
  collapseNotes,
  collapseRoutineVolcanoes,
  foreignFromReports,
  latestPerVolcano,
  NOTE_KINDS,
  sameForeignQuake,
} from "#lib/model.ts";

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
/** 原文を残す期間 (docs/design.md の 2.1) */
const RAW_RETENTION_DAYS = 30;

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
          : `${item.report.source}-${(item.report.originTime ?? item.report.reportedAt).replace(/[^0-9]/g, "").slice(0, 14)}${suffix}`;
        const next = mergeQuake(
          prev,
          item.report,
          { id, eventId: item.eventId, status: item.status },
          now,
        );
        if (!next) return [];
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
        // 地震の番号が無い津波は `p2p-<報告の時刻>`。頭の `p2p-` は受けた所を表さない (Wolfx から受けても同じ形。
        // 前からの id と同じにしておくため変えない。docs/design.md の 2.2)
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
      case "foreign":
        return this.applyForeign(item.report, now);
      case "volcano":
        return this.applyVolcano(item.volcano, now, item.ash);
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
      case "warning":
        return this.applyWarning(item.warning, now);
      case "weather":
        return this.applyWeatherInfo(item.info, now);
      case "outlook":
        return this.applyOutlook(item.outlook, now);
      case "typhoonprob":
        this.applyTyphoonProbability(item.probability, item.infoType);
        return [];
      case "other":
        return [];
    }
  }

  /**
   * 気象警報・注意報。府県予報区と種別ごとの状態を、新しい報で置き換える。前の報より古い報
   * (長期フィードで後から読んだもの) は捨てる。同じ時刻の報は訂正なら置き換える。
   * 気象庁ホームページの JSON (予備、`source: "jma-bosai"`) から受けた報は、同じ時刻の気象庁 XML の報で
   * 置き換え、気象庁 XML の報を同じ時刻の予備の報では置き換えない (docs/design.md の 2.8)
   */
  private applyWarning(
    w: Omit<WeatherWarning, "updatedAt">,
    now: string,
  ): SonaeEvent[] {
    const prev = this.warning(w.id);
    if (prev) {
      const d = ms(w.reportedAt) - ms(prev.reportedAt);
      if (d < 0) return [];
      if (d === 0) {
        const xmlOverBosai =
          prev.source === "jma-bosai" && w.source === undefined;
        // 予備の訂正は、手元の報が訂正でなければ採る (気象庁 XML が落ちている間に出た訂正を、XML が戻るまで捨てない)
        const bosaiCorrection =
          w.source === "jma-bosai" &&
          w.infoType === "訂正" &&
          prev.infoType !== "訂正";
        const bosaiOverXml =
          prev.source === undefined &&
          w.source === "jma-bosai" &&
          !bosaiCorrection;
        // 予備の同じ訂正を毎回受け直しても、鳴らし直さない
        const bosaiAgain = w.source === "jma-bosai" && prev.infoType === "訂正";
        if (
          bosaiOverXml ||
          bosaiAgain ||
          (w.infoType !== "訂正" && !xmlOverBosai)
        )
          return [];
      }
    }
    const next: WeatherWarning = { ...w, updatedAt: now };
    this.db
      .query(
        `INSERT INTO weather_warnings (id, code, office, status, reported_at, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET reported_at = excluded.reported_at, data = excluded.data`,
      )
      .run(
        next.id,
        next.code,
        next.office.code,
        next.status,
        next.reportedAt,
        JSON.stringify(next),
      );
    return [this.event("warning", next.id, next)];
  }

  /**
   * 気象の、報ごとの情報。火山と同じく報ごとに 1 行。取消は同じ一連の情報のいちばん新しい報に印を付け、
   * 訂正はその報を置き換える
   */
  private applyWeatherInfo(
    w: Omit<WeatherInfo, "updatedAt" | "cancelled">,
    now: string,
  ): SonaeEvent[] {
    // 気象庁ホームページの JSON (予備) から受けた発表は、同じ報 (同じ id) を受けていれば採らない
    // (気象庁 XML の報を置き換えない)。予備の後に気象庁 XML の同じ報が来たら、下の upsert で置き換わる。
    // 予備の訂正・取消は下で、一連の情報のいちばん新しい報と比べる
    if (
      w.source === "jma-bosai" &&
      w.infoType === "発表" &&
      this.db
        .query<{ n: number }, [string]>(
          "SELECT 1 AS n FROM weather_infos WHERE id = ?",
        )
        .get(w.id)
    )
      return [];
    let next: WeatherInfo = {
      ...w,
      cancelled: w.infoType === "取消",
      updatedAt: now,
    };
    if (w.infoType !== "発表") {
      const row = this.db
        .query<{ data: string }, [string]>(
          `SELECT data FROM weather_infos WHERE series = ?
           ORDER BY datetime(reported_at) DESC LIMIT 1`,
        )
        .get(w.series);
      const prev = row ? (JSON.parse(row.data) as WeatherInfo) : undefined;
      // 予備の訂正は、同じか新しい訂正を受けていれば採らない (気象庁 XML の訂正を置き換えず、予備の同じ訂正で鳴らし直さない)
      if (
        w.source === "jma-bosai" &&
        w.infoType === "訂正" &&
        prev?.infoType === "訂正" &&
        ms(prev.reportedAt) >= ms(w.reportedAt)
      )
        return [];
      if (prev && w.infoType === "取消") {
        if (prev.cancelled) return [];
        next = { ...prev, cancelled: true, updatedAt: now };
      } else if (w.infoType === "取消" && w.kind === "bosai") {
        // 取り消す報を持っていない気象防災速報 (取らなかった記録雨だけの速報など) の取消は、並べない
        return [];
      } else if (prev) {
        next = { ...next, id: prev.id };
      }
    }
    this.db
      .query(
        `INSERT INTO weather_infos (id, series, kind, status, reported_at, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET reported_at = excluded.reported_at, data = excluded.data`,
      )
      .run(
        next.id,
        next.series,
        next.kind,
        next.status,
        next.reportedAt,
        JSON.stringify(next),
      );
    return [this.event("weather", next.id, next)];
  }

  /**
   * 台風の暴風域に入る確率。台風ごとにいちばん新しい報だけを持ち、古い報 (長期フィードで後から読んだもの) は捨てる。
   * 取消はその台風の確率を消す。画面は詳しい内容を開いたときに読むので、イベントは出さない
   */
  private applyTyphoonProbability(
    p: TyphoonProbability,
    infoType: "発表" | "訂正" | "取消",
  ): void {
    if (infoType === "取消") {
      this.db.query("DELETE FROM typhoon_probs WHERE series = ?").run(p.series);
      return;
    }
    const prev = this.typhoonProbability(p.series);
    if (prev) {
      const d = ms(p.reportedAt) - ms(prev.reportedAt);
      if (d < 0 || (d === 0 && infoType !== "訂正")) return;
    }
    this.db
      .query(
        `INSERT INTO typhoon_probs (series, status, reported_at, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (series) DO UPDATE SET status = excluded.status,
           reported_at = excluded.reported_at, data = excluded.data`,
      )
      .run(p.series, p.status, p.reportedAt, JSON.stringify(p));
  }

  /**
   * 1 つの台風のこれまでの経路 (受けた台風解析・予報情報の実況の中心。時刻の順。docs/map.md の「台風」)。
   * 台風は長くても数週間なので、新しい 500 通までを見る
   */
  typhoonTrack(series: string): TrackPoint[] {
    return trackPoints(
      this.db
        .query<{ data: string }, [string]>(
          `SELECT data FROM weather_infos WHERE series = ? AND kind = 'typhoon' AND status = 'normal'
           ORDER BY datetime(reported_at) DESC LIMIT 500`,
        )
        .all(series)
        .map((r) => JSON.parse(r.data) as WeatherInfo),
    );
  }

  /** 台風 (series) のいちばん新しい暴風域に入る確率 */
  typhoonProbability(series: string): TyphoonProbability | undefined {
    const row = this.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM typhoon_probs WHERE series = ?",
      )
      .get(series);
    return row ? (JSON.parse(row.data) as TyphoonProbability) : undefined;
  }

  /**
   * 早期注意情報。府県予報区と種別ごとのいまの 1 通を、新しい報で置き換える (気象警報・注意報と同じ。
   * 前の報より古い報は捨てる)
   */
  private applyOutlook(
    o: Omit<WarningOutlook, "updatedAt">,
    now: string,
  ): SonaeEvent[] {
    const row = this.db
      .query<{ reported_at: string }, [string]>(
        "SELECT reported_at FROM weather_outlooks WHERE id = ?",
      )
      .get(o.id);
    if (row && ms(o.reportedAt) <= ms(row.reported_at)) return [];
    const next: WarningOutlook = { ...o, updatedAt: now };
    this.db
      .query(
        `INSERT INTO weather_outlooks (id, code, office, status, reported_at, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET reported_at = excluded.reported_at, data = excluded.data`,
      )
      .run(
        next.id,
        next.code,
        next.office.code,
        next.status,
        next.reportedAt,
        JSON.stringify(next),
      );
    return [this.event("outlook", next.id, next)];
  }

  /** いまの早期注意情報 (府県予報区と種別ごと)。訓練・試験は除く */
  outlooks(): WarningOutlook[] {
    return this.db
      .query<{ data: string }, []>(
        "SELECT data FROM weather_outlooks WHERE status = 'normal'",
      )
      .all()
      .map((r) => JSON.parse(r.data) as WarningOutlook);
  }

  weatherInfo(id: string): WeatherInfo | undefined {
    const row = this.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM weather_infos WHERE id = ?",
      )
      .get(id);
    return row ? (JSON.parse(row.data) as WeatherInfo) : undefined;
  }

  /**
   * 新しい順の気象の報。解説の情報 (気象解説情報・潮位・天候情報・早期天候情報) は 1 日に数十通出るので
   * 数に入れず、この 3 日の分から一連の情報ごとにいちばん新しい報を `notes` 件まで足す
   * (画面は一連の情報ごとに 1 行にする。`collapseNotes`)
   */
  weatherInfos(limit = 100, notes = 60): WeatherInfo[] {
    const kinds = [...NOTE_KINDS].map((k) => `'${k}'`).join(", ");
    const parse = (rows: { data: string }[]) =>
      rows.map((r) => JSON.parse(r.data) as WeatherInfo);
    const main = parse(
      this.db
        .query<{ data: string }, [number]>(
          `SELECT data FROM weather_infos WHERE status = 'normal' AND kind NOT IN (${kinds})
           ORDER BY datetime(reported_at) DESC LIMIT ?`,
        )
        .all(limit),
    );
    const since = new Date(ms(this.now()) - 3 * DAY).toISOString();
    const note = collapseNotes(
      parse(
        this.db
          .query<{ data: string }, [string]>(
            `SELECT data FROM weather_infos WHERE status = 'normal' AND kind IN (${kinds})
               AND datetime(reported_at) > datetime(?)
             ORDER BY datetime(reported_at) DESC LIMIT 2000`,
          )
          .all(since),
      ),
    ).slice(0, notes);
    return [...main, ...note].sort(
      (a, b) => ms(b.reportedAt) - ms(a.reportedAt),
    );
  }

  private warning(id: string): WeatherWarning | undefined {
    const row = this.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM weather_warnings WHERE id = ?",
      )
      .get(id);
    return row ? (JSON.parse(row.data) as WeatherWarning) : undefined;
  }

  /** 1 つの府県予報区の、種別ごとの最後の報 (解除されて出ている市町村等の無いものも)。訓練・試験は除く */
  officeWarnings(office: string): WeatherWarning[] {
    return this.db
      .query<{ data: string }, [string]>(
        `SELECT data FROM weather_warnings WHERE office = ? AND status = 'normal'`,
      )
      .all(office)
      .map((r) => JSON.parse(r.data) as WeatherWarning);
  }

  /** いまの気象警報・注意報 (府県予報区と種別ごと)。訓練・試験は除く */
  warnings(): WeatherWarning[] {
    return this.db
      .query<{ data: string }, []>(
        `SELECT data FROM weather_warnings WHERE status = 'normal'
         ORDER BY datetime(reported_at) DESC`,
      )
      .all()
      .map((r) => JSON.parse(r.data) as WeatherWarning);
  }

  /**
   * 海外の地震。同じ機関の同じ id の発表は置き換え、無ければ時刻・位置・M の近い地震にまとめる。
   * 中身が変わらなければイベントを出さない
   */
  private applyForeign(r: ForeignReport, now: string): SonaeEvent[] {
    const key = ` ${r.source}:${r.sourceId} `;
    const t = Date.parse(r.originTime);
    if (!Number.isFinite(t)) return [];
    const candidates = this.db
      .query<{ data: string }, [string, string, string]>(
        `SELECT data FROM foreign_quakes
         WHERE instr(sources, ?) > 0
            OR datetime(origin_time) BETWEEN datetime(?) AND datetime(?)`,
      )
      .all(
        key,
        new Date(t - 10 * 60_000).toISOString(),
        new Date(t + 10 * 60_000).toISOString(),
      )
      .map((row) => JSON.parse(row.data) as ForeignQuake);
    const prev =
      candidates.find((q) =>
        q.reports.some(
          (x) => x.source === r.source && x.sourceId === r.sourceId,
        ),
      ) ??
      candidates.find(
        (q) =>
          // 同じ機関の別の地震とは結ばない
          !q.reports.some((x) => x.source === r.source) &&
          sameForeignQuake(q, r),
      );
    const reports = [
      ...(prev?.reports.filter(
        (x) => !(x.source === r.source && x.sourceId === r.sourceId),
      ) ?? []),
      r,
    ];
    const id = prev?.id ?? `${r.source}-${r.sourceId}`;
    const next = foreignFromReports(id, reports, now);
    if (
      prev &&
      JSON.stringify({ ...prev, updatedAt: "" }) ===
        JSON.stringify({ ...next, updatedAt: "" })
    )
      return [];
    this.db
      .query(
        `INSERT INTO foreign_quakes (id, origin_time, sources, updated_at, data)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET origin_time = excluded.origin_time,
           sources = excluded.sources, updated_at = excluded.updated_at,
           data = excluded.data`,
      )
      .run(
        next.id,
        next.originTime,
        ` ${next.reports.map((x) => `${x.source}:${x.sourceId}`).join("  ")} `,
        next.updatedAt,
        JSON.stringify(next),
      );
    return [this.event("foreign", next.id, next)];
  }

  foreignQuake(id: string): ForeignQuake | undefined {
    const row = this.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM foreign_quakes WHERE id = ?",
      )
      .get(id);
    return row ? (JSON.parse(row.data) as ForeignQuake) : undefined;
  }

  /** 新しい順の海外の地震 */
  foreignQuakes(limit = 100): ForeignQuake[] {
    return this.db
      .query<{ data: string }, [number]>(
        "SELECT data FROM foreign_quakes ORDER BY datetime(origin_time) DESC LIMIT ?",
      )
      .all(limit)
      .map((r) => JSON.parse(r.data) as ForeignQuake);
  }

  /**
   * 火山の報は 1 つずつ行にする。取消は、同じ一連の情報 (種別と識別番号) のいちばん新しい報に印を付ける
   * (取り消す報が無ければ、取消の報そのものを取消の印つきで残す)
   */
  private applyVolcano(
    v: Omit<Volcano, "updatedAt" | "cancelled">,
    now: string,
    ash?: AshWindow[],
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
    if (ash && ash.length > 0 && !next.cancelled)
      this.putAsh(next, series, ash);
    return [this.event("volcano", next.id, next)];
  }

  /**
   * 降灰予報の範囲を、報の id ごとに置く (一覧の報には持たせない。地図で選んだときに `volcanoAsh` で読む)。
   * 定時 (VFVO53) は火山ごとに 3 時間おきに出て 1 通 15〜35 KB あるので、同じ series のいちばん新しい報だけを残す
   */
  private putAsh(v: Volcano, series: string, ash: AshWindow[]): void {
    // 定時の古い報があとから届いたとき (取りこぼしの取り直しなど) は置かない
    if (
      v.code === "VFVO53" &&
      this.db
        .query(
          `SELECT 1 FROM volcano_ash WHERE series = ? AND id <> ?
             AND datetime(reported_at) > datetime(?)`,
        )
        .get(series, v.id, v.reportedAt) !== null
    )
      return;
    this.db
      .query(
        `INSERT INTO volcano_ash (id, series, reported_at, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET reported_at = excluded.reported_at,
           data = excluded.data`,
      )
      .run(v.id, series, v.reportedAt, JSON.stringify(ash));
    if (v.code === "VFVO53")
      this.db
        .query(
          `DELETE FROM volcano_ash WHERE series = ? AND id <> ?
             AND datetime(reported_at) <= datetime(?)`,
        )
        .run(series, v.id, v.reportedAt);
  }

  /** 降灰予報の範囲 (地図に描く)。受けていない・範囲の無い・取り消された報は undefined */
  volcanoAsh(id: string): VolcanoAshMap | undefined {
    const v = this.volcano(id);
    if (!v || v.cancelled) return undefined;
    const row = this.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM volcano_ash WHERE id = ?",
      )
      .get(id);
    if (!row) return undefined;
    return {
      id,
      code: v.code,
      reportedAt: v.reportedAt,
      windows: JSON.parse(row.data) as AshWindow[],
    };
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

  /** 地震識別番号が重なる津波、無ければ番号の無い (P2P などだけの) いま続いている津波に結ぶ */
  private findTsunami(r: TsunamiReport): Tsunami | undefined {
    // 時刻の書き方 (+09:00 と Z) が混ざるので、文字のままではなく datetime() で比べる
    const at = ms(r.reportedAt);
    if (!Number.isFinite(at)) return undefined;
    const recent = this.db
      .query<{ data: string }, [string, string]>(
        "SELECT data FROM tsunamis WHERE status = ? AND datetime(issued_at) >= datetime(?) ORDER BY datetime(issued_at) DESC",
      )
      .all(r.status, new Date(at - 2 * DAY).toISOString())
      .map((row) => JSON.parse(row.data) as Tsunami);
    if (r.eventIds.length > 0) {
      const byId = recent.find((t) =>
        t.eventIds.some((id) => r.eventIds.includes(id)),
      );
      if (byId) return byId;
      // P2P で先に受けた津波 (番号なし) が続いていれば、そこに重ねる
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

  longPeriods(limit = 50): LongPeriod[] {
    return this.db
      .query<{ data: string }, [number]>(
        `SELECT data FROM long_periods WHERE status = 'normal'
         ORDER BY datetime(reported_at) DESC LIMIT ?`,
      )
      .all(limit)
      .map((r) => JSON.parse(r.data) as LongPeriod);
  }

  /** 新しい順の地震。発生の時刻が無いもの (震度速報だけ) は更新の時刻で並べる */
  quakes(limit = 50): Quake[] {
    return this.db
      .query<{ data: string }, [number]>(
        `SELECT data FROM quakes WHERE status = 'normal'
         ORDER BY datetime(COALESCE(origin_time, updated_at)) DESC LIMIT ?`,
      )
      .all(limit)
      .map((r) => JSON.parse(r.data) as Quake);
  }

  /** 発生 (無ければ更新) の時刻が since 以後の地震。数で切らない (大きな地震の後に続く余震で押し出さない) */
  quakesSince(since: string): Quake[] {
    return this.db
      .query<{ data: string }, [string]>(
        `SELECT data FROM quakes WHERE status = 'normal'
         AND datetime(COALESCE(origin_time, updated_at)) >= datetime(?)`,
      )
      .all(since)
      .map((r) => JSON.parse(r.data) as Quake);
  }

  tsunamis(limit = 20): Tsunami[] {
    return this.db
      .query<{ data: string }, [number]>(
        `SELECT data FROM tsunamis WHERE status = 'normal'
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

  /**
   * 新しい順の火山の報。いつも出る種別 (噴火に関する火山観測報・降灰予報 (定時)・推定噴煙流向報) は数が多いので
   * 数に入れず、この 2 日の分から火山と種別ごとにいちばん新しい報だけを足す (`collapseRoutineVolcanoes`)
   */
  volcanoes(limit = 50): Volcano[] {
    const parse = (rows: { data: string }[]) =>
      rows.map((r) => JSON.parse(r.data) as Volcano);
    const main = parse(
      this.db
        .query<{ data: string }, [number]>(
          `SELECT data FROM volcanoes WHERE status = 'normal'
             AND series NOT LIKE 'VFVO52-%' AND series NOT LIKE 'VFVO53-%'
             AND series NOT LIKE 'VFVO60-%'
           ORDER BY datetime(reported_at) DESC LIMIT ?`,
        )
        .all(limit),
    );
    const since = new Date(ms(this.now()) - 2 * DAY).toISOString();
    const routine = collapseRoutineVolcanoes(
      parse(
        this.db
          .query<{ data: string }, [string]>(
            `SELECT data FROM volcanoes WHERE status = 'normal'
               AND (series LIKE 'VFVO52-%' OR series LIKE 'VFVO53-%'
                 OR series LIKE 'VFVO60-%')
               AND datetime(reported_at) > datetime(?)
             ORDER BY datetime(reported_at) DESC LIMIT 2000`,
          )
          .all(since),
      ),
    );
    return [...main, ...routine].sort(
      (a, b) => ms(b.reportedAt) - ms(a.reportedAt),
    );
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

  advisories(limit = 20): Advisory[] {
    return this.db
      .query<{ data: string }, [number]>(
        `SELECT data FROM advisories WHERE status = 'normal'
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
    // 気象の警報・注意報は府県予報区ごとの状態を報ごとに丸ごと積むので、イベントも同じ期間で捨てる
    // (いまの状態は weather_warnings にある。SSE の埋め直しは新しいものしか使わない)
    this.db
      .query(
        "DELETE FROM events WHERE type IN ('warning', 'weather', 'outlook') AND at < ?",
      )
      .run(before);
    // 台風の暴風域に入る確率も同じ期間で捨てる (終わった台風の確率は使わない)
    this.db
      .query(
        "DELETE FROM typhoon_probs WHERE datetime(reported_at) < datetime(?)",
      )
      .run(before);
    // 降灰予報の範囲も同じ期間で捨てる (有効期限は長くても 1 日ほど)
    this.db
      .query(
        "DELETE FROM volcano_ash WHERE datetime(reported_at) < datetime(?)",
      )
      .run(before);
    return this.db
      .query(
        "UPDATE raw_messages SET body = NULL WHERE body IS NOT NULL AND received_at < ?",
      )
      .run(before).changes;
  }
}
