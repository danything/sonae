/**
 * 受信を起こす。hooks.server.ts の init から 1 回だけ呼ぶ (docs/design.md の 2 章)。
 * 1 つのプロセスで受信も配信もする (Wolfx の 1 接続・P2P の 2 接続を守るため、レプリカは 1 つ)。
 */

import type { EventEmitter } from "node:events";

import type { SourceStatus } from "#lib/model.ts";

import { Broker } from "./broker.ts";
import { db } from "./db.ts";
import { Pusher, vapidFromEnv } from "./push.ts";
import { cwaSource } from "./sources/cwa.ts";
import { emscSource } from "./sources/emsc.ts";
import { geonetSource } from "./sources/geonet.ts";
import { bosaiTsunamiSource } from "./sources/jma-bosai.ts";
import { jmaSource } from "./sources/jma.ts";
import { p2pSource } from "./sources/p2p.ts";
import { ptwcSource } from "./sources/ptwc.ts";
import type { Incoming, Source, SourceContext } from "./sources/types.ts";
import { usgsSource } from "./sources/usgs.ts";
import { wolfxSource } from "./sources/wolfx.ts";
import { Store } from "./store.ts";

interface App {
  store: Store;
  broker: Broker;
  sources: Source[];
  /** Web Push の送り手。VAPID の鍵が無ければ無い (機能を切る) */
  pusher?: Pusher;
  stop?: () => void;
}

// 開発サーバーがモジュールを読み直しても、受信を二重に起こさない
const g = globalThis as typeof globalThis & { __sonae?: App };

/** DB と配り手。受信を起こしていなくても使える (画面の load から読む) */
export function app(): App {
  if (!g.__sonae) {
    const d = db();
    const { vapid, problem } = vapidFromEnv();
    if (problem) console.warn(`[push] ${problem}。Web Push は切ります`);
    g.__sonae = {
      store: new Store(d),
      broker: new Broker(),
      sources: [],
      pusher: vapid ? new Pusher(d, vapid) : undefined,
    };
  }
  return g.__sonae;
}

export function statuses(): SourceStatus[] {
  return app().sources.map((s) => s.status());
}

export function startReceiving(): void {
  const a = app();
  if (a.stop) return;
  const controller = new AbortController();
  const ctx: SourceContext = {
    seen: (source, key) => a.store.seen(source, key),
    emit(m: Incoming) {
      for (const e of a.store.ingest(m)) a.broker.publish(e);
    },
    onStatus(s) {
      const why =
        s.state === "retrying" && s.lastError ? ` (${s.lastError})` : "";
      console.log(`[${s.id}] ${s.state}${why}`);
    },
  };
  a.sources = [
    jmaSource(ctx),
    p2pSource(ctx),
    wolfxSource(ctx),
    usgsSource(ctx),
    ptwcSource(ctx),
    emscSource(ctx),
    bosaiTsunamiSource(ctx),
    geonetSource(ctx),
  ];
  // 台湾の中央氣象署は授権碼が要る。無ければ作らない (docs/cwa.md)
  const cwa = cwaSource(ctx);
  if (cwa) a.sources.push(cwa);
  else
    console.log(
      "[cwa] 授権碼 (CWA_API_KEY) が無いので、中央氣象署の受信は切ってあります",
    );
  for (const s of a.sources) {
    s.run(controller.signal).catch((err: unknown) =>
      console.error(`[${s.id}] 受信が止まりました: ${err}`),
    );
  }
  // 受けたものを Web Push でも知らせる (鍵が無ければ何もしない)
  const pusher = a.pusher;
  const unpush = pusher
    ? a.broker.subscribe((e) => {
        pusher
          .handle(e)
          .catch((err: unknown) =>
            console.warn(`[push] 知らせられませんでした: ${err}`),
          );
      })
    : undefined;
  console.log(
    pusher
      ? "[push] Web Push を送ります"
      : "[push] VAPID の鍵 (VAPID_PRIVATE_JWK) が無いので、Web Push は切ってあります",
  );
  // 古い原文と、Web Push の送った控えを捨てる (1 時間ごと)
  const prune = setInterval(() => {
    try {
      a.store.prune();
      a.pusher?.prune();
    } catch (err) {
      console.warn(`[store] 古い原文を捨てられませんでした: ${err}`);
    }
  }, 60 * 60_000);
  a.stop = () => {
    controller.abort();
    clearInterval(prune);
    unpush?.();
    a.stop = undefined;
  };
  // adapter-bun は SIGTERM で HTTP を止めたあと、この合図を出して、イベントループが空くのを待つ。
  // 受信の輪を止めないと、いつまでも終わらない (k8s の入れ替えが遅れる)
  (process as EventEmitter).once("sveltekit:shutdown", () => a.stop?.());
  console.log(
    "[receiver] 気象庁・P2P地震情報・Wolfx・USGS・PTWC・EMSC・気象庁 bosai (国際津波)・GeoNet の受信を始めました",
  );
}
