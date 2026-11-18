/**
 * 観測点のいまの揺れ (メモリだけ)。台湾の TREM-RTS (docs/design.md の 2.9) と Wolfx SeisJS (2.10) で 1 つずつ持つ。
 * 開いている画面の SSE (`/api/stream` の notices) が購読する。値は DB に入れず、Broker にも流さない
 * (Web Push・Webhook・読み上げに届かない)。
 */

import {
  RTS_STALE_MS,
  rtsClass,
  type RtsFrame,
  type RtsStation,
  type RtsStations,
} from "#lib/rts.ts";

/** 画面に送るときの SSE の event の名前 */
export interface RtsEvents {
  stations: string;
  frame: string;
}

export interface RtsBoardOptions {
  /** 既定は TREM-RTS の `rts-stations`・`rts` */
  events?: RtsEvents;
  /**
   * 見た目 (観測点ごとの震度の階級) が前と同じなら、前に配ってからこの時間 (ミリ秒) たつまで配らない。
   * 0 なら受けるたびに配る (TREM-RTS)。画面は `RTS_STALE_MS` 届かなければ灰色に戻すので、それより短くする
   */
  minRepeatMs?: number;
}

type Listener = (event: string, data: RtsFrame | RtsStations) => void;

export class RtsBoard {
  private stationsById = new Map<string, RtsStation>();
  private last: { receivedAt: number; frame: RtsFrame } | undefined;
  private sent: { at: number; look: string } | undefined;
  private listeners = new Set<(kind: "frame" | "stations") => void>();
  readonly events: RtsEvents;
  private readonly minRepeatMs: number;

  constructor(
    private readonly clock: () => number = Date.now,
    o: RtsBoardOptions = {},
  ) {
    this.events = o.events ?? { stations: "rts-stations", frame: "rts" };
    this.minRepeatMs = o.minRepeatMs ?? 0;
  }

  setStations(m: Map<string, RtsStation>): void {
    this.stationsById = m;
    this.emit("stations");
  }

  stations(): RtsStations {
    return { stations: [...this.stationsById.values()] };
  }

  /** 揺れを受けた。位置の分かる観測点だけを、画面に送る形式にする */
  put(i: Map<string, number>): RtsFrame {
    const points: [number, number, number][] = [];
    for (const [id, v] of i) {
      const at = this.stationsById.get(id);
      if (at) points.push([at[0], at[1], Math.round(v * 10) / 10]);
    }
    const now = this.clock();
    const frame = { at: new Date(now).toISOString(), points };
    this.last = { receivedAt: now, frame };
    const look = this.minRepeatMs > 0 ? lookOf(points) : "";
    if (
      this.minRepeatMs > 0 &&
      this.sent &&
      this.sent.look === look &&
      now - this.sent.at < this.minRepeatMs
    )
      return frame;
    this.sent = { at: now, look };
    this.emit("frame");
    return frame;
  }

  /** いまの揺れ。古ければ (`RTS_STALE_MS`) 無し */
  current(staleMs = RTS_STALE_MS): RtsFrame | undefined {
    if (!this.last) return undefined;
    return this.clock() - this.last.receivedAt < staleMs
      ? this.last.frame
      : undefined;
  }

  /** 変わったら呼ぶ。やめる関数を返す */
  subscribe(fn: Listener): () => void {
    const relay = (kind: "frame" | "stations") => {
      if (kind === "frame") {
        const f = this.last?.frame;
        if (f) fn(this.events.frame, f);
      } else fn(this.events.stations, this.stations());
    };
    this.listeners.add(relay);
    return () => this.listeners.delete(relay);
  }

  private emit(kind: "frame" | "stations"): void {
    for (const fn of this.listeners) {
      try {
        fn(kind);
      } catch (err) {
        console.warn(`[rts] 配れませんでした: ${err}`);
      }
    }
  }
}

/** 画面での見た目 (観測点ごとの震度の階級)。同じなら配り直さなくてよい */
function lookOf(points: [number, number, number][]): string {
  return points
    .map(([x, y, i]) => `${x},${y}:${rtsClass(i) ?? ""}`)
    .sort()
    .join(";");
}
