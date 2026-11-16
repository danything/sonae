/**
 * Webhook の送り手と、送り先の保存 (docs/design.md の 2.4、運用は docs/push.md)。
 * Discord や Slack の Incoming Webhook へ、Web Push と同じ報を同じ見出しと本文で送る。
 * 作りは denpa の `src/lib/server/webhook.ts` にそろえる。
 *
 * - 鳴らすかどうかは Web Push と同じ判定と控え (`planSends`)。条件は Webhook ごとに持つ
 * - **URL は秘密** (知っていれば誰でも投稿できる)。画面にも記録にもホストだけを出す。
 *   送れなかった理由も、HTTP の状態か決まった言葉だけにする (例外の文には URL が入りうる)
 * - **宛先のアドレスは縛らない。** 家の中の Home Assistant のような LAN の送り先がふつうにあり、
 *   送り先を決めるのはログインした人だけだから。代わりに、送り先を足がかりに別の所を覗かせない
 *   (リダイレクトは追わない・相手の本文は読まずに捨て、返さない)
 * - 送るのは待たない。相手が遅くても、ほかの送り先と Web Push を待たせない (10 秒で切る)。送り直しもしない
 */

import type { Database } from "bun:sqlite";

import type { SonaeEvent } from "#lib/model.ts";
import { normalizePrefs, type PushPayload, type PushPrefs } from "#lib/push.ts";

import {
  type Job,
  noticeOf,
  payloadOf,
  planSends,
  type SentLog,
  sentLog,
} from "./notify.ts";

/** 1 人が持てる Webhook の数 */
export const MAX_WEBHOOKS = 10;
/** URL の長さの上限 (Discord・Slack の URL は 150 字ほど) */
const MAX_URL = 2048;
/** 送った控え (同じ事象で鳴らし直さないため) を残す日数。Web Push と同じ */
const LOG_DAYS = 30;

export interface Webhook {
  id: number;
  subject: string;
  /** 秘密。画面と記録には出さない (`hostOf`) */
  url: string;
  prefs: PushPrefs;
  createdAt: number;
  /** 最後に送った結果 (`ok` か、HTTP の状態・決まった言葉の理由)。まだ送っていなければ null */
  lastStatus: string | null;
  lastSentAt: number | null;
}

interface Row {
  id: number;
  subject: string;
  url: string;
  prefs: string;
  created_at: number;
  last_status: string | null;
  last_sent_at: number | null;
}
const fromRow = (r: Row): Webhook => ({
  id: r.id,
  subject: r.subject,
  url: r.url,
  prefs: normalizePrefs(JSON.parse(r.prefs)),
  createdAt: r.created_at,
  lastStatus: r.last_status,
  lastSentAt: r.last_sent_at,
});

/** 送り先にできる URL か。http か https で、ホストがあり、長すぎないもの */
export function webhookUrl(raw: string): boolean {
  if (raw.length > MAX_URL) return false;
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname !== ""
    );
  } catch {
    return false;
  }
}

/** 画面と記録に出す送り先。ホストだけ (パスとクエリ、ユーザー情報は秘密を含みうる) */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(読めない URL)";
  }
}

/** 送れなかった理由。例外の文には URL が入りうるので、決まった言葉とエラーコードだけにする */
export function failure(error: unknown): string {
  if (error === null || typeof error !== "object")
    return "つながりませんでした";
  // AbortSignal.timeout は DOMException で投げる (Error を継がない実装もある)
  if ("name" in error && error.name === "TimeoutError") return "時間切れです";
  const code = "code" in error ? String(error.code) : "";
  return /^[\w-]{1,40}$/.test(code)
    ? `つながりませんでした (${code})`
    : "つながりませんでした";
}

/**
 * Discord の Webhook の URL か (`/api/webhooks/{id}/{token}`。API のバージョン付きも)。
 * Discord は本文を `content` で受け、`content` や `embeds` が無いと 400 で断る (`text` は読まない)。
 * 末尾が `/slack` の Slack 互換のエンドポイントは `text` を読むので、Slack と同じ形で送る
 */
export function discord(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      /^(?:(?:ptb|canary)\.)?discord(?:app)?\.com$/.test(url.hostname) &&
      /^\/api(?:\/v\d+)?\/webhooks\/[^/]+\/[^/]+\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/** Slack の Incoming Webhook の URL か。`text` の `&` `<` `>` を Slack の書き方で逃がすのに使う */
export function slack(raw: string): boolean {
  try {
    return new URL(raw).hostname === "hooks.slack.com";
  } catch {
    return false;
  }
}

/** Discord の `content` の上限 (字数) */
export const DISCORD_CONTENT_LIMIT = 2000;

/** Slack の `text` で、そのままだと書式として読まれる字を逃がす (Slack の文書の "Escaping text") */
const slackEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 人が読む本文。見出し・本文と、押すと開く画面の URL (`PUBLIC_URL` があるときだけ)。
 * Discord と Slack では URL を `<...>` で囲む。Discord はリンクの下にページの見本 (embed) を出さなくなり
 * (sonae の画面はログインの後ろなので、見本はログインの画面になる)、Slack はリンクとして読む
 */
export function textOf(
  payload: Pick<PushPayload, "title" | "body" | "url">,
  url: string,
  origin: string | undefined,
): string {
  const link = origin ? `${origin}${payload.url}` : "";
  if (slack(url)) {
    const lines = [slackEscape(payload.title), slackEscape(payload.body)];
    if (link) lines.push(`<${link}>`);
    return lines.join("\n");
  }
  const lines = [payload.title, payload.body];
  if (link) lines.push(discord(url) ? `<${link}>` : link);
  return lines.join("\n");
}

/**
 * 送る本文。Discord は `content` だけ。上限を超えたら切り詰め、`@everyone` のような字が入っていても
 * 誰にも通知が飛ばないよう、メンションは全部切る。
 * ほかの送り先 (Slack・Home Assistant など) は、Slack が読む `text` と、機械が読む項目を一緒に送る
 */
export function bodyOf(
  url: string,
  payload: PushPayload,
  origin: string | undefined,
  sentAt: number,
): Record<string, unknown> {
  const text = textOf(payload, url, origin);
  if (discord(url)) {
    // 字 (コードポイント) で数えて切る。UTF-16 で切るとサロゲートペアの途中で切れ、Discord が断ることがある
    const chars = Array.from(text);
    const content =
      chars.length > DISCORD_CONTENT_LIMIT
        ? `${chars.slice(0, DISCORD_CONTENT_LIMIT - 1).join("")}…`
        : text;
    return { content, allowed_mentions: { parse: [] } };
  }
  return {
    text,
    title: payload.title,
    body: payload.body,
    tag: payload.tag,
    url: origin ? `${origin}${payload.url}` : payload.url,
    timestamp: new Date(payload.timestamp).toISOString(),
    sentAt: new Date(sentAt).toISOString(),
  };
}

/** 押すと開く画面の origin (`PUBLIC_URL`)。無ければ本文に URL を付けない */
export function originFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env.PUBLIC_URL?.trim();
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

export class Webhooks {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly origin: string | undefined;
  private readonly log: SentLog;

  constructor(
    readonly db: Database,
    opts: {
      fetch?: typeof fetch;
      now?: () => number;
      origin?: string;
    } = {},
  ) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.origin = opts.origin;
    this.log = sentLog(db, "webhook_log");
  }

  /** 足す。足した id、数の上限なら "full" */
  add(subject: string, url: string, prefs: PushPrefs): number | "full" {
    const now = this.now();
    return this.db.transaction(() => {
      const { n } = this.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM webhooks WHERE subject = ?",
        )
        .get(subject) ?? { n: 0 };
      if (n >= MAX_WEBHOOKS) return "full" as const;
      return Number(
        this.db
          .query(
            `INSERT INTO webhooks (subject, url, prefs, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(subject, url, JSON.stringify(prefs), now, now).lastInsertRowid,
      );
    })();
  }

  /** その人の Webhook を消す。消したら true */
  remove(subject: string, id: number): boolean {
    return (
      this.db
        .query("DELETE FROM webhooks WHERE subject = ? AND id = ?")
        .run(subject, id).changes > 0
    );
  }

  /** その人の Webhook 全部の条件を替える (「通知」の条件を変えたとき)。替えた数を返す */
  setPrefs(subject: string, prefs: PushPrefs): number {
    return this.db
      .query("UPDATE webhooks SET prefs = ?, updated_at = ? WHERE subject = ?")
      .run(JSON.stringify(prefs), this.now(), subject).changes;
  }

  list(subject?: string): Webhook[] {
    const rows =
      subject === undefined
        ? this.db.query<Row, []>("SELECT * FROM webhooks").all()
        : this.db
            .query<Row, [string]>(
              "SELECT * FROM webhooks WHERE subject = ? ORDER BY id",
            )
            .all(subject);
    return rows.map(fromRow);
  }

  /**
   * Broker から受けたイベントを、条件に合う Webhook に送る。鳴らすかどうかを決めて控えるところまでは
   * 同期でする (Web Push と同じ)。送るのはその後で、待たずに並べる
   */
  handle(e: SonaeEvent): Promise<string[]> {
    const n = noticeOf(e, this.now());
    if (!n) return Promise.resolve([]);
    const jobs = planSends(
      this.db,
      this.log,
      n,
      this.list(),
      (w) => w.id,
      this.now(),
    );
    return Promise.all(jobs.map((j) => this.deliver(j)));
  }

  private async deliver(j: Job<Webhook>): Promise<string> {
    const r = await this.send(j.target, payloadOf(j.notice, j.renotify));
    // 送れなかったら控えを送る前に戻す (次の続報で送り直せるように)
    if (r !== "ok") this.log.undo(j.target.id, j.notice, j.prev);
    return r;
  }

  /**
   * 1 つの Webhook に送り、結果を行に残す。戻り値も同じ結果 (`ok` か失敗の理由)。
   * 「試しに送る」はこれを待つ (結果を見せるため)
   */
  async send(hook: Webhook, payload: PushPayload): Promise<string> {
    const at = this.now();
    let status = "ok";
    try {
      const res = await this.fetch(hook.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyOf(hook.url, payload, this.origin, at)),
        signal: AbortSignal.timeout(10_000),
        // 外の送り先が内側の URL へ飛ばしても、そこへは送らない
        redirect: "manual",
      });
      // 本文は読まずに捨てる (接続を手放すため。内側のサービスの中身を読み出す道具にしない)
      await res.body?.cancel();
      if (res.status >= 300 && res.status < 400)
        status = `${res.status} (リダイレクトは追いません)`;
      else if (!res.ok) status = String(res.status);
    } catch (err) {
      status = failure(err);
    }
    this.db
      .query(
        "UPDATE webhooks SET last_status = ?, last_sent_at = ? WHERE id = ?",
      )
      .run(status, at, hook.id);
    if (status !== "ok")
      console.warn(
        `[webhook] 送れませんでした (${hostOf(hook.url)}): ${status}`,
      );
    return status;
  }

  /** 古い控えを捨てる */
  prune(days = LOG_DAYS): number {
    return this.log.prune(this.now() - days * 24 * 60 * 60_000);
  }
}
