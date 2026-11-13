import { app } from "#lib/server/receiver.ts";
import { readView } from "#lib/view.ts";

import type { PageServerLoad } from "./$types";

/**
 * 1 つの画面の、選んだものと緊急地震速報の一覧。いまの姿 (新しい 100 件など) は +layout.server.ts が渡す。
 * 選んだものはそこに無いこともある (共有された古い地震) ので、ここで DB から引く。無ければ null (画面が「ありません」と出す)
 */
export const load: PageServerLoad = ({ url }) => {
  const { store } = app();
  const view = readView(url.searchParams);
  const id = view.selected?.id;
  const kind = view.selected?.kind;
  return {
    training: view.training,
    // 訓練・試験は既定で隠す。`?training=1` で出す
    eewHistory: store.eews(50, view.training),
    quake: kind === "quake" && id ? (store.quake(id) ?? null) : null,
    tsunami: kind === "tsunami" && id ? (store.tsunami(id) ?? null) : null,
    eew:
      kind === "eew" && id
        ? (store.eew(id) ??
          store.eew(id, "training") ??
          store.eew(id, "test") ??
          null)
        : null,
  };
};
