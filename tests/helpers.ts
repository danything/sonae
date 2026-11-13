import { readFileSync } from "node:fs";
import { join } from "node:path";

import { openDb } from "#lib/server/db.ts";
import { Store } from "#lib/server/store.ts";

const DIR = join(import.meta.dir, "fixtures");

export const fixture = (path: string) => readFileSync(join(DIR, path), "utf8");
export const json = (path: string) =>
  JSON.parse(fixture(path)) as Record<string, unknown>;

/** メモリの DB と、進められる時計 */
export function memoryStore(start = "2026-11-13T00:00:00.000Z") {
  let t = Date.parse(start);
  const store = new Store(openDb(":memory:"), () => new Date(t).toISOString());
  return {
    store,
    advance(ms: number) {
      t += ms;
    },
  };
}

/** 種別をファイル名から取る (フィードのリンクと同じ規則) */
export const codeOf = (file: string) =>
  /_([A-Z]{4}\d{2})\.xml$/.exec(file)?.[1] ?? "";
