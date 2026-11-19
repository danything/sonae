import { describe, expect, test } from "bun:test";

import {
  listTop,
  nextRetract,
  RETRACT_SHORT,
  RETRACT_STEP,
  RETRACT_TOP,
  touchedInside,
} from "#lib/retract.ts";

describe("スマホの形で dock を引っ込める条件 (denpa と同じ)", () => {
  test("低い画面 (高さ 600px 未満) だけで引っ込める。高い画面では、下へ送っても出したまま", () => {
    expect(RETRACT_SHORT).toBe("(max-height: 599.98px)");
    expect(nextRetract(false, 300, 200, true)).toBe(true);
    expect(nextRetract(false, 300, 200, false)).toBe(false);
    // 引っ込めている間に高い画面になったら出す
    expect(nextRetract(true, 300, 300, false)).toBe(false);
  });

  test("先頭から 48px までは出す", () => {
    expect(RETRACT_TOP).toBe(48);
    expect(nextRetract(true, 47, 10, true)).toBe(false);
    expect(nextRetract(false, 60, 50, true)).toBe(true);
  });

  test("下へ 4px より多く送ったら引っ込め、上へ 4px より多く戻したら出す。小さな揺れでは変えない", () => {
    expect(RETRACT_STEP).toBe(4);
    expect(nextRetract(false, 104, 100, true)).toBe(false);
    expect(nextRetract(false, 105, 100, true)).toBe(true);
    expect(nextRetract(true, 96, 100, true)).toBe(true);
    expect(nextRetract(true, 95, 100, true)).toBe(false);
  });
});

describe("一覧の巻いた量", () => {
  const win = { scrollY: 320 };
  const box = { scrollTop: 40 };

  test("スマホの形は一覧を窓ごと巻くので、窓の値を見る (列の箱は巻かない)", () => {
    expect(listTop(true, win, box)).toBe(320);
    expect(listTop(true, win, undefined)).toBe(320);
  });

  test("広い形は列の箱の中で巻くので、箱の値を見る。箱がまだ無ければ 0", () => {
    expect(listTop(false, win, box)).toBe(40);
    expect(listTop(false, win, undefined)).toBe(0);
  });
});

describe("人が一覧の中を巻いたときだけ見る", () => {
  const inside = { nodeType: 1 } as unknown as EventTarget;
  const outside = { nodeType: 1 } as unknown as EventTarget;
  const box = { contains: (n: Node | null) => n === (inside as unknown) };

  test("最後に触った所が一覧の中なら見る", () => {
    expect(touchedInside(box, inside)).toBe(true);
  });

  test("一覧の外 (地図・dock・カレンダーのメニューなど)・まだ触っていない・window では見ない", () => {
    expect(touchedInside(box, outside)).toBe(false);
    expect(touchedInside(box, null)).toBe(false);
    // window は Node でない (nodeType が無い)
    expect(touchedInside(box, {} as EventTarget)).toBe(false);
    expect(touchedInside(undefined, inside)).toBe(false);
  });
});
