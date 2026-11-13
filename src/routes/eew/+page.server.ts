import { app } from "#lib/server/receiver.ts";

import type { PageServerLoad } from "./$types";

/** 訓練・試験は既定で隠す。`?training=1` で出す */
export const load: PageServerLoad = ({ url }) => {
  const training = url.searchParams.get("training") === "1";
  return { training, history: app().store.eews(50, training) };
};
