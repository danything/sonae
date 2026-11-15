import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { type Cities, cityAt, homeOf } from "#lib/home.ts";
import {
  coordLabel,
  coordText,
  LONG_PRESS_SLOP,
  longPressOk,
} from "#lib/map/press.ts";
import { baseStyle, homeFilter } from "#lib/map/style.ts";
import { createQueue } from "#lib/prefs-queue.ts";

test("長押し: 指 1 本で、ほとんど動かず、地図も動いていないときだけ", () => {
  const still = { dx: 0, dy: 0, touches: 1, mapMoved: false };
  expect(longPressOk(still)).toBe(true);
  expect(longPressOk({ ...still, dx: LONG_PRESS_SLOP, dy: 0 })).toBe(true);
  // 指が動いた (ドラッグ)
  expect(longPressOk({ ...still, dx: 8, dy: 8 })).toBe(false);
  // 2 本指 (拡大)
  expect(longPressOk({ ...still, touches: 2 })).toBe(false);
  // 地図が動いた
  expect(longPressOk({ ...still, mapMoved: true })).toBe(false);
});

test("写す緯度・経度と見出し", () => {
  expect(coordText(35.68123456, 139.76712345)).toBe("35.68123, 139.76712");
  expect(coordLabel(35.68123, 139.76712)).toBe("北緯 35.6812・東経 139.7671");
  expect(coordLabel(-41.3, -70.1)).toBe("南緯 41.3000・西経 70.1000");
});

test("住んでいる地域の縁取り: 決まっていれば、その市町村等だけ", () => {
  expect(homeFilter("1310100")).toEqual(["==", ["get", "code"], "1310100"]);
  expect(homeFilter(null)).toEqual(["==", ["get", "code"], ""]);
  const style = baseStyle() as { layers: { id: string }[] };
  const ids = style.layers.map((l) => l.id);
  expect(ids).toContain("home-casing");
  expect(ids).toContain("home-line");
});

test("押した所の市町村等: 陸なら住んでいる地域、海の上なら null", () => {
  const cities = JSON.parse(
    readFileSync("static/areas/cities.json", "utf8"),
  ) as Cities;
  const areas = JSON.parse(
    readFileSync("static/areas/warning-areas.geojson", "utf8"),
  ) as { features: Parameters<typeof cityAt>[2] };
  // 東京都千代田区 (皇居のあたり)
  const code = cityAt(35.6852, 139.7528, areas.features);
  expect(code).not.toBeNull();
  const home = homeOf(code ?? "", cities, new Map());
  expect(home?.name).toContain("千代田区");
  // 太平洋の上
  expect(cityAt(33, 145, areas.features)).toBeNull();
});

test("条件を送る列: 順に送り、結果は最後の 1 つだけ返す", async () => {
  const q = createQueue();
  const order: string[] = [];
  const job = (name: string, ms: number) => () =>
    new Promise<string>((r) =>
      setTimeout(() => {
        order.push(name);
        r(`${name} 済み`);
      }, ms),
    );
  const a = q.push(job("a", 20));
  const b = q.push(job("b", 1));
  expect(await a).toBeNull();
  expect(await b).toBe("b 済み");
  // 先に並べた a が、短い b に追い越されない
  expect(order).toEqual(["a", "b"]);
  // 失敗しても列は止まらない
  const c = q.push(() => Promise.reject(new Error("落ちた")));
  expect(await c).toBe("保存できませんでした: Error: 落ちた");
  const d = q.push(job("d", 1));
  expect(await d).toBe("d 済み");
  await q.settled();
});
