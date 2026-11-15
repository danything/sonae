import { describe, expect, test } from "bun:test";

import type { Eew, Tsunami } from "#lib/model.ts";
import { pinFirst } from "#lib/view.ts";

import { eew, tsunami } from "./events.ts";

const e = (over: Partial<Eew> = {}) => eew(over).data as Eew;
const t = (over: Partial<Tsunami> = {}) => tsunami(over).data as Tsunami;
const warning = t({
  id: "t-warn",
  areas: [
    { name: "岩手県", grade: "warning", kindName: "津波警報" },
    { name: "宮城県", grade: "warning", kindName: "津波警報" },
    { name: "福島県", grade: "watch", kindName: "津波注意報" },
  ],
});
const tokyo = { code: "130000", name: "東京都" };

describe("何も選んでいないときの dock (pinFirst)", () => {
  test("何も出ていなければ無い (地震は出さない)", () => {
    expect(pinFirst([], [], [])).toBeNull();
  });
  test("津波注意報だけなら出さない (いつも貼るのは津波警報から)", () => {
    expect(pinFirst([], [t()], [])).toBeNull();
  });
  test("並びは一覧の先頭と同じ: 緊急地震速報・津波・特別警報", () => {
    expect(pinFirst([e({ kind: "warning" })], [warning], [tokyo])).toEqual({
      kind: "eew",
      id: "20261114090800",
      label: "緊急地震速報 (警報) 強い揺れに警戒・茨城県南部",
      red: true,
    });
    expect(pinFirst([], [warning], [tokyo])).toEqual({
      kind: "tsunami",
      id: "t-warn",
      label: "津波警報・岩手県、宮城県",
      red: false,
    });
    expect(pinFirst([], [], [tokyo])).toEqual({
      kind: "weather",
      id: "office-130000",
      label: "東京都に特別警報",
      red: false,
    });
  });
  test("緊急地震速報の予報は塗らない。取消は出さない", () => {
    expect(pinFirst([e()], [], [])?.red).toBe(false);
    expect(pinFirst([e({ cancelled: true })], [], [])).toBeNull();
  });
});
