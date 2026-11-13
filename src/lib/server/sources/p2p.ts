/**
 * P2P地震情報 API v2 の WebSocket (`wss://api.p2pquake.net/v2/ws`)。
 *
 * - IP ごとに 2 接続まで。1 つだけ使う
 * - 同じ情報が何度も届くので `id` で除く (store の raw_messages の鍵)
 * - 張り直したら `/v2/history` (60 回/分まで) で、切れていた間の分を埋める
 */

import { P2P_CODES, parseP2p } from "./p2p-json.ts";
import { type Connect, runSocket, StatusTracker, USER_AGENT } from "./retry.ts";
import type { Source, SourceContext } from "./types.ts";

export const P2P_WS = "wss://api.p2pquake.net/v2/ws";
export const P2P_HISTORY = "https://api.p2pquake.net/v2/history";

export interface P2pOptions {
  url?: string;
  historyUrl?: string;
  connect?: Connect;
  fetch?: typeof fetch;
  log?: (m: string) => void;
}

export function p2pSource(ctx: SourceContext, opts: P2pOptions = {}): Source {
  const status = new StatusTracker("p2p", ctx.onStatus);
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? ((m: string) => console.log(m));

  const take = (value: unknown) => {
    const o = value as { id?: unknown; code?: unknown };
    if (typeof o?.id !== "string") return;
    const items = parseP2p(value);
    if (items.length === 0) return;
    if (ctx.seen("p2p", o.id)) return;
    status.seen(true);
    ctx.emit({
      source: "p2p",
      key: o.id,
      code: String(o.code),
      body: JSON.stringify(value),
      items,
    });
  };

  /** 切れていた間の分。古い順に入れる */
  async function backfill(signal: AbortSignal) {
    const url = new URL(opts.historyUrl ?? P2P_HISTORY);
    for (const c of P2P_CODES) url.searchParams.append("codes", String(c));
    url.searchParams.set("limit", "30");
    const res = await doFetch(url, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!res.ok) throw new Error(`history が ${res.status} を返しました`);
    const list = (await res.json()) as unknown[];
    if (!Array.isArray(list)) return;
    for (const item of [...list].reverse()) take(item);
  }

  return {
    id: "p2p",
    status: () => status.get(),
    async run(signal) {
      await runSocket({
        url: opts.url ?? P2P_WS,
        signal,
        status,
        connect: opts.connect,
        log,
        // P2P は heartbeat を送ってこない (静かなときは何分も何も来ない)。切れたことは close で知る
        idleMs: null,
        onOpen: () => backfill(signal),
        onMessage(text) {
          status.seen(false);
          take(JSON.parse(text));
        },
      });
    },
  };
}
