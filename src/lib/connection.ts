/**
 * 画面への配信 (SSE) の張り直しと、切れたことを知らせる判定 (docs/design.md の 2.3)。DOM を使わない部分だけ。
 * 張り直すのは `live.svelte.ts`、知らせるのは `alerter.svelte.ts`。
 */

import { type NotificationShape, toNotification } from "./push.ts";
import { CONNECTION } from "./readout.ts";

/**
 * 何も届かなければ切れたとみなす長さ。サーバーは 30 秒ごとに情報源の状況 (`event: status`) を送るので
 * (`server/sse.ts` の PING_MS)、2 回半届かなければ張り直す。`: ping` のコメント行は EventSource が
 * 画面に渡さないので、数えられるのは `status` とイベントだけ
 */
export const STALE_MS = 75_000;
/** つながってからこれだけ続いたら、張り直しの間隔を戻す (つないですぐ切れるのを繰り返すとき、間を空け続ける) */
export const STABLE_MS = 60_000;
/** 切れたままこれだけ続いたら知らせる (再起動などの短い切れ目では鳴らさない) */
export const OUTAGE_NOTIFY_MS = 30_000;
/** 「切れました」を知らせてから、次に「切れました」を知らせるまで空ける (切れたり戻ったりで鳴りすぎない) */
export const OUTAGE_COOLDOWN_MS = 10 * 60_000;

/** 最後に何か届いてから長すぎるか */
export const isStale = (lastSeen: number, now: number): boolean =>
  now - lastSeen > STALE_MS;

export type OutageSignal = "down" | "back";

/**
 * 切れた・戻ったを知らせるかを決める。ときどき (と、つながりが変わったとき) いまの状態を渡す。
 * - 切れたまま `OUTAGE_NOTIFY_MS` 続いたら "down" を 1 度だけ
 * - "down" を知らせた後につながったら "back" を 1 度だけ (知らせていない切れ目の戻りは言わない)
 * - 前の "down" から `OUTAGE_COOLDOWN_MS` 経つまでは、次の "down" を言わない (経った後も切れたままなら言う)
 */
export class OutageWatch {
  private downSince: number | null;
  private announced = false;
  private lastDown = Number.NEGATIVE_INFINITY;

  /** 開いたときは、まだつながっていない (最初の接続ができないままでも知らせる) */
  constructor(now: number) {
    this.downSince = now;
  }

  update(connected: boolean, now: number): OutageSignal | null {
    if (connected) {
      this.downSince = null;
      if (!this.announced) return null;
      this.announced = false;
      return "back";
    }
    this.downSince ??= now;
    if (
      this.announced ||
      now - this.downSince < OUTAGE_NOTIFY_MS ||
      now - this.lastDown < OUTAGE_COOLDOWN_MS
    )
      return null;
    this.announced = true;
    this.lastDown = now;
    return "down";
  }
}

/** 受信が切れた・戻ったときの通知の tag (事象の通知とは別に、1 つを置き換える) */
export const CONNECTION_TAG = "sonae:connection";

/**
 * 受信が切れた・戻ったときの OS の通知。戻ったときは、切れたときの通知を鳴らさずに置き換える
 */
export function connectionNotification(
  signal: OutageSignal,
  silent: boolean,
): NotificationShape {
  const down = signal === "down";
  const shape = toNotification({
    title: down ? "受信が切れました" : "受信が戻りました",
    body: down ? CONNECTION.down : CONNECTION.back,
    tag: CONNECTION_TAG,
    url: "/",
    // 音なしで出すとき (チャイムが鳴った・戻った) は鳴らし直さない (silent と renotify は一緒に付けない)
    renotify: down && !silent,
    sticky: false,
  });
  return {
    title: shape.title,
    options: { ...shape.options, silent: down ? silent : true },
  };
}
