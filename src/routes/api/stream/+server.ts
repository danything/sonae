import { app, statuses } from "#lib/server/receiver.ts";
import { sseFrame, sseStream } from "#lib/server/sse.ts";

import type { RequestHandler } from "./$types";

/**
 * SSE (docs/design.md の 2.3)。`Last-Event-ID` (張り直したとき) か `?after=` (最初の接続) より後を
 * DB から送ってから、生の配信に移る。30 秒ごとに `: ping` と情報源の状況を送る。
 * 読み上げの声 (`event: voice`、`{ voice }`) は、つないだときと替わったときに送る (2.4)。
 */
export const GET: RequestHandler = ({ request, url }) => {
  const { store, broker, voice } = app();
  const raw =
    request.headers.get("last-event-id") ?? url.searchParams.get("after");
  const after =
    raw !== null && /^\d+$/.test(raw) ? Number(raw) : store.lastSeq();
  const voiceFrame = (id: number) =>
    sseFrame({ event: "voice", data: { voice: id } });
  return sseStream({
    backlog: (limit) => store.eventsAfter(after, limit),
    latestSeq: () => store.lastSeq(),
    subscribe: (fn) => broker.subscribe(fn),
    status: () => sseFrame({ event: "status", data: statuses() }),
    notices: voice
      ? (send) => {
          send(voiceFrame(voice.speaker));
          return voice.onVoice((id) => send(voiceFrame(id)));
        }
      : undefined,
    signal: request.signal,
  });
};
