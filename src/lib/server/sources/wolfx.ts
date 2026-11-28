/**
 * Wolfx Open API の WebSocket (`wss://ws-api.wolfx.jp/all_eew`)。気象庁の緊急地震速報 (`jma_eew`) と、
 * 地震情報の一覧 (`jma_eqlist`、P2P地震情報の予備)、南海トラフ地震臨時情報など (`jma_special_eq`、
 * 気象庁 XML の予備)、津波の警報・注意報・予報 (`jma_tsunami`、P2P地震情報の 552 の予備) を 1 つの接続で受ける。
 *
 * - 接続は 1 本 (文書の「接続は再利用し、短時間に接続を繰り返さない」)。`all_eew` は Wolfx のすべての JSON API の配信を流すので、`type` で
 *   使うものだけを採り、ほか (中国の速報など) は捨てる。`exclude` で外さない訳は docs/design.md の 1 章の「入れない」
 * - つながったら `query_jmaeqlist`・`query_jmaspecialeq`・`query_jmatsunami` を送り、いまのものを受ける (切れていた間の分を埋める)。
 *   問い合わせは続けて送ると最初の 1 つにしか答えないので、間を 2 秒空ける (2026-11-28 に確かめた)
 * - 地震のときに Wolfx が一覧を自分から送ってくるかは確かめられていないので、つながっている間は
 *   最後に一覧を受けてから 60 秒たつごとに問い合わせ直す (自分から送ってきたら、そこから数え直す)
 * - サーバーは約 1 分ごとに heartbeat を送る。応えて `ping` を送る (推奨されている)
 * - 原文 (`OriginalText`) は受けたら捨てる。raw_messages には鍵だけを残す
 */

import { nowIso } from "#lib/server/time.ts";

import {
  type Connect,
  runSocket,
  type SocketLike,
  StatusTracker,
} from "./retry.ts";
import type { Normalized, Source, SourceContext } from "./types.ts";
import {
  parseWolfx,
  parseWolfxEqlist,
  parseWolfxSpecialEq,
  parseWolfxTsunami,
} from "./wolfx-json.ts";

const WOLFX_WS = "wss://ws-api.wolfx.jp/all_eew";

/**
 * 地震情報の一覧を問い合わせ直す間隔。Wolfx の文書に回数の目安は無い (同じ接続を使い続け、つなぎ直しを
 * 繰り返さないことだけが書かれている) ので、heartbeat と同じ 1 分にする。一覧は約 12KB で、1 日 17MB ほど
 */
const EQLIST_POLL_MS = 60_000;

/** 問い合わせの間を空ける長さ。続けて送ると、Wolfx は最初の 1 つにしか答えない (2026-11-28 に確かめた) */
const QUERY_GAP_MS = 2_000;

export interface WolfxOptions {
  url?: string;
  connect?: Connect;
  log?: (m: string) => void;
  /** 地震情報の一覧の報の時刻 (受けた時刻)。テストで差し替える */
  now?: () => string;
  /** 地震情報の一覧を問い合わせ直す間隔。テストで差し替える */
  eqlistPollMs?: number;
  /** 問い合わせの間を空ける長さ。テストで差し替える */
  queryGapMs?: number;
}

export function wolfxSource(
  ctx: SourceContext,
  opts: WolfxOptions = {},
): Source {
  const status = new StatusTracker("wolfx", ctx.onStatus, {
    kind: "websocket",
  });
  const now = opts.now ?? nowIso;
  const pollMs = opts.eqlistPollMs ?? EQLIST_POLL_MS;
  const gapMs = opts.queryGapMs ?? QUERY_GAP_MS;
  const log = opts.log ?? ((m: string) => console.log(m));
  let poll: ReturnType<typeof setTimeout> | undefined;
  /** いまつながっている接続。切れたら外す (切れた接続には問い合わせない) */
  let current: SocketLike | undefined;
  /** まだ送っていない問い合わせと、次を送れるようになるまでの待ち */
  let queue: string[] = [];
  let wait: ReturnType<typeof setTimeout> | undefined;
  let lastAskAt = Number.NEGATIVE_INFINITY;

  /** 問い合わせを並べ、前の問い合わせから gapMs 空けて送る。同じものが並んでいれば重ねない */
  function ask(ws: SocketLike, command: string) {
    if (ws !== current) return;
    if (!queue.includes(command)) queue.push(command);
    pump(ws);
  }
  function pump(ws: SocketLike) {
    if (ws !== current || wait !== undefined) return;
    const left = lastAskAt + gapMs - Date.now();
    if (left > 0) {
      wait = setTimeout(() => {
        wait = undefined;
        pump(ws);
      }, left);
      return;
    }
    const command = queue.shift();
    if (command === undefined) return;
    lastAskAt = Date.now();
    try {
      ws.send(command);
    } catch (e) {
      // 閉じかけの接続。close を受けたら止まり、つなぎ直したら onOpen から始め直す
      log(`[wolfx] ${command} を問い合わせられませんでした: ${e}`);
    }
    if (queue.length > 0) pump(ws);
  }

  /** 次の一覧の問い合わせを pollMs 後に置き直す (問い合わせたときと、一覧を受けたとき) */
  function schedule(ws: SocketLike) {
    if (ws !== current) return;
    clearTimeout(poll);
    poll = setTimeout(() => query(ws), pollMs);
  }
  function query(ws: SocketLike) {
    if (ws !== current) return;
    ask(ws, "query_jmaeqlist");
    schedule(ws);
  }

  /** 読んだ報のうち、まだ受けていない鍵のものだけを渡す */
  function emitNew(code: string, list: { key: string; item: Normalized }[]) {
    for (const { key, item } of list) {
      if (ctx.seen("wolfx", key)) continue;
      status.seen(true);
      ctx.emit({ source: "wolfx", key, code, items: [item] });
    }
  }

  return {
    id: "wolfx",
    status: () => status.get(),
    async run(signal) {
      await runSocket({
        url: opts.url ?? WOLFX_WS,
        signal,
        status,
        connect: opts.connect,
        log,
        onOpen(ws) {
          current = ws;
          queue = [];
          lastAskAt = Number.NEGATIVE_INFINITY;
          query(ws);
          ask(ws, "query_jmaspecialeq");
          ask(ws, "query_jmatsunami");
        },
        onClose() {
          // 切れている間は問い合わせない。つなぎ直したら onOpen から始め直す
          current = undefined;
          clearTimeout(poll);
          poll = undefined;
          clearTimeout(wait);
          wait = undefined;
          queue = [];
        },
        onMessage(text, ws) {
          status.seen(false);
          const value = JSON.parse(text) as Record<string, unknown>;
          delete value.OriginalText;
          if (value.type === "jma_eqlist") {
            // 問い合わせの答えでも、Wolfx が自分から送ってきたものでも、次の問い合わせはここから数える
            schedule(ws);
            // 一覧は毎回 50 件まるごと来る。中身の変わった行だけが新しい鍵になる
            emitNew("jma_eqlist", parseWolfxEqlist(value, now()));
            return;
          }
          if (value.type === "jma_tsunami") {
            // Wolfx は信頼期限を延ばすたびに (約 1 分ごと) 同じ報を送ってくる。報と予報区の中身が同じなら鍵も同じ
            emitNew("jma_tsunami", parseWolfxTsunami(value));
            return;
          }
          if (value.type === "jma_special_eq") {
            // 南海トラフ地震臨時情報など。電文の種別ごとの最新の報がまとめて来る
            emitNew("jma_special_eq", parseWolfxSpecialEq(value));
            return;
          }
          const m = parseWolfx(value);
          if (m.type === "heartbeat") {
            ws.send("ping");
            return;
          }
          if (m.type !== "eew") return;
          if (ctx.seen("wolfx", m.key)) return;
          status.seen(true);
          ctx.emit({
            source: "wolfx",
            key: m.key,
            code: "jma_eew",
            items: [{ type: "eew", report: m.report }],
          });
        },
      });
    },
  };
}
