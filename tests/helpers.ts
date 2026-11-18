import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Cities, homeOf } from "#lib/home.ts";
import type { WeatherInfo, WeatherWarning } from "#lib/model.ts";
import type { Home } from "#lib/push.ts";
import { openDb } from "#lib/server/db.ts";
import { parseWeatherXml } from "#lib/server/sources/jma-weather.ts";
import { parseJmaXml } from "#lib/server/sources/jma-xml.ts";
import type { SocketLike } from "#lib/server/sources/retry.ts";
import type { Incoming, SourceContext } from "#lib/server/sources/types.ts";
import { Store } from "#lib/server/store.ts";

const DIR = join(import.meta.dir, "fixtures");
const AREAS = join(import.meta.dir, "..", "static", "areas");

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

/** 気象庁の XML の fixture を、気象庁のフィードから受けた 1 通の形式にする */
export function jmaIncoming(file: string): Incoming {
  const body = fixture(`jma/${file}`);
  return {
    source: "jma",
    key: file,
    code: codeOf(file),
    body,
    items: parseJmaXml(body, codeOf(file)),
  };
}

/** 気象警報・注意報の fixture。`patch` で電文を書き換えた作り物も作れる */
export function weatherWarning(
  file: string,
  code: string,
  patch = (s: string) => s,
): WeatherWarning {
  const [item] = parseWeatherXml(patch(fixture(`jma/${file}`)), code);
  if (item?.type !== "warning") throw new Error("警報・注意報ではありません");
  return { ...item.warning, updatedAt: "" };
}

/** 記録的短時間大雨情報・竜巻注意情報などの気象の報の fixture */
export function weatherInfo(file: string, code: string): WeatherInfo {
  const [item] = parseWeatherXml(fixture(`jma/${file}`), code);
  if (item?.type !== "weather") throw new Error("気象の報ではありません");
  return { ...item.info, cancelled: false, updatedAt: "" };
}

/** 電文の大雨警報を大雨特別警報に書き換える (特別警報のサンプル電文が無いため) */
export const toSpecialRain = (s: string) =>
  s.replace(
    /<Name>レベル３大雨警報<\/Name>\s*<Code>03<\/Code>/g,
    "<Name>レベル５大雨特別警報</Name><Code>33</Code>",
  );

/** 市町村等の表 (`static/areas/cities.json`) */
export const cities = JSON.parse(
  readFileSync(join(AREAS, "cities.json"), "utf8"),
) as Cities;

const quakeNames = new Map(
  (
    JSON.parse(readFileSync(join(AREAS, "quake-areas.geojson"), "utf8")) as {
      features: { properties: { code: string; name: string } }[];
    }
  ).features.map((f) => [f.properties.code, f.properties.name]),
);

/** 住んでいる地域を、画面と同じく市町村等の表から引く (表とずれた作り物を書かないため) */
export function homeAt(code: string): Home {
  const h = homeOf(code, cities, quakeNames);
  if (!h) throw new Error(`市町村等 ${code} が表にありません`);
  return h;
}

/** 情報源に渡す受け口。渡されたものを並べ、渡したものを `seen` で答える */
export function sourceContext() {
  const got: Incoming[] = [];
  const keys = new Set<string>();
  const ctx: SourceContext = {
    emit: (m) => {
      got.push(m);
      keys.add(`${m.source}:${m.key}`);
    },
    seen: (s, k) => keys.has(`${s}:${k}`),
  };
  return { ctx, got };
}

/** 情報源のサーバーは立てない。WebSocket の代わり */
export class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  private on: Record<string, ((e: never) => void)[]> = {};
  addEventListener(type: string, fn: (e: never) => void) {
    (this.on[type] ??= []).push(fn);
  }
  fire(type: string, e?: unknown) {
    for (const fn of this.on[type] ?? []) fn(e as never);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.fire("close");
  }
}
