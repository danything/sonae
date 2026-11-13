/**
 * Web Push の送り手と、購読の保存 (docs/design.md の 2.4、運用は docs/push.md)。
 *
 * - VAPID の鍵は環境変数 `VAPID_PRIVATE_JWK` (秘密鍵の JWK の JSON) から読む。**無ければ機能を切る**
 *   (画面に登録の口を出さず、送らない。ほかは普段どおり動く)。公開鍵は秘密鍵の x・y から作る。
 * - 暗号化 (RFC 8291 の aes128gcm) と VAPID の署名は @block65/webcrypto-web-push (WebCrypto だけ)。
 *   送るのは素の fetch。
 * - 404・410 が返った購読は消す (端末の側で購読が切れた)。
 */

import type { Database } from "bun:sqlite";

import { buildPushPayload } from "@block65/webcrypto-web-push";

import type { SonaeEvent } from "#lib/model.ts";
import { normalizePrefs, type PushPayload, type PushPrefs } from "#lib/push.ts";

import {
  digestOf,
  type Notice,
  noticeOf,
  payloadOf,
  plan,
  type Sent,
  topicOf,
} from "./notify.ts";

export interface Vapid {
  /** 秘密鍵 (JWK) */
  jwk: JsonWebKey;
  /** 公開鍵 (非圧縮の点、base64url)。ブラウザの applicationServerKey */
  publicKey: string;
  /** 配信サービスが困ったときの連絡先 (https の URL か mailto:) */
  subject: string;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const b64urlBytes = (s: string) => Buffer.from(s, "base64url");

/**
 * 環境変数から VAPID の鍵を読む。無い・読めないときは null (機能を切る)。
 * 連絡先は `VAPID_SUBJECT`、無ければ `PUBLIC_URL`。
 */
export function vapidFromEnv(
  env: Record<string, string | undefined> = process.env,
): { vapid: Vapid | null; problem?: string } {
  const raw = env.VAPID_PRIVATE_JWK?.trim();
  if (!raw) return { vapid: null };
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(raw) as JsonWebKey;
  } catch {
    return {
      vapid: null,
      problem: "VAPID_PRIVATE_JWK が JSON として読めません",
    };
  }
  const ok = (v: unknown, bytes: number) =>
    typeof v === "string" && B64URL.test(v) && b64urlBytes(v).length === bytes;
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    !ok(jwk.x, 32) ||
    !ok(jwk.y, 32) ||
    !ok(jwk.d, 32)
  ) {
    return {
      vapid: null,
      problem:
        "VAPID_PRIVATE_JWK が P-256 の秘密鍵 (kty EC・crv P-256・x・y・d) ではありません",
    };
  }
  const subject = (
    env.VAPID_SUBJECT?.trim() ||
    env.PUBLIC_URL?.trim() ||
    ""
  ).replace(/\/+$/, "");
  if (!/^(https:\/\/|mailto:)/.test(subject)) {
    return {
      vapid: null,
      problem:
        "VAPID_SUBJECT (無ければ PUBLIC_URL) に https の URL か mailto: を入れてください",
    };
  }
  const publicKey = Buffer.concat([
    Buffer.from([4]),
    b64urlBytes(jwk.x as string),
    b64urlBytes(jwk.y as string),
  ]).toString("base64url");
  return { vapid: { jwk, publicKey, subject } };
}

/**
 * 受け付ける配信サービス。購読の endpoint はブラウザから来るので、任意の宛先へサーバーから
 * POST させないよう、主なブラウザの配信サービスだけに絞る (Chrome・Edge は FCM、Firefox は
 * Mozilla、Safari は Apple、旧 Edge は WNS)
 */
export const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

export interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** ブラウザの PushSubscription.toJSON() を確かめる。おかしければ null */
export function parseSubscription(input: unknown): Subscription | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  if (typeof o.endpoint !== "string" || o.endpoint.length > 1024) return null;
  let url: URL;
  try {
    url = new URL(o.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "") return null;
  if (
    !PUSH_HOSTS.some(
      (h) => url.hostname === h || url.hostname.endsWith(`.${h}`),
    )
  )
    return null;
  const p256dh = o.keys?.p256dh;
  const auth = o.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (!B64URL.test(p256dh) || !B64URL.test(auth)) return null;
  // 鍵は P-256 の非圧縮の点 (65 バイト) と、16 バイトの auth
  if (b64urlBytes(p256dh).length !== 65 || b64urlBytes(auth).length !== 16)
    return null;
  return { endpoint: o.endpoint, p256dh, auth };
}

/** 1 人が持てる購読の数 (ブラウザ・端末の数) */
export const MAX_PER_USER = 20;
/** 送った控え (同じ事象で鳴らし直さないため) を残す日数 */
const LOG_DAYS = 30;

export interface StoredSubscription extends Subscription {
  subject: string;
  prefs: PushPrefs;
  label: string;
  createdAt: number;
}

interface Row {
  endpoint: string;
  subject: string;
  p256dh: string;
  auth: string;
  prefs: string;
  label: string;
  created_at: number;
}
const fromRow = (r: Row): StoredSubscription => ({
  endpoint: r.endpoint,
  subject: r.subject,
  p256dh: r.p256dh,
  auth: r.auth,
  prefs: normalizePrefs(JSON.parse(r.prefs)),
  label: r.label,
  createdAt: r.created_at,
});

export type SendResult = "ok" | "gone" | "error";

export class Pusher {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(
    readonly db: Database,
    readonly vapid: Vapid,
    opts: { fetch?: typeof fetch; now?: () => number } = {},
  ) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** 登録・更新。同じ endpoint を別の人が登録したら、その人のものにする (同じブラウザでログインし直した) */
  save(
    subject: string,
    sub: Subscription,
    prefs: PushPrefs,
    label: string,
  ): "ok" | "full" {
    const now = this.now();
    return this.db.transaction(() => {
      const mine = this.db
        .query<{ endpoint: string }, [string]>(
          "SELECT endpoint FROM push_subscriptions WHERE subject = ?",
        )
        .all(subject);
      if (
        mine.length >= MAX_PER_USER &&
        !mine.some((m) => m.endpoint === sub.endpoint)
      ) {
        return "full" as const;
      }
      this.db
        .query(
          `INSERT INTO push_subscriptions (endpoint, subject, p256dh, auth, prefs, label, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (endpoint) DO UPDATE SET subject = excluded.subject, p256dh = excluded.p256dh,
             auth = excluded.auth, prefs = excluded.prefs, label = excluded.label,
             updated_at = excluded.updated_at`,
        )
        .run(
          sub.endpoint,
          subject,
          sub.p256dh,
          sub.auth,
          JSON.stringify(prefs),
          label.slice(0, 80),
          now,
          now,
        );
      return "ok" as const;
    })();
  }

  /** その人の購読を消す。消したら true */
  remove(subject: string, endpoint: string): boolean {
    return (
      this.db
        .query(
          "DELETE FROM push_subscriptions WHERE subject = ? AND endpoint = ?",
        )
        .run(subject, endpoint).changes > 0
    );
  }

  list(subject?: string): StoredSubscription[] {
    const rows =
      subject === undefined
        ? this.db.query<Row, []>("SELECT * FROM push_subscriptions").all()
        : this.db
            .query<Row, [string]>(
              "SELECT * FROM push_subscriptions WHERE subject = ? ORDER BY created_at",
            )
            .all(subject);
    return rows.map(fromRow);
  }

  /**
   * Broker から受けたイベントを、条件に合う購読に送る。鳴らすかどうかを決めて控えるところまでは
   * 同期でする (続報が続けて来ても、同じ事象で二重に鳴らさない)。送るのはその後で、待たずに並べる。
   */
  handle(e: SonaeEvent): Promise<SendResult[]> {
    const n = noticeOf(e, this.now());
    if (!n) return Promise.resolve([]);
    const jobs: { sub: StoredSubscription; renotify: boolean }[] = [];
    this.db.transaction(() => {
      for (const sub of this.list()) {
        const prev = this.sent(sub.endpoint, n.tag);
        const p = plan(n, sub.prefs, prev);
        if (!p.send) continue;
        this.db
          .query(
            `INSERT INTO push_log (endpoint, tag, level, digest, sent_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (endpoint, tag) DO UPDATE SET level = max(level, excluded.level),
               digest = excluded.digest, sent_at = excluded.sent_at`,
          )
          .run(sub.endpoint, n.tag, n.level, digestOf(n), this.now());
        jobs.push({ sub, renotify: p.renotify });
      }
    })();
    return Promise.all(jobs.map((j) => this.deliver(j.sub, n, j.renotify)));
  }

  private sent(endpoint: string, tag: string): Sent | undefined {
    return (
      this.db
        .query<Sent, [string, string]>(
          "SELECT level, digest FROM push_log WHERE endpoint = ? AND tag = ?",
        )
        .get(endpoint, tag) ?? undefined
    );
  }

  private async deliver(
    sub: StoredSubscription,
    n: Notice,
    renotify: boolean,
  ): Promise<SendResult> {
    const r = await this.send(sub, payloadOf(n, renotify), {
      ttl: n.ttl,
      urgency: n.urgency,
      topic: topicOf(n.tag),
    });
    // 送れなかったら控えを消し、次の続報を「初めて」として扱う (知らせが一度も出ないことを避ける)
    if (r === "error") {
      this.db
        .query("DELETE FROM push_log WHERE endpoint = ? AND tag = ?")
        .run(sub.endpoint, n.tag);
    }
    return r;
  }

  /** 1 つの購読に送る。404・410 なら購読を消す */
  async send(
    sub: Subscription,
    payload: PushPayload,
    o: { ttl: number; urgency: "high" | "normal"; topic?: string },
  ): Promise<SendResult> {
    const host = new URL(sub.endpoint).hostname;
    try {
      // RFC 8291 (aes128gcm) で暗号化し、RFC 8292 (VAPID) の署名を付ける
      const req = await buildPushPayload(
        {
          data: { ...payload },
          options: {
            ttl: o.ttl,
            urgency: o.urgency,
            ...(o.topic ? { topic: o.topic } : {}),
          },
        },
        {
          endpoint: sub.endpoint,
          expirationTime: null,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        {
          subject: this.vapid.subject,
          publicKey: this.vapid.publicKey,
          privateKey: this.vapid.jwk.d,
        },
      );
      const res = await this.fetch(sub.endpoint, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return "ok";
      if (res.status === 404 || res.status === 410) {
        this.db
          .query("DELETE FROM push_subscriptions WHERE endpoint = ?")
          .run(sub.endpoint);
        console.log(
          `[push] 購読が切れていたので消しました (${host}, ${res.status})`,
        );
        return "gone";
      }
      console.warn(
        `[push] 送れませんでした (${host}, ${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
      return "error";
    } catch (err) {
      console.warn(`[push] 送れませんでした (${host}): ${err}`);
      return "error";
    }
  }

  /** 古い控えを捨てる */
  prune(days = LOG_DAYS): number {
    return this.db
      .query("DELETE FROM push_log WHERE sent_at < ?")
      .run(this.now() - days * 24 * 60 * 60_000).changes;
  }
}
