/**
 * SQLite (bun:sqlite)。WAL で、`$SONAE_DATA/sonae.db`。ORM は使わず、素の SQL と
 * `PRAGMA user_version` でスキーマのバージョンを上げる (docs/design.md の 2.5)。
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** バージョンごとの DDL。足すときは末尾に足し、前のものは変えない */
const MIGRATIONS: string[] = [
  `
  -- 受けた原文 (圧縮)。鍵は情報源の中での重複の除去に使う。Wolfx は原文を残さない (body が NULL)
  CREATE TABLE raw_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    key TEXT NOT NULL,
    code TEXT NOT NULL,
    received_at TEXT NOT NULL,
    body BLOB,
    error TEXT,
    UNIQUE (source, key)
  );
  CREATE INDEX raw_messages_received ON raw_messages (received_at);

  -- 正規化したイベントの通し番号と、その時点の姿。SSE の id はこの番号
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    key TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE eews (
    event_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX eews_issued ON eews (issued_at);

  CREATE TABLE quakes (
    id TEXT PRIMARY KEY,
    event_id TEXT,
    status TEXT NOT NULL,
    origin_time TEXT,
    updated_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX quakes_event ON quakes (event_id);
  CREATE INDEX quakes_origin ON quakes (origin_time);

  CREATE TABLE tsunamis (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    ended INTEGER NOT NULL,
    issued_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX tsunamis_issued ON tsunamis (issued_at);

  CREATE TABLE advisories (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    reported_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX advisories_reported ON advisories (reported_at);
  `,
  `
  -- ログインの控え (2.6)。subject は IdP の sub、時刻はミリ秒
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_expires ON sessions (expires_at);
  `,
  `
  -- セッションの ID は DB に平文で持たず、SHA-256 (16 進) を持つ。前の控えは捨てる (ログインし直し)
  DROP TABLE sessions;
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_expires ON sessions (expires_at);
  `,
  `
  -- Web Push の購読 (2.4)。ブラウザごとに 1 つ。subject はログインした人 (IdP の sub)、prefs は通知の条件 (JSON)。
  -- セッションとは結ばない (ログインが切れても届く)
  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    prefs TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX push_subscriptions_subject ON push_subscriptions (subject);

  -- 購読ごとに、事象 (tag) へ最後に送ったもの。同じ事象の続報で鳴らし直さないために使う
  CREATE TABLE push_log (
    endpoint TEXT NOT NULL REFERENCES push_subscriptions (endpoint) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    level INTEGER NOT NULL,
    digest TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (endpoint, tag)
  );
  CREATE INDEX push_log_sent ON push_log (sent_at);
  `,
];

export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  const { user_version: version } = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get() ?? { user_version: 0 };
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.run(MIGRATIONS[v] ?? "");
      db.run(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

let instance: Database | undefined;

/** アプリの DB。初めて呼んだときに開く */
export function db(): Database {
  if (!instance) {
    const dir = process.env.SONAE_DATA || "./data";
    mkdirSync(dir, { recursive: true });
    instance = openDb(join(dir, "sonae.db"));
  }
  return instance;
}
