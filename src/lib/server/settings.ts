/**
 * この家 (1 つのサーバー) の設定 (docs/design.md の 2.5)。DB の `settings` に key ごとに JSON の値で持つ。
 * 端末ごとの好み (音・読み上げのオン/オフなど) は端末の localStorage で、ここには置かない。
 */

import type { Database } from "bun:sqlite";

import type { VoiceStore } from "./voicevox.ts";

/** 覚えた値。無い・読めなければ undefined */
export function readSetting(d: Database, key: string): unknown {
  const row = d
    .query<{ value: string }, [string]>(
      "SELECT value FROM settings WHERE key = ?",
    )
    .get(key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return undefined;
  }
}

export function writeSetting(
  d: Database,
  key: string,
  value: unknown,
  by: string,
  now = Date.now(),
): void {
  d.run(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), by, now],
  );
}

/** 読み上げの声 (VOICEVOX のスタイルの id) の置き場 */
export function voiceStore(d: Database): VoiceStore {
  return {
    load() {
      const v = readSetting(d, "voice");
      return typeof v === "number" && Number.isInteger(v) && v >= 0
        ? v
        : undefined;
    },
    save(id, by) {
      writeSetting(d, "voice", id, by);
    },
  };
}
