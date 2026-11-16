/**
 * Wolfx Open API の WebSocket (`wss://ws-api.wolfx.jp/all_eew`)。気象庁の緊急地震速報 (`jma_eew`) と、
 * 地震情報の一覧 (`jma_eqlist`、P2P地震情報の予備) を 1 つの接続で受ける。
 *
 * - 1 クライアント 1 接続。`all_eew` は Wolfx のすべての JSON API の配信を流すので、`type` で
 *   `jma_eew` と `jma_eqlist` だけを採り、ほか (中国の速報など) は捨てる
 * - つながったら `query_jmaeqlist` を送り、いまの一覧を受ける (切れていた間の分を埋める)。
 *   地震のときに Wolfx が一覧を自分から送ってくるかは確かめられていないので、つながっている間は
 *   最後に一覧を受けてから 60 秒たつごとに問い合わせ直す (自分から送ってきたら、そこから数え直す)
 * - サーバーは約 1 分ごとに heartbeat を送る。応えて `ping` を送る (推奨されている)
 * - 原文 (`OriginalText`) は受けたら捨てる。raw_messages には鍵だけを残す
 */

import { nowIso } from "#lib/server/time.ts";

import {
  type Connect,
  runSocket,
  type SocketLike,
  StatusTracker,
} from "./retry.ts";
import type { Source, SourceContext } from "./types.ts";
import { parseWolfx, parseWolfxEqlist } from "./wolfx-json.ts";

export const WOLFX_WS = "wss://ws-api.wolfx.jp/all_eew";

/**
 * 地震情報の一覧を問い合わせ直す間隔。Wolfx の文書に回数の目安は無い (同じ接続を使い続け、つなぎ直しを
 * 繰り返さないことだけが書かれている) ので、heartbeat と同じ 1 分にする。一覧は約 12KB で、1 日 17MB ほど
 */
export const EQLIST_POLL_MS = 60_000;

export interface WolfxOptions {
  url?: string;
  connect?: Connect;
  log?: (m: string) => void;
  /** 地震情報の一覧の報の時刻 (受けた時刻)。テストで差し替える */
  now?: () => string;
  /** 地震情報の一覧を問い合わせ直す間隔。テストで差し替える */
  eqlistPollMs?: number;
}

export function wolfxSource(
  ctx: SourceContext,
  opts: WolfxOptions = {},
): Source {
  const status = new StatusTracker("wolfx", ctx.onStatus);
  const now = opts.now ?? nowIso;
  const pollMs = opts.eqlistPollMs ?? EQLIST_POLL_MS;
  let poll: ReturnType<typeof setTimeout> | undefined;

  /** 次の問い合わせを pollMs 後に置き直す (問い合わせたときと、一覧を受けたとき) */
  function schedule(ws: SocketLike) {
    clearTimeout(poll);
    poll = setTimeout(() => query(ws), pollMs);
  }
  function query(ws: SocketLike) {
    ws.send("query_jmaeqlist");
    schedule(ws);
  }

  /** 地震情報の一覧。一覧は毎回 50 件まるごと来るので、中身の変わった行だけを渡す */
  function eqlist(value: Record<string, unknown>) {
    const at = now();
    for (const { key, item } of parseWolfxEqlist(value, at)) {
      if (ctx.seen("wolfx", key)) continue;
      status.seen(true);
      ctx.emit({ source: "wolfx", key, code: "jma_eqlist", items: [item] });
    }
  }

  return {
    id: "wolfx",
    status: () => status.get(),
    async run(signal) {
      await runSocket({
        url: opts.url ?? WOLFX_WS,
        signal,
        status,
        connect: opts.connect,
        log: opts.log,
        onOpen(ws) {
          query(ws);
        },
        onClose() {
          // 切れている間は問い合わせない。つなぎ直したら onOpen から始め直す
          clearTimeout(poll);
          poll = undefined;
        },
        onMessage(text, ws) {
          status.seen(false);
          const value = JSON.parse(text) as Record<string, unknown>;
          delete value.OriginalText;
          if (value.type === "jma_eqlist") {
            // 問い合わせの答えでも、Wolfx が自分から送ってきたものでも、次の問い合わせはここから数える
            schedule(ws);
            eqlist(value);
            return;
          }
          const m = parseWolfx(value);
          if (m.type === "heartbeat") {
            ws.send("ping");
            return;
          }
          if (m.type !== "eew") return;
          if (ctx.seen("wolfx", m.key)) return;
          status.seen(true);
          ctx.emit({
            source: "wolfx",
            key: m.key,
            code: "jma_eew",
            items: [{ type: "eew", report: m.report }],
          });
        },
      });
    },
  };
}
