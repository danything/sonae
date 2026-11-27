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

test("戻す見込みの無い寄せ方では控えない", () => {
  const k = new ViewKeeper();
  k.focus(japan, false);
  expect(k.open).toBe(false);
  expect(k.due(false, false)).toBe(false);
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

// 何も選んでいないときに出た緊急地震速報 (2026-11-27。持ち主の声「緊急地震速報のあと、戻っても地図の位置が戻らん」)

test("何も選んでいないときに出た緊急地震速報へ寄せたら、出ている間が過ぎて一覧へ戻ったときに寄せる前の位置へ戻す", () => {
  const k = new ViewKeeper();
  // 速報が届いた所では、まだ自動で開いていない (選んでいない) が、速報へ寄せるので控える
  k.focus(japan, false, true);
  // 自動で開いた詳しい内容を見ている間と、出ている間は戻さない
  expect(k.due(true, true)).toBe(false);
  expect(k.due(true, false)).toBe(false);
  // 出ている間が過ぎて一覧へ戻った
  expect(k.due(false, false)).toBe(true);
  expect(k.close()).toEqual(japan);
});

test("続報や別の緊急地震速報で寄せ直しても、控えは最初の位置のまま", () => {
  const k = new ViewKeeper();
  k.focus(japan, false, true);
  k.focus(tokyo, true, true);
  k.focus(osaka, true, true);
  expect(k.close()).toEqual(japan);
});

test("緊急地震速報が出ている間に一覧へ戻ったときは震央を見せたままにし、速報が終わったら戻す", () => {
  const k = new ViewKeeper();
  k.focus(japan, false, true);
  // 一覧へ戻った (速報は出ている)
  expect(k.due(false, true)).toBe(false);
  expect(k.open).toBe(true);
  // 終わった (出ている間が過ぎた。取消も同じ)
  expect(k.due(false, false)).toBe(true);
  expect(k.close()).toEqual(japan);
});

test("緊急地震速報の間に人が地図を動かしたら、終わっても戻さない", () => {
  const k = new ViewKeeper();
  k.focus(japan, false, true);
  k.moved();
  expect(k.due(false, false)).toBe(true);
  expect(k.close()).toBeNull();
});

test("地震を見ている間に緊急地震速報が来たら、戻す先は地震を開く前の位置のまま", () => {
  const k = new ViewKeeper();
  k.focus(japan, true); // 地震を開いた
  k.focus(tokyo, true, true); // 緊急地震速報へ寄せた
  // 速報が終わって地震の詳しい内容へ戻った (選んだまま) ときは戻さない
  expect(k.due(true, false)).toBe(false);
  // 地震を閉じた
  expect(k.close()).toEqual(japan);
});

test("控えていないときは戻すときではない", () => {
  expect(new ViewKeeper().due(false, false)).toBe(false);
});
