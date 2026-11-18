/**
 * Web Push と Webhook の送り手が使う、通知の判定のサーバーの側 (docs/design.md の 2.4)。
 * 判定そのものは画面と同じ `#lib/notify.ts`。ここでは中身の値 (SHA-256) と Topic と、送り先ごとの控えを扱う。
 */

import type { Database } from "bun:sqlite";

import {
  advisoryQuotaTag,
  contentOf,
  decide,
  decideDaily,
  isAdvisoryOnly,
  type Notice,
  noticesFor,
  type Plan,
  type Sent,
} from "#lib/notify.ts";
import type { PushPrefs } from "#lib/push.ts";

export { matches, noticeOf, payloadOf, type Sent } from "#lib/notify.ts";

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
 * Webhook (`webhook_log`、鍵は Webhook の id) が同じ作りで使う
 */
export interface SentLog {
  /** 前に送ったもの。無ければ undefined */
  get(key: string | number, tag: string): Sent | undefined;
  /** 送ると決めた通知を控える (重さは `keptLevel` と同じ。続報では上がったときだけ上げ、解除・取消で戻す) */
  put(key: string | number, n: Notice, at: number): void;
  /**
   * 送れなかった通知の控えを、送る前に戻す。初めての通知なら消し (次の続報を「初めて」として扱い、
   * 通知が一度も出ないことを避ける)、前に届いていたなら、その時の控えに戻す (鳴らし直さない)。
   * 待つ間に後の続報が控えを書き換えていたら、そちらを残す
   */
  undo(key: string | number, n: Notice, prev: Sent | undefined): void;
  /** 通知ではない控え (注意報を数えた日など) を、この値のまま書く */
  mark(key: string | number, tag: string, s: Sent, at: number): void;
  /** `mark` で書いた控えを、前の控えに戻す (無ければ消す)。待つ間に書き換わっていたら、そちらを残す */
  unmark(
    key: string | number,
    tag: string,
    prev: Sent | undefined,
    digest: string,
  ): void;
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
  const unmark: SentLog["unmark"] = (key, tag, prev, digest) => {
    if (prev) {
      db.query(
        `UPDATE ${table} SET level = ?, digest = ? WHERE ${col} = ? AND tag = ? AND digest = ?`,
      ).run(prev.level, prev.digest, key, tag, digest);
    } else {
      db.query(
        `DELETE FROM ${table} WHERE ${col} = ? AND tag = ? AND digest = ?`,
      ).run(key, tag, digest);
    }
  };
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
         ON CONFLICT (${col}, tag) DO UPDATE SET
           level = CASE WHEN ? THEN excluded.level ELSE max(level, excluded.level) END,
           digest = excluded.digest, sent_at = excluded.sent_at`,
      ).run(key, n.tag, n.level, digestOf(n), at, n.closing ? 1 : 0);
    },
    undo(key, n, prev) {
      unmark(key, n.tag, prev, digestOf(n));
    },
    mark(key, tag, s, at) {
      db.query(
        `INSERT INTO ${table} (${col}, tag, level, digest, sent_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (${col}, tag) DO UPDATE SET level = excluded.level,
           digest = excluded.digest, sent_at = excluded.sent_at`,
      ).run(key, tag, s.level, s.digest, at);
    },
    unmark,
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
  /** 注意報だけの通知を数えたとき、数える控えの tag と、数える前の控え (送れなかったら戻す) */
  quota?: { tag: string; prev: Sent | undefined; day: string };
}

/**
 * 送り先ごとに鳴らすかを決めて控える。続報が続けて来ても同じ事象で二重に鳴らさないよう、
 * ここまでは 1 つのトランザクションで同期でする (送るのは呼ぶ側が後で、待たずに並べる)。
 * 注意報だけの通知は、送り先ごとに 1 日 1 回まで (`decideDaily`)。
 * `replaceable` が false の送り先 (Webhook。前の投稿を置き換えられない) には、注意報だけの通知の
 * 鳴らさない続報は送らない (新しい投稿になり、1 日 1 回を超えて届くため)
 */
export function planSends<T extends { prefs: PushPrefs }>(
  db: Database,
  log: SentLog,
  n: Notice,
  targets: T[],
  keyOf: (t: T) => string | number,
  at: number,
  replaceable = true,
): Job<T>[] {
  const jobs: Job<T>[] = [];
  db.transaction(() => {
    // 気象は住んでいる地域で中身が変わるので、送り先ごとに作る。府県予報区ごとに知らせる段が終わったことを
    // 伝える通知も足す (閉じる通知なので、前にその tag で知らせた送り先にだけ送る。`noticesFor`)
    const each = targets.flatMap((target) =>
      noticesFor(n, target.prefs).map((m) => ({ target, m })),
    );
    for (const { target, m } of each) {
      const key = keyOf(target);
      const prev = log.get(key, m.tag);
      const qTag = advisoryQuotaTag(m);
      const qPrev = isAdvisoryOnly(m) ? log.get(key, qTag) : undefined;
      const p = decideDaily(
        m,
        target.prefs,
        prev,
        digestOf(m),
        null,
        qPrev,
        at,
      );
      if (!p.send) continue;
      if (!replaceable && !p.renotify && isAdvisoryOnly(m)) continue;
      log.put(key, m, at);
      const job: Job<T> = { target, notice: m, renotify: p.renotify, prev };
      if (p.day) {
        log.mark(key, qTag, { level: 0, digest: p.day }, at);
        job.quota = { tag: qTag, prev: qPrev, day: p.day };
      }
      jobs.push(job);
    }
  })();
  return jobs;
}

/** 送れなかった 1 件の控えを、送る前に戻す (数えた注意報も戻す) */
export function undoJob<T>(
  log: SentLog,
  key: string | number,
  j: Job<T>,
): void {
  log.undo(key, j.notice, j.prev);
  if (j.quota) log.unmark(key, j.quota.tag, j.quota.prev, j.quota.day);
}
