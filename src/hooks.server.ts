import type { ServerInit } from "@sveltejs/kit/hooks";

import { startReceiving } from "#lib/server/receiver.ts";

/**
 * 起動したときに 1 回だけ、受信を起こす。`SONAE_RECEIVE=off` で止められる
 * (情報源につながずに画面だけ触りたいとき)。
 */
export const init: ServerInit = () => {
  if (process.env.SONAE_RECEIVE === "off") {
    console.warn("SONAE_RECEIVE=off なので、情報源につながりません");
    return;
  }
  startReceiving();
};
