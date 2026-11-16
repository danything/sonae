/**
 * Wolfx Open API の WebSocket (`wss://ws-api.wolfx.jp/all_eew`)。気象庁の緊急地震速報 (`jma_eew`) と、
 * 地震情報の一覧 (`jma_eqlist`、P2P地震情報の予備) を 1 つの接続で受ける。
 *
 * - 接続は 1 本 (文書の「可能な限り接続を再利用し、不要な重複接続を避ける」)。`all_eew` は Wolfx のすべての JSON API の配信を流すので、`type` で
 *   `jma_eew` と `jma_eqlist` だけを採り、ほか (中国の速報など) は捨てる
 * - つながったら `query_jmaeqlist` を 1 回送り、いまの一覧を受ける (切れていた間の分を埋める)
 * - サーバーは約 1 分ごとに heartbeat を送る。応えて `ping` を送る (推奨されている)
 * - 原文 (`OriginalText`) は受けたら捨てる。raw_messages には鍵だけを残す
 */

import { nowIso } from "#lib/server/time.ts";

import { type Connect, runSocket, StatusTracker } from "./retry.ts";
import type { Source, SourceContext } from "./types.ts";
import { parseWolfx, parseWolfxEqlist } from "./wolfx-json.ts";

export const WOLFX_WS = "wss://ws-api.wolfx.jp/all_eew";

export interface WolfxOptions {
  url?: string;
  connect?: Connect;
  log?: (m: string) => void;
  /** 地震情報の一覧の報の時刻 (受けた時刻)。テストで差し替える */
  now?: () => string;
}

export function wolfxSource(
  ctx: SourceContext,
  opts: WolfxOptions = {},
): Source {
  const status = new StatusTracker("wolfx", ctx.onStatus);
  const now = opts.now ?? nowIso;

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
          ws.send("query_jmaeqlist");
        },
        onMessage(text, ws) {
          status.seen(false);
          const value = JSON.parse(text) as Record<string, unknown>;
          delete value.OriginalText;
          if (value.type === "jma_eqlist") {
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
