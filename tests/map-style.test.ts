import { expect, test } from "bun:test";

import {
  defaultLayers,
  eewFill,
  intensityFill,
  intensityLabels,
  LAYERS,
  MAP_LAYERS,
  matchExpr,
  readLayers,
  tsunamiPaint,
} from "#lib/map/style.ts";
import type { Eew, Tsunami } from "#lib/model.ts";

test("色の式: コード (気象庁) と名前 (P2P) で引き、どちらも無ければ透明", () => {
  expect(matchExpr(new Map(), new Map(), "x")).toBe("x");
  expect(
    intensityFill([
      { code: "442", name: "静岡県中部", int: "6-" },
      { name: "沖縄本島地方", int: "3" },
    ]),
  ).toEqual([
    "match",
    ["get", "code"],
    "442",
    "rgb(255 40 0)",
    [
      "match",
      ["get", "name"],
      "沖縄本島地方",
      "rgb(0 65 255)",
      "rgba(0,0,0,0)",
    ],
  ]);
});

test("緊急地震速報: 取り消されたものの地域は塗らない", () => {
  const e = { warnAreas: ["上川地方北部"], cancelled: false } as Eew;
  expect(eewFill([e], "red")).toEqual([
    "match",
    ["get", "name"],
    "上川地方北部",
    "red",
    "rgba(0,0,0,0)",
  ]);
  expect(eewFill([{ ...e, cancelled: true }], "red")).toBe("rgba(0,0,0,0)");
});

test("津波: 強い区分が勝ち、大津波警報は線を太く", () => {
  const t = {
    areas: [
      { code: "210", name: "岩手県", grade: "watch", kindName: "" },
      { code: "210", name: "岩手県", grade: "major", kindName: "" },
      { code: "220", name: "宮城県", grade: "none", kindName: "" },
    ],
  } as Tsunami;
  const p = tsunamiPaint([t]);
  expect(p.color).toEqual([
    "match",
    ["get", "code"],
    "210",
    "rgb(200 0 255)",
    "rgba(0,0,0,0)",
  ]);
  expect(p.width).toEqual(["match", ["get", "code"], "210", 8, 0]);
});

test("震度の札: 名前しか無いものはコードを引き、大きい震度を後に描く", () => {
  const labels = intensityLabels(
    [
      { code: "442", name: "静岡県中部", int: "6-" },
      { name: "静岡県東部", int: "4" },
      { name: "どこか", int: "7" },
    ],
    { "442": [138.3, 35], "441": [138.9, 35.2] },
    new Map([["静岡県東部", "441"]]),
  );
  expect(labels.map((l) => l.int)).toEqual(["4", "6-"]);
});

test("層のオン・オフ: 覚えたものを読み、壊れていれば既定", () => {
  expect(readLayers(null)).toEqual(defaultLayers());
  expect(readLayers("{壊れた")).toEqual(defaultLayers());
  expect(readLayers('{"faults":true,"unknown":1}').faults).toBe(true);
  // 地図の層はどれも、どれかの切り替えに属する
  const ids = new Set(LAYERS.map((l) => l.id));
  for (const id of Object.values(MAP_LAYERS)) expect(ids.has(id)).toBe(true);
});
