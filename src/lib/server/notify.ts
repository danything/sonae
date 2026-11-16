/**
 * Web Push と Webhook の送り手が使う、通知の判定のサーバーの側 (docs/design.md の 2.4)。
 * 判定そのものは画面と同じ `#lib/notify.ts`。ここでは中身の値 (SHA-256) と Topic と、送り先ごとの控えを扱う。
 */

import type { Database } from "bun:sqlite";

import {
  contentOf,
  decide,
  type Notice,
  noticeFor,
  type Plan,
  type Sent,
} from "#lib/notify.ts";
import type { PushPrefs } from "#lib/push.ts";

export {
  matches,
  type Notice,
  noticeFor,
  noticeOf,
  payloadOf,
  type Plan,
  type Sent,
} from "#lib/notify.ts";

/** 中身が変わったかを見るための値 (push_log・webhook_log の digest) */
export const digestOf = (n: Pick<Notice, "title" | "body" | "changeKey">) =>
  new Bun.CryptoHasher("sha256")
    .update(contentOf(n))
    .digest("hex")
    .slice(0, 16);

/** 送り先ごとに鳴らすかを決める (`decide` に、この送り先の控えと中身の値を渡す) */
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

/**
 * 送り先ごとに、事象 (tag) へ最後に送ったものの控え。Web Push (`push_log`、鍵は購読の endpoint) と
 * Webhook (`webhook_log`、鍵は Webhook の id) が同じ形で使う
 */
export interface SentLog {
  /** 前に送ったもの。無ければ undefined */
  get(key: string | number, tag: string): Sent | undefined;
  /** 送ると決めた通知を控える (重さは上がったときだけ上げる) */
  put(key: string | number, n: Notice, at: number): void;
  /**
   * 送れなかった通知の控えを、送る前に戻す。初めての通知なら消し (次の続報を「初めて」として扱い、
   * 通知が一度も出ないことを避ける)、前に届いていたなら、その時の控えに戻す (鳴らし直さない)。
   * 待つ間に後の続報が控えを書き換えていたら、そちらを残す
   */
  undo(key: string | number, n: Notice, prev: Sent | undefined): void;
  /** この時刻 (ミリ秒) より前の控えを捨てる。捨てた数を返す */
  prune(before: number): number;
}

/** 控えの表と、送り先の鍵の列。この 2 組だけを SQL に組み込む (人から来る値は組み込まない) */
const LOG_TABLES = {
  push_log: "endpoint",
  webhook_log: "webhook_id",
} as const;

export function sentLog(db: Database, table: keyof typeof LOG_TABLES): SentLog {
  const col = LOG_TABLES[table];
  return {
    get: (key, tag) =>
      db
        .query<Sent, [string | number, string]>(
          `SELECT level, digest FROM ${table} WHERE ${col} = ? AND tag = ?`,
        )
        .get(key, tag) ?? undefined,
    put(key, n, at) {
      db.query(
        `INSERT INTO ${table} (${col}, tag, level, digest, sent_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (${col}, tag) DO UPDATE SET level = max(level, excluded.level),
           digest = excluded.digest, sent_at = excluded.sent_at`,
      ).run(key, n.tag, n.level, digestOf(n), at);
    },
    undo(key, n, prev) {
      if (prev) {
        db.query(
          `UPDATE ${table} SET level = ?, digest = ? WHERE ${col} = ? AND tag = ? AND digest = ?`,
        ).run(prev.level, prev.digest, key, n.tag, digestOf(n));
      } else {
        db.query(
          `DELETE FROM ${table} WHERE ${col} = ? AND tag = ? AND digest = ?`,
        ).run(key, n.tag, digestOf(n));
      }
    },
    prune: (before) =>
      db.query(`DELETE FROM ${table} WHERE sent_at < ?`).run(before).changes,
  };
}

/** 送ると決めた 1 件 */
export interface Job<T> {
  target: T;
  notice: Notice;
  renotify: boolean;
  /** 送る前の控え (送れなかったら戻す) */
  prev: Sent | undefined;
}

/**
 * 送り先ごとに鳴らすかを決めて控える。続報が続けて来ても同じ事象で二重に鳴らさないよう、
 * ここまでは 1 つのトランザクションで同期でする (送るのは呼ぶ側が後で、待たずに並べる)
 */
export function planSends<T extends { prefs: PushPrefs }>(
  db: Database,
  log: SentLog,
  n: Notice,
  targets: T[],
  keyOf: (t: T) => string | number,
  at: number,
): Job<T>[] {
  const jobs: Job<T>[] = [];
  db.transaction(() => {
    for (const target of targets) {
      // 気象は住んでいる地域で中身が変わるので、送り先ごとに作る
      const m = noticeFor(n, target.prefs);
      if (!m) continue;
      const key = keyOf(target);
      const prev = log.get(key, m.tag);
      const p = plan(m, target.prefs, prev);
      if (!p.send) continue;
      log.put(key, m, at);
      jobs.push({ target, notice: m, renotify: p.renotify, prev });
    }
  })();
  return jobs;
}
