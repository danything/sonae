import { app, statuses } from "#lib/server/receiver.ts";
import { sseFrame, sseStream } from "#lib/server/sse.ts";

import type { RequestHandler } from "./$types";

/**
 * SSE (docs/design.md の 2.3)。`Last-Event-ID` (張り直したとき) か `?after=` (最初の接続) より後を
 * DB から送ってから、生の配信に移る。30 秒ごとに `: ping` と情報源の状況を送る。
 */
export const GET: RequestHandler = ({ request, url }) => {
  const { store, broker } = app();
  const raw =
    request.headers.get("last-event-id") ?? url.searchParams.get("after");
  const after =
    raw !== null && /^\d+$/.test(raw) ? Number(raw) : store.lastSeq();
  return sseStream({
    backlog: (limit) => store.eventsAfter(after, limit),
    latestSeq: () => store.lastSeq(),
    subscribe: (fn) => broker.subscribe(fn),
    status: () => sseFrame({ event: "status", data: statuses() }),
    signal: request.signal,
  });
};
