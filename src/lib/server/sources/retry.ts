/**
 * 張り直しの間隔と、WebSocket を張り続ける輪。P2P と Wolfx で同じものを使う。
 *
 * - 指数のバックオフに揺らぎを足す (1 秒から倍々、上限 30 秒、full jitter)
 * - 60 秒つながっていたら間隔を戻す
 * - 90 秒何も来なければ (heartbeat も含めて) 死んだとみなして張り直す
 */

import type { SourceId, SourceStatus } from "#lib/model.ts";
import { nowIso } from "#lib/server/time.ts";

export class Backoff {
  private attempt = 0;
  constructor(
    private readonly min = 1_000,
    private readonly max = 30_000,
    private readonly random: () => number = Math.random,
  ) {}
  /** 次に待つ時間 (ミリ秒) */
  next(): number {
    const cap = Math.min(this.max, this.min * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    return Math.round(this.random() * cap);
  }
  reset(): void {
    this.attempt = 0;
  }
}

/** 止める合図が来たら早く起きる sleep */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** 情報源ごとの状態。変わったら onChange に知らせる */
export class StatusTracker {
  private value: SourceStatus;
  constructor(
    id: SourceId,
    private readonly onChange?: (s: SourceStatus) => void,
  ) {
    this.value = { id, state: "connecting", since: nowIso() };
  }
  get(): SourceStatus {
    return { ...this.value };
  }
  set(state: SourceStatus["state"], error?: string): void {
    const changed = state !== this.value.state;
    this.value = {
      ...this.value,
      state,
      since: changed ? nowIso() : this.value.since,
      lastError: error ?? this.value.lastError,
    };
    if (changed || error) this.onChange?.(this.get());
  }
  seen(message: boolean): void {
    const at = nowIso();
    this.value.lastSeenAt = at;
    if (message) this.value.lastMessageAt = at;
  }
}

/** WebSocket の必要なところだけ (テストで差し替える) */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", fn: () => void): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: () => void): void;
  addEventListener(type: "error", fn: (e: unknown) => void): void;
}
export type Connect = (url: string) => SocketLike;

// Bun の WebSocket は headers を受ける (DOM の型には無い)
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  options: { headers: Record<string, string> },
) => SocketLike;

export const defaultConnect: Connect = (url) =>
  new BunWebSocket(url, { headers: { "user-agent": USER_AGENT } });

/** 情報源に名乗る名前。個人の連絡先は入れない */
export const USER_AGENT = "sonae (+https://github.com/danything/sonae)";

export interface SocketLoopOptions {
  url: string;
  signal: AbortSignal;
  status: StatusTracker;
  connect?: Connect;
  backoff?: Backoff;
  /**
   * 何も来なければ死んだとみなす時間。null で見ない (heartbeat の無い P2P。切れたことは close で知る)。
   * つながるまでは、どちらでも 30 秒で諦める
   */
  idleMs?: number | null;
  stableMs?: number;
  /** つながったとき (埋め直しに使う) */
  onOpen?(ws: SocketLike): void | Promise<void>;
  onMessage(text: string, ws: SocketLike): void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (msg: string) => void;
}

const CONNECT_TIMEOUT = 30_000;

/** 止めるまで張り続ける */
export async function runSocket(o: SocketLoopOptions): Promise<void> {
  const connect = o.connect ?? defaultConnect;
  const backoff = o.backoff ?? new Backoff();
  const idleMs = o.idleMs === undefined ? 90_000 : o.idleMs;
  const stableMs = o.stableMs ?? 60_000;
  const wait = o.sleep ?? sleep;
  const log = o.log ?? ((m: string) => console.log(m));
  while (!o.signal.aborted) {
    o.status.set("connecting");
    const openedAt = await once(o, connect, idleMs, log);
    if (o.signal.aborted) break;
    if (openedAt !== undefined && Date.now() - openedAt >= stableMs)
      backoff.reset();
    const delay = backoff.next();
    o.status.set("retrying");
    log(
      `[${o.status.get().id}] 切れました。${Math.round(delay / 100) / 10} 秒後に張り直します`,
    );
    await wait(delay, o.signal);
  }
  o.status.set("stopped");
}

/** 1 回つないで、切れるまで待つ。つながった時刻を返す (つながらなければ undefined) */
function once(
  o: SocketLoopOptions,
  connect: Connect,
  idleMs: number | null,
  log: (m: string) => void,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    let openedAt: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ws: SocketLike;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal.removeEventListener("abort", stop);
      try {
        ws?.close();
      } catch {
        // もう閉じている
      }
      resolve(openedAt);
    };
    const stop = () => finish();
    const arm = () => {
      clearTimeout(timer);
      const limit = openedAt === undefined ? CONNECT_TIMEOUT : idleMs;
      if (limit === null) return;
      timer = setTimeout(() => {
        log(
          `[${o.status.get().id}] ${limit / 1000} 秒何も来ないので張り直します`,
        );
        o.status.set("retrying", "無通信");
        finish();
      }, limit);
    };
    try {
      ws = connect(o.url);
    } catch (e) {
      o.status.set("retrying", String(e));
      return resolve(undefined);
    }
    o.signal.addEventListener("abort", stop, { once: true });
    arm();
    ws.addEventListener("open", () => {
      openedAt = Date.now();
      o.status.set("connected");
      o.status.seen(false);
      arm();
      void Promise.resolve(o.onOpen?.(ws)).catch((e: unknown) =>
        log(`[${o.status.get().id}] 埋め直しに失敗しました: ${e}`),
      );
    });
    ws.addEventListener("message", (e) => {
      arm();
      const text =
        typeof e.data === "string"
          ? e.data
          : e.data instanceof ArrayBuffer || ArrayBuffer.isView(e.data)
            ? new TextDecoder().decode(e.data as ArrayBuffer)
            : String(e.data);
      try {
        o.onMessage(text, ws);
      } catch (err) {
        log(`[${o.status.get().id}] 受けたものを扱えませんでした: ${err}`);
      }
    });
    ws.addEventListener("error", (e) => {
      const msg =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : "WebSocket のエラー";
      o.status.set("retrying", msg);
    });
    ws.addEventListener("close", finish);
  });
}
