/**
 * 画面の「いまの姿」。最初は load で受けたものを入れ、SSE (`/api/stream`) の差分で更新する。
 * 切れたら EventSource が自分で張り直し、`Last-Event-ID` から埋め直してもらう。
 */

import type {
  Advisory,
  Eew,
  LongPeriod,
  Quake,
  SonaeEvent,
  SourceStatus,
  Tsunami,
  Volcano,
} from "./model.ts";
import { latestPerVolcano } from "./model.ts";

export interface Snapshot {
  lastSeq: number;
  eews: Eew[];
  quakes: Quake[];
  tsunamis: Tsunami[];
  advisories: Advisory[];
  volcanoes: Volcano[];
  /** 火山ごとのいまの噴火警報・予報 (地図の火山の印) */
  volcanoLevels: Volcano[];
  longPeriods: LongPeriod[];
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
  volcanoes = $state<Volcano[]>([]);
  volcanoLevels = $state<Volcano[]>([]);
  longPeriods = $state<LongPeriod[]>([]);
  statuses = $state<SourceStatus[]>([]);
  connected = $state(false);
  /** ブラウザで load の中身を入れた (サーバーの描画では false のまま、load の data を使う) */
  seeded = $state(false);
  /** いまの時刻 (緊急地震速報の帯を、時間が経ったら下ろすため。10 秒ごとに進める) */
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
    this.volcanoes = s.volcanoes;
    this.volcanoLevels = s.volcanoLevels;
    this.longPeriods = s.longPeriods;
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
      volcanoes: this.volcanoes,
      volcanoLevels: this.volcanoLevels,
      longPeriods: this.longPeriods,
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
          20,
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
      case "volcano":
        if (e.data.status !== "normal") return true;
        this.volcanoes = upsert(
          this.volcanoes,
          e.data,
          (v) => v.reportedAt,
          50,
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
   * `onResync`: 長く切れていて、埋め直しが上限を超えたときに呼ぶ (サーバーが `event: resync` を送る)。
   * 一覧を取り直す (load を走らせ直し、seed で入れ替える)。
   * `onEvent`: 新しく受けたイベントごとに呼ぶ (開いているときの音と読み上げ。`alerter.svelte.ts`)。
   */
  connect(
    onResync: () => void = () => {},
    onEvent: (e: SonaeEvent) => void = () => {},
  ): () => void {
    const es = new EventSource(`/api/stream?after=${this.lastSeq}`);
    this.source = es;
    const on = (type: SonaeEvent["type"]) =>
      es.addEventListener(type, (m) => {
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
    on("longperiod");
    es.addEventListener("status", (m) => {
      this.statuses = JSON.parse((m as MessageEvent).data) as SourceStatus[];
    });
    es.addEventListener("resync", () => onResync());
    es.addEventListener("open", () => (this.connected = true));
    es.addEventListener("error", () => (this.connected = false));
    const tick = setInterval(() => (this.now = Date.now()), 10_000);
    return () => {
      clearInterval(tick);
      es.close();
      this.source = undefined;
    };
  }
}

export const live = new Live();
