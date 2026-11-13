/**
 * Wolfx Open API の気象庁の緊急地震速報 (`wss://ws-api.wolfx.jp/jma_eew`)。
 *
 * - 1 クライアント 1 接続
 * - サーバーは約 1 分ごとに heartbeat を送る。応えて `ping` を送る (推奨されている)
 * - 原文 (`OriginalText`) は受けたら捨てる。raw_messages には鍵だけを残す
 */

import { type Connect, runSocket, StatusTracker } from "./retry.ts";
import type { Source, SourceContext } from "./types.ts";
import { parseWolfx } from "./wolfx-json.ts";

export const WOLFX_WS = "wss://ws-api.wolfx.jp/jma_eew";

export interface WolfxOptions {
  url?: string;
  connect?: Connect;
  log?: (m: string) => void;
}

export function wolfxSource(
  ctx: SourceContext,
  opts: WolfxOptions = {},
): Source {
  const status = new StatusTracker("wolfx", ctx.onStatus);
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
        onMessage(text, ws) {
          status.seen(false);
          const value = JSON.parse(text) as Record<string, unknown>;
          delete value.OriginalText;
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
