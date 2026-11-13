/**
 * Web Push の送り手が使う、通知の判定のサーバーの側 (docs/design.md の 2.4)。
 * 判定そのものは画面と同じ `#lib/notify.ts`。ここでは中身の値 (SHA-256) と Topic と送る本文を作る。
 */

import {
  contentOf,
  decide,
  type Notice,
  type Plan,
  type Sent,
} from "#lib/notify.ts";
import type { PushPayload, PushPrefs } from "#lib/push.ts";

export {
  matches,
  type Notice,
  noticeOf,
  type Plan,
  type Sent,
} from "#lib/notify.ts";

/** 中身が変わったかを見るための値 (push_log の digest) */
export const digestOf = (n: Pick<Notice, "title" | "body" | "changeKey">) =>
  new Bun.CryptoHasher("sha256")
    .update(contentOf(n))
    .digest("hex")
    .slice(0, 16);

/** 購読ごとに鳴らすかを決める (`decide` に、この購読の控えと中身の値を渡す) */
export const plan = (
  n: Notice,
  prefs: PushPrefs,
  prev: Sent | undefined,
): Plan => decide(n, prefs, prev, digestOf(n));

/**
 * Web Push の Topic。配信サービスがまだ届けていない同じ Topic の通知を置き換える。
 * 32 文字までの URL セーフな字なので、tag の SHA-256 の先頭を使う
 */
export const topicOf = (tag: string) =>
  new Bun.CryptoHasher("sha256").update(tag).digest("hex").slice(0, 32);

export function payloadOf(n: Notice, renotify: boolean): PushPayload {
  return {
    title: n.title,
    body: n.body,
    tag: n.tag,
    url: n.url,
    renotify,
    sticky: n.sticky,
    timestamp: n.at,
  };
}
