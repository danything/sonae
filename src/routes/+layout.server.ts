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
      foreignQuakes: store.foreignQuakes(100),
      volcanoes: store.volcanoes(50),
      volcanoLevels: store.volcanoLevels(),
      longPeriods: store.longPeriods(50),
      // 解除された市町村等 (released) は通知にだけ使うので、画面には渡さない (大きさを抑える)
      warnings: store
        .warnings()
        .filter((w) => w.areas.length > 0)
        .map((w) => ({ ...w, released: [] })),
      weatherInfos: store.weatherInfos(100),
      outlooks: store.outlooks(),
      statuses: statuses(),
    },
  };
};
