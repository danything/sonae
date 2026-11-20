/**
 * 画面の「いまの姿」。最初は load で受けたものを入れ、SSE (`/api/stream`) の差分で更新する。
 * 切れたら自分で張り直し (EventSource の張り直しには任せない。止まったままになることがあるため)、
 * 最後に受けた番号 (`?after=`) から埋め直してもらう (docs/design.md の 2.3)。
 */

import { Backoff } from "./backoff.ts";
import { isStale, STABLE_MS } from "./connection.ts";
import type {
  Advisory,
  Eew,
  ForeignQuake,
  LiftedOffice,
  LongPeriod,
  Quake,
  SonaeEvent,
  SourceStatus,
  Tsunami,
  Volcano,
  WarningOutlook,
  WeatherInfo,
  WeatherWarning,
} from "./model.ts";
import {
  collapseNotes,
  collapseRoutineVolcanoes,
  latestPerVolcano,
} from "./model.ts";
import {
  RTS_STALE_MS,
  type RtsFrame,
  type RtsStation,
  type RtsStations,
} from "./rts.ts";

export interface Snapshot {
  lastSeq: number;
  eews: Eew[];
  quakes: Quake[];
  tsunamis: Tsunami[];
  advisories: Advisory[];
  foreignQuakes: ForeignQuake[];
  volcanoes: Volcano[];
  /** 火山ごとのいまの噴火警報・予報 (地図の火山の印) */
  volcanoLevels: Volcano[];
  longPeriods: LongPeriod[];
  /** いまの気象警報・注意報 (府県予報区と種別ごと。出ているものがあるものだけ) */
  warnings: WeatherWarning[];
  /** 気象の報 (新しい順) */
  weatherInfos: WeatherInfo[];
  /** いまの早期注意情報 (府県予報区と種別ごと。知らせず、住んでいる地域の警報級の可能性に使う) */
  outlooks: WarningOutlook[];
  statuses: SourceStatus[];
}

type Keyed = { id: string } | { eventId: string };
const keyOf = (v: Keyed) => ("id" in v ? v.id : v.eventId);

/** 同じものは置き換え、新しいものは足して、時刻の新しい順に並べる */
function upsert<T extends Keyed>(
  list: T[],
  item: T,
  time: (v: T) => string | undefined,
  limit: number,
): T[] {
  const rest = list.filter((x) => keyOf(x) !== keyOf(item));
  rest.push(item);
  rest.sort(
    (a, b) =>
      (Date.parse(time(b) ?? "") || 0) - (Date.parse(time(a) ?? "") || 0),
  );
  return rest.slice(0, limit);
}

export class Live {
  eews = $state<Eew[]>([]);
  quakes = $state<Quake[]>([]);
  tsunamis = $state<Tsunami[]>([]);
  advisories = $state<Advisory[]>([]);
  foreignQuakes = $state<ForeignQuake[]>([]);
  volcanoes = $state<Volcano[]>([]);
  volcanoLevels = $state<Volcano[]>([]);
  longPeriods = $state<LongPeriod[]>([]);
  warnings = $state<WeatherWarning[]>([]);
  /**
   * 開いている間に、警報・注意報が全部解除された府県予報区 (コードごと)。いまの姿 (`warnings`) からは外れるので、
   * その府県予報区を見ていた画面が「解除されました」と出すために控える (メモリだけ)
   */
  liftedOffices = $state<Record<string, LiftedOffice>>({});
  weatherInfos = $state<WeatherInfo[]>([]);
  outlooks = $state<WarningOutlook[]>([]);
  statuses = $state<SourceStatus[]>([]);
  /**
   * 台湾の観測点 (TREM-RTS) の位置と、いまの揺れ (docs/design.md の 2.9)。地図の点の色だけに使い、
   * 一覧にも知らせ (音・読み上げ・通知) にも使わない。揺れは `RTS_STALE_MS` 届かなければ消す
   */
  rtsStations = $state.raw<RtsStation[]>([]);
  rts = $state.raw<RtsFrame | null>(null);
  /** Wolfx SeisJS の観測点の位置と、いまの揺れ (2.10)。扱いは TREM-RTS と同じ */
  seisStations = $state.raw<RtsStation[]>([]);
  seis = $state.raw<RtsFrame | null>(null);
  private shakingTimers: Record<
    "rts" | "seis",
    ReturnType<typeof setTimeout> | undefined
  > = { rts: undefined, seis: undefined };
  connected = $state(false);
  /** ブラウザで load の中身を入れた (サーバーの描画では false のまま、load の data を使う) */
  seeded = $state(false);
  /** いまの時刻 (有効期限と「いま出ている」の判定に使う。10 秒ごとに進める) */
  now = $state(Date.now());
  private lastSeq = 0;
  private source: EventSource | undefined;

  /** load の中身を入れる (ページを移るたびに、新しいほうを採る) */
  seed(s: Snapshot): void {
    if (s.lastSeq < this.lastSeq) return;
    this.lastSeq = s.lastSeq;
    this.eews = s.eews;
    this.quakes = s.quakes;
    this.tsunamis = s.tsunamis;
    this.advisories = s.advisories;
    this.foreignQuakes = s.foreignQuakes;
    this.volcanoes = s.volcanoes;
    this.volcanoLevels = s.volcanoLevels;
    this.longPeriods = s.longPeriods;
    this.warnings = s.warnings;
    this.weatherInfos = s.weatherInfos;
    this.outlooks = s.outlooks;
    this.statuses = s.statuses;
    this.seeded = true;
  }

  /** サーバーの描画では load の中身を、ブラウザでは SSE で更新した中身を使う */
  view(s: Snapshot): Snapshot {
    if (!this.seeded) return s;
    return {
      lastSeq: this.lastSeq,
      eews: this.eews,
      quakes: this.quakes,
      tsunamis: this.tsunamis,
      advisories: this.advisories,
      foreignQuakes: this.foreignQuakes,
      volcanoes: this.volcanoes,
      volcanoLevels: this.volcanoLevels,
      longPeriods: this.longPeriods,
      warnings: this.warnings,
      weatherInfos: this.weatherInfos,
      outlooks: this.outlooks,
      statuses: this.statuses,
    };
  }

  /** 新しいイベントなら入れて true (埋め直しで二重に来たものは false) */
  apply(e: SonaeEvent): boolean {
    if (e.seq <= this.lastSeq) return false;
    this.lastSeq = e.seq;
    switch (e.type) {
      case "eew":
        if (e.data.status !== "normal") return true;
        this.eews = upsert(this.eews, e.data, (v) => v.issuedAt, 20);
        return true;
      case "quake":
        if (e.data.status !== "normal") return true;
        this.quakes = upsert(
          this.quakes,
          e.data,
          (v) => v.originTime ?? v.updatedAt,
          100,
        );
        return true;
      case "tsunami":
        if (e.data.status !== "normal") return true;
        this.tsunamis = upsert(this.tsunamis, e.data, (v) => v.issuedAt, 20);
        return true;
      case "advisory":
        if (e.data.status !== "normal") return true;
        this.advisories = upsert(
          this.advisories,
          e.data,
          (v) => v.reportedAt,
          50,
        );
        return true;
      case "longperiod":
        if (e.data.status !== "normal") return true;
        this.longPeriods = upsert(
          this.longPeriods,
          e.data,
          (v) => v.reportedAt,
          50,
        );
        return true;
      case "foreign":
        this.foreignQuakes = upsert(
          this.foreignQuakes,
          e.data,
          (v) => v.originTime,
          100,
        );
        return true;
      case "warning": {
        if (e.data.status !== "normal") return true;
        // 府県予報区と種別ごとに置き換え、出ているものが無くなったら外す (解除の市町村等は画面に要らない)
        const w = { ...e.data, released: [] };
        const rest = this.warnings.filter((x) => x.id !== w.id);
        this.warnings = w.areas.length > 0 ? [w, ...rest] : rest;
        if (
          w.areas.length === 0 &&
          !rest.some((x) => x.office.code === w.office.code)
        )
          this.liftedOffices = {
            ...this.liftedOffices,
            [w.office.code]: { office: w.office, reportedAt: w.reportedAt },
          };
        return true;
      }
      case "weather":
        if (e.data.status !== "normal") return true;
        // 解説の情報と台風情報は一連の情報ごとに新しい 1 つだけ残す (数が多く、ほかの報を押し出さないように)
        this.weatherInfos = collapseNotes(
          upsert(this.weatherInfos, e.data, (v) => v.reportedAt, 160),
        );
        return true;
      case "outlook":
        if (e.data.status !== "normal") return true;
        this.outlooks = [
          e.data,
          ...this.outlooks.filter((x) => x.id !== e.data.id),
        ];
        return true;
      case "volcano":
        if (e.data.status !== "normal") return true;
        // いつも出る種別 (観測報・降灰予報 (定時)・推定噴煙流向報) は火山と種別ごとに新しい 1 つだけ残す
        // (数が多く、ほかの報を押し出さないように)
        this.volcanoes = collapseRoutineVolcanoes(
          upsert(this.volcanoes, e.data, (v) => v.reportedAt, 80),
        );
        // 火山ごとのいまの姿は、新しい報 (取消なら前の報) を足して選び直す
        this.volcanoLevels = latestPerVolcano(
          [
            ...this.volcanoes,
            ...this.volcanoLevels.filter(
              (l) => !this.volcanoes.some((v) => v.id === l.id),
            ),
          ].sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt)),
        );
        return true;
    }
  }

  /**
   * 台湾の観測点 (`rts`) か SeisJS (`seis`) のいまの揺れを入れ、`RTS_STALE_MS` 次が届かなければ消す
   * (揺れが収まると送られてこなくなるため)
   */
  setShaking(kind: "rts" | "seis", frame: RtsFrame | null): void {
    clearTimeout(this.shakingTimers[kind]);
    this[kind] = frame && Array.isArray(frame.points) ? frame : null;
    if (this[kind])
      this.shakingTimers[kind] = setTimeout(
        () => (this[kind] = null),
        RTS_STALE_MS,
      );
  }

  /**
   * `onResync`: 長く切れていて、埋め直しが上限を超えたときに呼ぶ (サーバーが `event: resync` を送る)。
   * 一覧を取り直す (load を走らせ直し、seed で入れ替える)。
   * `onEvent`: 新しく受けたイベントごとに呼ぶ (開いているときの音と読み上げ。`alerter.svelte.ts`)。
   * `onHealth`: つながっているか (5 秒ごとと、変わったとき。切れたままなら知らせる `alerter.connection`)。
   * `onVoice`: この家の読み上げの声 (つないだときと、替わったとき)。
   */
  connect(
    onResync: () => void = () => {},
    onEvent: (e: SonaeEvent) => void = () => {},
    onHealth: (connected: boolean) => void = () => {},
    onVoice: (voice: number) => void = () => {},
  ): () => void {
    const backoff = new Backoff();
    let stopped = false;
    let lastSeen = Date.now();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stable: ReturnType<typeof setTimeout> | undefined;

    const down = () => {
      this.connected = false;
      clearTimeout(stable);
      this.source?.close();
      this.source = undefined;
      onHealth(false);
    };
    /** 間を空けて張り直す (もう待っていれば、そのまま待つ) */
    const schedule = () => {
      if (stopped || retry !== undefined) return;
      retry = setTimeout(open, backoff.next());
    };
    /** すぐ張り直す (オンラインに戻った・画面に戻った・何も届かない) */
    const reconnect = () => {
      if (stopped) return;
      backoff.reset();
      down();
      open();
    };

    // 張り直すたびに、最後に受けた番号の後から読む (切れていた間のものはサーバーが埋め直す。多すぎれば resync)
    const open = () => {
      clearTimeout(retry);
      retry = undefined;
      if (stopped) return;
      this.source?.close();
      lastSeen = Date.now();
      const es = new EventSource(`/api/stream?after=${this.lastSeq}`);
      this.source = es;
      const seen = () => {
        if (this.source === es) lastSeen = Date.now();
      };
      const on = (type: SonaeEvent["type"]) =>
        es.addEventListener(type, (m) => {
          seen();
          const seq = Number((m as MessageEvent).lastEventId);
          const e = {
            seq,
            type,
            data: JSON.parse((m as MessageEvent).data),
          } as SonaeEvent;
          if (this.apply(e)) onEvent(e);
        });
      on("eew");
      on("quake");
      on("tsunami");
      on("advisory");
      on("volcano");
      on("foreign");
      on("longperiod");
      on("warning");
      on("weather");
      es.addEventListener("status", (m) => {
        seen();
        this.statuses = JSON.parse((m as MessageEvent).data) as SourceStatus[];
      });
      // この家の読み上げの声 (つないだときと、どこかの端末で替えたとき。docs/design.md の 2.4)
      es.addEventListener("voice", (m) => {
        seen();
        const v = (JSON.parse((m as MessageEvent).data) as { voice?: unknown })
          .voice;
        if (typeof v === "number" && Number.isInteger(v)) onVoice(v);
      });
      // 台湾の観測点 (rts) と SeisJS (seis) の観測点の表といまの揺れ
      // (番号は無い。いまの値だけ。地図の点の色にだけ使う)
      for (const kind of ["rts", "seis"] as const) {
        es.addEventListener(`${kind}-stations`, (m) => {
          seen();
          const d = JSON.parse(
            (m as MessageEvent).data,
          ) as Partial<RtsStations>;
          if (Array.isArray(d.stations)) this[`${kind}Stations`] = d.stations;
        });
        es.addEventListener(kind, (m) => {
          seen();
          this.setShaking(
            kind,
            JSON.parse((m as MessageEvent).data) as RtsFrame,
          );
        });
      }
      es.addEventListener("resync", () => {
        seen();
        onResync();
      });
      es.addEventListener("open", () => {
        if (this.source !== es) return;
        seen();
        this.connected = true;
        onHealth(true);
        clearTimeout(stable);
        stable = setTimeout(() => backoff.reset(), STABLE_MS);
      });
      // EventSource は、サーバーが 200 の text/event-stream 以外 (502・503・ログインが切れた 401 など) を
      // 返すと張り直さずに止まる (CLOSED)。止まり方を見分けず、いつも閉じて自分で間を空けて張り直す
      es.addEventListener("error", () => {
        if (this.source !== es) return;
        down();
        schedule();
      });
    };

    const onOnline = () => {
      if (!this.connected) reconnect();
    };
    const onOffline = () => {
      down();
      schedule();
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // スリープから戻ったときなど、つながっているように見えて何も届かない接続を張り直す
      if (!this.connected || isStale(lastSeen, Date.now())) reconnect();
    };
    // 戻る・進むの控え (bfcache) から戻ったとき、EventSource は閉じられている
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) reconnect();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("pageshow", onShow);
    document.addEventListener("visibilitychange", onVisible);

    open();
    const tick = setInterval(() => (this.now = Date.now()), 10_000);
    const watch = setInterval(() => {
      if (this.connected && isStale(lastSeen, Date.now())) reconnect();
      onHealth(this.connected);
    }, 5_000);
    return () => {
      stopped = true;
      clearInterval(tick);
      clearInterval(watch);
      clearTimeout(retry);
      clearTimeout(stable);
      this.setShaking("rts", null);
      this.setShaking("seis", null);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("visibilitychange", onVisible);
      this.source?.close();
      this.source = undefined;
    };
  }
}

export const live = new Live();
