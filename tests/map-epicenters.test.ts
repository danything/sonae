import { describe, expect, test } from "bun:test";

import {
  type EpicenterHit,
  epicenterReach,
  FOREIGN_RADIUS,
  HYPO_RADIUS,
  nearestEpicenter,
  radiusAt,
  radiusExpr,
} from "#lib/map/epicenters.ts";
import { baseStyle } from "#lib/map/style.ts";

const hit = (over: Partial<EpicenterHit>): EpicenterHit => ({
  kind: "quake",
  id: "q",
  d2: 0,
  radius: 5,
  order: 1,
  ...over,
});

describe("震源の丸の大きさ", () => {
  test("段の間は線で結び、範囲の外は端の大きさ", () => {
    expect(radiusAt(HYPO_RADIUS, 1)).toBe(3);
    expect(radiusAt(HYPO_RADIUS, 3)).toBe(5);
    expect(radiusAt(HYPO_RADIUS, 5)).toBe(7);
    expect(radiusAt(HYPO_RADIUS, 6.5)).toBeCloseTo(11.5);
    expect(radiusAt(HYPO_RADIUS, 0)).toBe(3);
    expect(radiusAt(HYPO_RADIUS, 9.1)).toBe(16);
    expect(radiusAt(HYPO_RADIUS, Number.NaN)).toBe(3);
    expect(radiusAt(FOREIGN_RADIUS, 7.5)).toBe(13.5);
  });

  test("地図の式と同じ段を使う", () => {
    expect(radiusExpr(HYPO_RADIUS)).toEqual([
      "interpolate",
      ["linear"],
      ["get", "m"],
      1,
      3,
      5,
      7,
      8,
      16,
    ]);
    const layers = (
      baseStyle("http://localhost") as {
        layers: { id: string; paint?: Record<string, unknown> }[];
      }
    ).layers;
    const paint = (id: string) =>
      layers.find((l) => l.id === id)?.paint?.["circle-radius"];
    expect(paint("hypocenters")).toEqual(radiusExpr(HYPO_RADIUS));
    expect(paint("foreign")).toEqual(radiusExpr(FOREIGN_RADIUS));
  });
});

describe("押した所から選ぶ地震", () => {
  test("押せる範囲は指 22px・マウス 10px", () => {
    expect(epicenterReach(true)).toBe(22);
    expect(epicenterReach(false)).toBe(10);
  });

  test("範囲の外の丸は選ばない", () => {
    expect(nearestEpicenter([hit({ d2: 11 ** 2 })], 10)).toBeUndefined();
    expect(nearestEpicenter([hit({ d2: 11 ** 2 })], 22)?.id).toBe("q");
    expect(nearestEpicenter([], 22)).toBeUndefined();
  });

  test("丸が範囲より大きいときは、丸の中ならどこでも", () => {
    const big = hit({ d2: 15 ** 2, radius: 16 });
    expect(nearestEpicenter([big], 10)?.id).toBe("q");
    expect(
      nearestEpicenter([hit({ d2: 17 ** 2, radius: 16 })], 10),
    ).toBeUndefined();
  });

  test("幾つもあるときは、中心が押した所にいちばん近いもの", () => {
    const got = nearestEpicenter(
      [
        hit({ id: "far", d2: 64, order: 50 }),
        hit({ id: "near", d2: 9, order: 1 }),
      ],
      22,
    );
    expect(got?.id).toBe("near");
  });

  test("同じ近さなら上に描いているもの (海外の地震、同じ層では新しいもの)", () => {
    expect(
      nearestEpicenter(
        [
          hit({ id: "old", d2: 4, order: 3 }),
          hit({ id: "new", d2: 4, order: 9 }),
        ],
        10,
      )?.id,
    ).toBe("new");
    expect(
      nearestEpicenter(
        [
          hit({ id: "jp", d2: 4, order: 50 }),
          hit({ id: "intl", kind: "foreign", d2: 4, order: 1 }),
        ],
        10,
      )?.kind,
    ).toBe("foreign");
  });
});

describe("描く順 (押せる所が重なったときの順と同じ)", () => {
  test("震源の丸は警報の面の上、通行止めの線・海しるの点・観測点の丸・避難場所の印の下", () => {
    const ids = (
      baseStyle("http://localhost") as { layers: { id: string }[] }
    ).layers.map((l) => l.id);
    const at = (id: string) => {
      const i = ids.indexOf(id);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      "warning-fill",
      "hypocenters",
      "foreign",
      "road-speed",
      "road-closed",
      "marine",
      "intensity-stations",
      "shelters",
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // 台湾・有志の観測点の揺れは震源の丸の下
    expect(at("rts")).toBeLessThan(at("hypocenters"));
    expect(at("seis")).toBeLessThan(at("hypocenters"));
  });
});
