import { expect, test } from "bun:test";

import { EDGE_GAP, edgePadding } from "#lib/map/edges.ts";

// 390×800 の地図 (スマホの形)
const map = { top: 0, bottom: 800, left: 0, right: 390 };

test("スマホの形: 上の角の出典は上を、下の操作は下を空ける", () => {
  const credit = { top: 0, bottom: 15, left: 200, right: 390 };
  const controls = { top: 600, bottom: 644, left: 150, right: 378 };
  expect(edgePadding(map, [credit, controls])).toEqual({
    top: 15 + EDGE_GAP,
    bottom: 200 + EDGE_GAP,
    left: 0,
    right: 0,
  });
});

test("広い形: 出典と操作がどちらも下なら、下だけを大きいほうで空ける", () => {
  const wide = { top: 60, bottom: 900, left: 0, right: 1000 };
  const credit = { top: 885, bottom: 900, left: 780, right: 1000 };
  const controls = { top: 830, bottom: 877, left: 700, right: 988 };
  expect(edgePadding(wide, [credit, controls])).toEqual({
    top: 0,
    bottom: 70 + EDGE_GAP,
    left: 0,
    right: 0,
  });
});

test("地図に重ならないもの・大きさの無いもの・まだ無いものは見ない", () => {
  const outside = { top: 820, bottom: 840, left: 0, right: 390 };
  const empty = { top: 500, bottom: 500, left: 0, right: 0 };
  expect(edgePadding(map, [outside, empty, undefined])).toEqual({
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  });
});

test("上と下で地図の高さの 6 割を超えたら、比を保って詰める", () => {
  const low = { top: 0, bottom: 200, left: 0, right: 390 };
  const credit = { top: 0, bottom: 12, left: 200, right: 390 };
  const controls = { top: 60, bottom: 190, left: 150, right: 378 };
  const p = edgePadding(low, [credit, controls]);
  expect(p.top + p.bottom).toBeCloseTo(120);
  expect(p.top / p.bottom).toBeCloseTo((12 + EDGE_GAP) / (140 + EDGE_GAP));
});
