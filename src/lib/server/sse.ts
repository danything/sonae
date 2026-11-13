import type { SonaeEvent } from "#lib/model.ts";

/** Cloudflare のプロキシの 100 秒の無通信の切断より十分短く (docs/design.md の 2.3) */
export const PING_MS = 30_000;
/**
 * 埋め直しで送る上限。超えるときは埋め直しを送らずに `resync` を送り、ブラウザに一覧を
 * 取り直させる (長く切れていたとき。途中までの埋め直しでは、抜けたものに気づけない)。
 */
export const BACKLOG_LIMIT = 500;

/** SSE の 1 件。data は JSON にして 1 行で送る (JSON の中に改行は入らない) */
export function sseFrame(f: {
  id?: number;
  event?: string;
  data: unknown;
}): string {
  let out = "";
  if (f.id !== undefined) out += `id: ${f.id}\n`;
  if (f.event) out += `event: ${f.event}\n`;
  return `${out}data: ${JSON.stringify(f.data)}\n\n`;
}

export const eventFrame = (e: SonaeEvent) =>
  sseFrame({ id: e.seq, event: e.type, data: e.data });

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  // no-transform: 途中で圧縮させない (圧縮すると溜めてから届く)
  "cache-control": "no-cache, no-transform",
  // 途中のプロキシに溜めさせない
  "x-accel-buffering": "no",
  connection: "keep-alive",
};

export interface SseOptions {
  /** 埋め直し。上限を超えたと分かるよう、`limit` より 1 件多く返してよい */
  backlog(limit: number): SonaeEvent[];
  /** いまの最後の番号 (`resync` の `id:` にして、張り直しをそこから始める) */
  latestSeq(): number;
  backlogLimit?: number;
  subscribe(fn: (e: SonaeEvent) => void): () => void;
  /** 定期に送る状況 (ping と一緒に) */
  status?(): string;
  signal: AbortSignal;
  pingMs?: number;
}

/**
 * 埋め直し → 生の配信。埋め直しの間に来たものを取りこぼさないよう、先に購読してから
 * 埋め直しを送り、番号で重複を除く。埋め直しが上限を超えるときは `event: resync` を送る。
 */
export function sseStream(o: SseOptions): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let last = 0;
      let closed = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      let unsubscribe = () => {};
      // 埋め直しで投げても購読を残さないよう、片付けは最初に決めておく
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        unsubscribe();
        o.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // もう閉じている
        }
      };
      o.signal.addEventListener("abort", cleanup, { once: true });
      const send = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          cleanup();
        }
      };
      const queued: SonaeEvent[] = [];
      let live = false;
      const deliver = (e: SonaeEvent) => {
        if (e.seq <= last) return;
        last = e.seq;
        send(eventFrame(e));
      };
      unsubscribe = o.subscribe((e) => (live ? deliver(e) : queued.push(e)));
      try {
        // 張り直しの間隔の目安 (ミリ秒)。EventSource の既定 (3 秒ほど) より少し長めに
        send("retry: 5000\n\n");
        const limit = o.backlogLimit ?? BACKLOG_LIMIT;
        const backlog = o.backlog(limit + 1);
        if (backlog.length > limit) {
          // 多すぎる。埋め直しは送らず、いまの最後から生の配信に移る。ブラウザは一覧を取り直す
          last = o.latestSeq();
          send(sseFrame({ id: last, event: "resync", data: { after: last } }));
        } else {
          for (const e of backlog) deliver(e);
        }
        for (const e of queued) deliver(e);
      } catch (err) {
        console.warn(`[sse] 埋め直しに失敗しました: ${err}`);
        cleanup();
        return;
      }
      live = true;
      if (o.status) send(o.status());
      timer = setInterval(() => {
        send(": ping\n\n");
        if (o.status) send(o.status());
      }, o.pingMs ?? PING_MS);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}
