/**
 * 受信を起こす。hooks.server.ts の init から 1 回だけ呼ぶ (docs/design.md の 2 章)。
 * 1 つのプロセスで受信も配信もする (Wolfx の 1 接続・P2P の 2 接続を守るため、レプリカは 1 つ)。
 */

import type { EventEmitter } from "node:events";

import type { SourceStatus } from "#lib/model.ts";

import { Broker } from "./broker.ts";
import { db } from "./db.ts";
import { jmaSource } from "./sources/jma.ts";
import { p2pSource } from "./sources/p2p.ts";
import type { Incoming, Source, SourceContext } from "./sources/types.ts";
import { wolfxSource } from "./sources/wolfx.ts";
import { Store } from "./store.ts";

interface App {
  store: Store;
  broker: Broker;
  sources: Source[];
  stop?: () => void;
}

// 開発サーバーがモジュールを読み直しても、受信を二重に起こさない
const g = globalThis as typeof globalThis & { __sonae?: App };

/** DB と配り手。受信を起こしていなくても使える (画面の load から読む) */
export function app(): App {
  g.__sonae ??= { store: new Store(db()), broker: new Broker(), sources: [] };
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
  a.sources = [jmaSource(ctx), p2pSource(ctx), wolfxSource(ctx)];
  for (const s of a.sources) {
    s.run(controller.signal).catch((err: unknown) =>
      console.error(`[${s.id}] 受信が止まりました: ${err}`),
    );
  }
  // 古い原文を捨てる (1 時間ごと)
  const prune = setInterval(() => {
    try {
      a.store.prune();
    } catch (err) {
      console.warn(`[store] 古い原文を捨てられませんでした: ${err}`);
    }
  }, 60 * 60_000);
  a.stop = () => {
    controller.abort();
    clearInterval(prune);
    a.stop = undefined;
  };
  // adapter-bun は SIGTERM で HTTP を止めたあと、この合図を出して、イベントループが空くのを待つ。
  // 受信の輪を止めないと、いつまでも終わらない (k8s の入れ替えが遅れる)
  (process as EventEmitter).once("sveltekit:shutdown", () => a.stop?.());
  console.log("[receiver] 気象庁・P2P地震情報・Wolfx の受信を始めました");
}
