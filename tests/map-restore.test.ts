import { expect, test } from "bun:test";

import { type MapView, ViewKeeper } from "#lib/map/restore.ts";

const japan: MapView = { center: [137, 38], zoom: 4.5, bearing: 0, pitch: 0 };
const tokyo: MapView = { center: [139.7, 35.7], zoom: 6, bearing: 0, pitch: 0 };
const osaka: MapView = { center: [135.5, 34.7], zoom: 6, bearing: 0, pitch: 0 };

test("詳しい内容を開いて寄せ、閉じたら開く前の位置を返す", () => {
  const k = new ViewKeeper();
  k.focus(japan, true);
  expect(k.open).toBe(true);
  expect(k.close()).toEqual(japan);
  expect(k.open).toBe(false);
});

test("詳しい内容から別の詳しい内容へ移っても、戻す先は最初に開く前の位置のまま", () => {
  const k = new ViewKeeper();
  k.focus(japan, true);
  k.focus(tokyo, true);
  k.focus(osaka, true);
  expect(k.close()).toEqual(japan);
});

test("開いている間に人が地図を動かしたら、閉じても戻さない", () => {
  const k = new ViewKeeper();
  k.focus(japan, true);
  k.moved();
  // 動かした後に別の詳しい内容へ移っても、控え直さない
  k.focus(tokyo, true);
  expect(k.close()).toBeNull();
});

test("何も開いていないときに人が動かしても、次に開いたときの控えには響かない", () => {
  const k = new ViewKeeper();
  k.moved();
  k.focus(tokyo, true);
  expect(k.close()).toEqual(tokyo);
});

test("詳しい内容を開かずに寄せた (出ている緊急地震速報) ときは控えない", () => {
  const k = new ViewKeeper();
  k.focus(japan, false);
  expect(k.open).toBe(false);
  expect(k.close()).toBeNull();
});

test("閉じたら控えを忘れ、次に開くときは改めて控える", () => {
  const k = new ViewKeeper();
  k.focus(japan, true);
  k.close();
  expect(k.close()).toBeNull();
  k.focus(tokyo, true);
  expect(k.close()).toEqual(tokyo);
});
