/**
 * ログインの控え (docs/design.md の 2.6)。DB に持ち、180 日で、使うたびに延ばす (何度もログインさせない)。
 * 延ばすのは 1 日に 1 回まで (要求のたびに DB に書かない)。
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
  id: string;
  subject: string;
  name: string;
  expiresAt: number;
}

export function create(
  subject: string,
  name: string,
  d: Database = db(),
  now = Date.now(),
): Session {
  const id = randomToken();
  const expiresAt = now + SESSION_TTL * 1000;
  d.run(
    "INSERT INTO sessions (id, subject, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    [id, subject, name, now, expiresAt],
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
  const row = d
    .query<
      { id: string; subject: string; name: string; expires_at: number },
      [string]
    >("SELECT id, subject, name, expires_at FROM sessions WHERE id = ?")
    .get(id);
  if (!row || row.expires_at <= now) return null;
  const session = {
    id: row.id,
    subject: row.subject,
    name: row.name,
    expiresAt: row.expires_at,
  };
  if (now + SESSION_TTL * 1000 - row.expires_at < EXTEND_AFTER)
    return { ...session, extended: false };
  const expiresAt = now + SESSION_TTL * 1000;
  d.run("UPDATE sessions SET expires_at = ? WHERE id = ?", [expiresAt, id]);
  return { ...session, expiresAt, extended: true };
}

export function destroy(id: string | undefined, d: Database = db()): void {
  if (id) d.run("DELETE FROM sessions WHERE id = ?", [id]);
}
