import { app, statuses } from "#lib/server/receiver.ts";
import { sseFrame, sseStream } from "#lib/server/sse.ts";

import type { RequestHandler } from "./$types";

/**
 * SSE (docs/design.md の 2.3)。`Last-Event-ID` (張り直したとき) か `?after=` (最初の接続) より後を
 * DB から送ってから、生の配信に移る。30 秒ごとに `: ping` と情報源の状況を送る。
 * 読み上げの声 (`event: voice`、`{ voice }`) は、つないだときと替わったときに送る (2.4)。
 * 台湾の観測点の表 (`event: rts-stations`) といまの揺れ (`event: rts`)、SeisJS の観測点の表 (`event: seis-stations`) と
 * いまの揺れ (`event: seis`) も、つないだときと替わったときに送る (2.9・2.10)。
 * どれも番号を付けず、埋め直しもしない (いまの値だけ)
 */
export const GET: RequestHandler = ({ request, url }) => {
  const { store, broker, voice, rts, seis } = app();
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
    notices: (send) => {
      const stops: (() => void)[] = [];
      if (voice) {
        send(voiceFrame(voice.speaker));
        stops.push(voice.onVoice((id) => send(voiceFrame(id))));
      }
      for (const board of [rts, seis]) {
        const stations = board.stations();
        if (stations.stations.length > 0)
          send(sseFrame({ event: board.events.stations, data: stations }));
        const now = board.current();
        if (now) send(sseFrame({ event: board.events.frame, data: now }));
        stops.push(
          board.subscribe((event, data) => send(sseFrame({ event, data }))),
        );
      }
      return () => {
        for (const stop of stops) stop();
      };
    },
    signal: request.signal,
  });
};
