/**
 * 受信を起こす。hooks.server.ts の init から 1 回だけ呼ぶ (docs/design.md の 2 章)。
 * 1 つのプロセスで受信も配信もする (Wolfx の 1 接続・P2P の 2 接続を守るため、レプリカは 1 つ)。
 */

import type { EventEmitter } from "node:events";

import { SOURCE_LABEL } from "#lib/format.ts";
import type { SourceStatus } from "#lib/model.ts";

import { Broker } from "./broker.ts";
import { db } from "./db.ts";
import { Pusher, vapidFromEnv } from "./push.ts";
import { publicOrigin } from "./site.ts";
import { cwaSource } from "./sources/cwa.ts";
import { emscSource } from "./sources/emsc.ts";
import { geonetSource } from "./sources/geonet.ts";
import { bosaiTsunamiSource } from "./sources/jma-bosai.ts";
import { jmaSource, jmaWeatherSource } from "./sources/jma.ts";
import { p2pSource } from "./sources/p2p.ts";
import { ptwcSource } from "./sources/ptwc.ts";
import { RtsBoard, tremSource } from "./sources/trem.ts";
import type { Incoming, Source, SourceContext } from "./sources/types.ts";
import { usgsSource } from "./sources/usgs.ts";
import { wolfxSource } from "./sources/wolfx.ts";
import { Store } from "./store.ts";
import { type Voicevox, voicevoxFromEnv } from "./voicevox.ts";
import { Webhooks } from "./webhook.ts";

interface App {
  store: Store;
  broker: Broker;
  sources: Source[];
  /** 設定で切ってある情報源の状態 (`off`)。受信はしないが、「受信の状態」に並べる */
  off: SourceStatus[];
  /** Web Push の送り手。VAPID の鍵が無ければ無い (機能を切る) */
  pusher?: Pusher;
  /** Webhook (Discord・Slack など) の送り手。鍵は要らないので、いつもある */
  webhooks: Webhooks;
  /**
   * 台湾の観測点のいまの揺れ (TREM-RTS)。メモリだけに持ち、開いている画面に配る (地図の点の色だけ)。
   * DB にも Broker にも入れないので、Web Push・Webhook・読み上げには届かない (docs/design.md の 2.9)
   */
  rts: RtsBoard;
  /** 読み上げの音を作る VOICEVOX。`VOICEVOX_URL` が無ければ無い (画面は端末の読み上げで読む) */
  voice?: Voicevox;
  stopVoice?: () => void;
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
      off: [],
      pusher: vapid ? new Pusher(d, vapid) : undefined,
      webhooks: new Webhooks(d, { origin: publicOrigin() }),
      rts: new RtsBoard(),
      voice: voicevoxFromEnv(d),
    };
  }
  return g.__sonae;
}

/** VOICEVOX につなぎ始める (受信を止めていても、「試しに鳴らす」で読み上げられるように)。hooks の init から 1 回だけ */
export function startVoice(): void {
  const a = app();
  if (!a.voice) {
    console.log(
      "[voicevox] VOICEVOX_URL が無いので、読み上げは端末の読み上げ (speechSynthesis) で読みます",
    );
    return;
  }
  if (a.stopVoice) return;
  a.stopVoice = a.voice.start();
  (process as EventEmitter).once("sveltekit:shutdown", () => {
    a.stopVoice?.();
    a.stopVoice = undefined;
  });
}

export function statuses(): SourceStatus[] {
  const a = app();
  return [...a.sources.map((s) => s.status()), ...a.off];
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
    jmaWeatherSource(ctx),
    p2pSource(ctx),
    wolfxSource(ctx),
    usgsSource(ctx),
    ptwcSource(ctx),
    emscSource(ctx),
    bosaiTsunamiSource(ctx),
    geonetSource(ctx),
  ];
  a.off = [];
  // 台湾の観測点の揺れ。受けたものは a.rts に入れるだけ (ctx の emit を渡さない。知らせに届かない)。
  // 非商用の条件のデータなので、`SONAE_TREM=off` で切れるようにしておく (README)
  if (process.env.SONAE_TREM?.trim().toLowerCase() === "off") {
    a.off.push({
      id: "trem",
      state: "off",
      reason: "SONAE_TREM=off で切ってあります",
      since: new Date().toISOString(),
    });
    console.log("[trem] SONAE_TREM=off なので、TREM の受信は切ってあります");
  } else a.sources.push(tremSource(a.rts, { onStatus: ctx.onStatus }));
  // 台湾の中央氣象署は授権碼が要る。無ければ作らない (docs/cwa.md)
  const cwa = cwaSource(ctx);
  if (cwa) a.sources.push(cwa);
  else {
    a.off.push({
      id: "cwa",
      state: "off",
      reason: "授権碼がありません",
      since: new Date().toISOString(),
    });
    console.log(
      "[cwa] 授権碼 (CWA_API_KEY) が無いので、中央氣象署の受信は切ってあります",
    );
  }
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
  // 受けたものを Webhook (Discord・Slack など) にも送る (登録が無ければ何もしない)
  const webhooks = a.webhooks;
  const unhook = a.broker.subscribe((e) => {
    webhooks
      .handle(e)
      .catch((err: unknown) =>
        console.warn(`[webhook] 知らせられませんでした: ${err}`),
      );
  });
  // 読み上げの音を前もって作る (VOICEVOX が無ければ何もしない)
  const voice = a.voice;
  const unvoice = voice
    ? a.broker.subscribe((e) => voice.handle(e))
    : undefined;
  console.log(
    pusher
      ? "[push] Web Push を送ります"
      : "[push] VAPID の鍵 (VAPID_PRIVATE_JWK) が無いので、Web Push は切ってあります",
  );
  // 古い原文と、Web Push・Webhook の送った控えを捨てる (1 時間ごと)
  const prune = setInterval(() => {
    try {
      a.store.prune();
      a.pusher?.prune();
      a.webhooks.prune();
    } catch (err) {
      console.warn(`[store] 古い原文を捨てられませんでした: ${err}`);
    }
  }, 60 * 60_000);
  a.stop = () => {
    controller.abort();
    clearInterval(prune);
    unpush?.();
    unhook();
    unvoice?.();
    a.stop = undefined;
  };
  // adapter-bun は SIGTERM で HTTP を止めたあと、この合図を出して、イベントループが空くのを待つ。
  // 受信の輪を止めないと、いつまでも終わらない (k8s の入れ替えが遅れる)
  (process as EventEmitter).once("sveltekit:shutdown", () => a.stop?.());
  // 並べるのは実際に起こした情報源 (切ってあるもの (TREM・授権碼の無い CWA) は上で別に出している)。
  // 手で書いた一覧だと、足した情報源が漏れる
  console.log(
    `[receiver] ${a.sources.map((s) => SOURCE_LABEL[s.id]).join("・")} の受信を始めました`,
  );
}
