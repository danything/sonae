import { app, statuses } from "#lib/server/receiver.ts";

import type { LayoutServerLoad } from "./$types";

/** どの画面でも使う「いまの姿」。SSE はここの lastSeq の後から差分だけを送る */
export const load: LayoutServerLoad = ({ locals }) => {
  const { store } = app();
  return {
    user: locals.user ?? null,
    snapshot: {
      lastSeq: store.lastSeq(),
      eews: store.eews(20),
      quakes: store.quakes(100),
      tsunamis: store.tsunamis(20),
      advisories: store.advisories(50),
      volcanoes: store.volcanoes(50),
      volcanoLevels: store.volcanoLevels(),
      longPeriods: store.longPeriods(50),
      statuses: statuses(),
    },
  };
};
