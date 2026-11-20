/**
 * 地図の層のために外から取ったものを、層ごとに 1 行で置く (表 `layer_cache`。docs/design.md の 2.5)。
 * 取り直すまで前のものを出し、起動し直しても取りに行き直さないために使う (海しるは 1 日 1 回)。
 */

import type { Database } from "bun:sqlite";

import { nowIso } from "./time.ts";

export interface CachedLayer<T> {
  fetchedAt: string;
  data: T;
}

export class LayerCache {
  constructor(private readonly db: Database) {}

  get<T>(id: string): CachedLayer<T> | undefined {
    const row = this.db
      .query<{ fetched_at: string; data: string }, [string]>(
        "SELECT fetched_at, data FROM layer_cache WHERE id = ?",
      )
      .get(id);
    if (!row) return undefined;
    try {
      return { fetchedAt: row.fetched_at, data: JSON.parse(row.data) as T };
    } catch {
      return undefined;
    }
  }

  put(id: string, data: unknown, fetchedAt = nowIso()): void {
    this.db
      .query(
        "INSERT INTO layer_cache (id, fetched_at, data) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data",
      )
      .run(id, fetchedAt, JSON.stringify(data));
  }
}
