/**
 * ログインの控え (docs/design.md の 2.6)。DB に持ち、180 日で、使うたびに延ばす (何度もログインさせない)。
 * 延ばすのは 1 日に 1 回まで (要求のたびに DB に書かない)。
 *
 * 生の ID は Cookie にだけ置き、DB には SHA-256 を持つ (DB が漏れても、そのままでは成りすませない)。
 */

import type { Database } from "bun:sqlite";

import { db } from "./db.ts";
import { randomToken } from "./random.ts";

/** Cookie の名前。`__Host-` は http のときに付けられないので素の名前。 */
export const COOKIE = "sonae_session";
/** ログインの途中 (state / nonce / verifier) を預ける先。callback で使って捨てる */
export const PENDING_COOKIE = "sonae_login";
export const PENDING_TTL = 10 * 60;
/** 控えの寿命 (秒)。180 日 */
export const SESSION_TTL = 180 * 24 * 60 * 60;
const EXTEND_AFTER = 24 * 60 * 60 * 1000;

export interface Session {
  /** 生の ID。Cookie に置く値で、DB には無い */
  id: string;
  subject: string;
  name: string;
  expiresAt: number;
}

/** DB に持つ値 (生の ID の SHA-256、16 進) */
export const hashOf = (id: string) =>
  new Bun.CryptoHasher("sha256").update(id).digest("hex");

export function create(
  subject: string,
  name: string,
  d: Database = db(),
  now = Date.now(),
): Session {
  const id = randomToken();
  const expiresAt = now + SESSION_TTL * 1000;
  d.run(
    "INSERT INTO sessions (id_hash, subject, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    [hashOf(id), subject, name, now, expiresAt],
  );
  // ついでに切れたものを片付ける
  d.run("DELETE FROM sessions WHERE expires_at <= ?", [now]);
  return { id, subject, name, expiresAt };
}

/** 生きている控えだけ返す。古くなっていれば寿命を延ばす (延ばしたら extended が true) */
export function find(
  id: string | undefined,
  d: Database = db(),
  now = Date.now(),
): (Session & { extended: boolean }) | null {
  if (!id) return null;
  const hash = hashOf(id);
  const row = d
    .query<{ subject: string; name: string; expires_at: number }, [string]>(
      "SELECT subject, name, expires_at FROM sessions WHERE id_hash = ?",
    )
    .get(hash);
  if (!row || row.expires_at <= now) return null;
  const session = {
    id,
    subject: row.subject,
    name: row.name,
    expiresAt: row.expires_at,
  };
  if (now + SESSION_TTL * 1000 - row.expires_at < EXTEND_AFTER)
    return { ...session, extended: false };
  const expiresAt = now + SESSION_TTL * 1000;
  d.run("UPDATE sessions SET expires_at = ? WHERE id_hash = ?", [
    expiresAt,
    hash,
  ]);
  return { ...session, expiresAt, extended: true };
}

export function destroy(id: string | undefined, d: Database = db()): void {
  if (id) d.run("DELETE FROM sessions WHERE id_hash = ?", [hashOf(id)]);
}
