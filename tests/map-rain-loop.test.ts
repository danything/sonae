import { expect, test } from "bun:test";

import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

import { isSoftwareRenderer } from "#lib/lite.ts";
import type { NowcFrame } from "#lib/map/nowc.ts";
import {
  LOOP_FRAME_MS,
  LOOP_LAST_MS,
  LOOP_LAYER_IDS,
  loopForecast,
  loopReady,
  nextSlot,
  settleSlot,
  slotDelay,
  slotName,
} from "#lib/map/rain-loop.ts";
import {
  baseStyle,
  hazardVisibility,
  loopOpacity,
  loopShown,
  loopVisibility,
  overlayVisibility,
  RAIN_OPACITY,
  readHazard,
} from "#lib/map/style.ts";

/** 今後の雨の並び (`forecastFrames` の形)。11/28 05:00 (UTC) の速報で、1 時間ごとに 6 時間先まで */
const forecast: NowcFrame[] = ["06", "07", "08", "09", "10", "11"].map((h) => ({
  basetime: "20261128050000",
  validtime: `20261128${h}0000`,
  member: "immed",
}));

test("雨雲 (いま→予測): 予測は、いまの観測より先のものを近い順に 3 時間先まで", () => {
  expect(forecast[0]?.validtime).toBe("20261128060000");
  const frames = loopForecast(forecast, "20261128052500");
  expect(frames.map((f) => f.validtime)).toEqual([
    "20261128060000",
    "20261128070000",
    "20261128080000",
  ]);
  // 予測の解析が古く、いまより前の枚があっても出さない
  expect(
    loopForecast(forecast, "20261128063000").map((f) => f.validtime),
  ).toEqual(["20261128070000", "20261128080000", "20261128090000"]);
  // いまの観測をまだ読めていなければ、予測だけを近い順に
  expect(loopForecast(forecast, null)).toHaveLength(3);
  expect(loopForecast([], "20261128052500")).toEqual([]);
});

test("雨雲 (いま→予測): 出せる枚だけを順に回り、最後の枚は少し長く止めてからいまへ戻る", () => {
  const all = loopReady(true, 3);
  expect(all).toEqual([true, true, true, true]);
  expect([0, 1, 2, 3].map((s) => nextSlot(s, all))).toEqual([1, 2, 3, 0]);
  expect([0, 1, 2, 3].map((s) => slotDelay(s, all))).toEqual([
    LOOP_FRAME_MS,
    LOOP_FRAME_MS,
    LOOP_FRAME_MS,
    LOOP_LAST_MS,
  ]);
  expect(LOOP_LAST_MS).toBeGreaterThan(LOOP_FRAME_MS);
  // 予測が 1 枚しか無いときは、いまと +1 時間を回る
  const two = loopReady(true, 1);
  expect(two).toEqual([true, true, false, false]);
  expect(nextSlot(1, two)).toBe(0);
  expect(slotDelay(1, two)).toBe(LOOP_LAST_MS);
  // いまの観測を読めていないときは予測だけ。1 枚も無ければ動かない
  expect(nextSlot(3, loopReady(false, 3))).toBe(1);
  expect(nextSlot(0, loopReady(false, 0))).toBe(0);
  // 見せている枚が出せなくなったら、出せる最初の枚へ
  expect(settleSlot(3, two)).toBe(0);
  expect(settleSlot(1, two)).toBe(1);
  expect(settleSlot(2, loopReady(false, 3))).toBe(2);
  expect(settleSlot(0, loopReady(false, 3))).toBe(1);
});

test("雨雲 (いま→予測): 枚の名前は「いま」と「+N 時間」(予測の解析から何時間先か)", () => {
  expect(slotName(0, null)).toBe("いま");
  expect(slotName(1, forecast[0] ?? null)).toBe("+1 時間");
  expect(slotName(3, forecast[2] ?? null)).toBe("+3 時間");
  // まだ読めていない枚は、並びの番号で
  expect(slotName(2, null)).toBe("+2 時間");
});

test("雨雲 (いま→予測): 1 つだけ選ぶ重ねる図。地震を選んでいる間は隠し、選んでいる間は警報・注意報の塗りを隠す", () => {
  expect(readHazard("rain-loop")).toBe("rain-loop");
  expect(loopShown("rain-loop", false)).toBe(true);
  expect(loopShown("rain-loop", true)).toBe(false);
  expect(loopShown("rain", false)).toBe(false);
  const ready = loopReady(true, 2);
  const shown = loopVisibility("rain-loop", false, ready);
  expect(Object.keys(shown).sort()).toEqual([...LOOP_LAYER_IDS].sort());
  // 読めた枚は全部出してタイルを持つ (見せる枚は透明度で選ぶ)
  expect(shown["rainloop-0-4"]).toBe(true);
  expect(shown["rainloop-2-10"]).toBe(true);
  expect(shown["rainloop-3-4"]).toBe(false);
  expect(
    Object.values(loopVisibility("rain-loop", true, ready)).some(Boolean),
  ).toBe(false);
  expect(
    Object.values(loopVisibility("rain", false, ready)).some(Boolean),
  ).toBe(false);
  expect(overlayVisibility("rain-loop")["warning-fill"]).toBe(false);
  expect(overlayVisibility("rain-loop")["warning-special"]).toBe(true);
  // ハザードマップと同時には出さない (選ぶのは 1 つだけ)
  expect(Object.values(hazardVisibility("rain-loop")).some(Boolean)).toBe(
    false,
  );
  expect(loopOpacity(2, 2)).toBe(RAIN_OPACITY);
  expect(loopOpacity(1, 2)).toBe(0);
});

test("地図の style: 雨雲 (いま→予測) の層は、時刻の表を読むまで出さず、枚を替えるときに移り変わりを付けない", () => {
  const style = baseStyle("https://s.example", "rain-loop") as {
    layers: {
      id: string;
      paint?: Record<string, unknown>;
      layout?: { visibility?: string };
    }[];
  };
  const loops = style.layers.filter((l) => l.id.startsWith("rainloop-"));
  expect(loops.map((l) => l.id)).toEqual(LOOP_LAYER_IDS);
  for (const l of loops) {
    expect(l.layout?.visibility).toBe("none");
    expect(l.paint?.["raster-opacity-transition"]).toEqual({
      duration: 0,
      delay: 0,
    });
    expect(l.paint?.["raster-fade-duration"]).toBe(0);
  }
  const ids = style.layers.map((l) => l.id);
  expect(ids.indexOf("rainloop-0-4")).toBeGreaterThan(ids.indexOf("rasrf-10"));
  expect(ids.indexOf("rainloop-3-10")).toBeLessThan(ids.indexOf("hypocenters"));
  expect(validateStyleMin(style as never).map((e) => e.message)).toEqual([]);
});

test("data-lite: ソフトウェアのレンダラと、WebGL を作れない端末を見分ける", () => {
  expect(isSoftwareRenderer(null)).toBe(true);
  expect(
    isSoftwareRenderer(
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)",
    ),
  ).toBe(true);
  expect(isSoftwareRenderer("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(true);
  expect(
    isSoftwareRenderer(
      "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    ),
  ).toBe(false);
});
