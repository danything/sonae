import { expect, test } from "bun:test";

import { activeEews, EEW_SHOW_MS } from "#lib/eew.ts";
import { depthText, magnitudeText } from "#lib/format.ts";
import {
  type Eew,
  intensityLabel,
  isTsunamiActive,
  type Tsunami,
  TSUNAMI_FORECAST_MS,
} from "#lib/model.ts";

test("震度は「5弱」と字で書く", () => {
  expect(intensityLabel("5-")).toBe("5弱");
  expect(intensityLabel("6+")).toBe("6強");
  expect(intensityLabel("5-?")).toBe("5弱以上未入電");
});

test("深さと M の書き方", () => {
  expect(depthText({ name: "x", depthKm: 0 })).toBe("ごく浅い");
  expect(depthText({ name: "x" })).toBe("不明");
  expect(magnitudeText({ magnitude: 7 })).toBe("M7.0");
  expect(
    magnitudeText({ magnitude: null, magnitudeText: "Ｍ８を超える巨大地震" }),
  ).toBe("Ｍ８を超える巨大地震");
});

const tsunami = (
  grade: Tsunami["areas"][number]["grade"],
  issuedAt: string,
): Tsunami => ({
  id: "t",
  eventIds: [],
  status: "normal",
  issuedAt,
  areas: [{ name: "x", grade, kindName: grade }],
  observations: [],
  cancelled: false,
  ended: false,
  provisional: false,
  sources: ["jma"],
  updatedAt: issuedAt,
});

test("津波予報だけのものは 6 時間で「いま」から外す。注意報以上は解除まで残す", () => {
  const at = "2026-11-06T19:53:00+09:00";
  const later = Date.parse(at) + TSUNAMI_FORECAST_MS + 1;
  expect(isTsunamiActive(tsunami("forecast", at), Date.parse(at))).toBe(true);
  expect(isTsunamiActive(tsunami("forecast", at), later)).toBe(false);
  expect(isTsunamiActive(tsunami("watch", at), later)).toBe(true);
});

test("緊急地震速報の帯は、訓練を出さず、時間がたったら下ろす", () => {
  const base: Eew = {
    eventId: "1",
    serial: 1,
    issuedAt: "2026-11-13T00:00:00Z",
    kind: "warning",
    final: false,
    cancelled: false,
    status: "normal",
    assumed: false,
    warnAreas: [],
    sources: ["wolfx"],
    updatedAt: "2026-11-13T00:00:00Z",
  };
  const t = Date.parse(base.updatedAt);
  expect(activeEews([base], t + 1000)).toHaveLength(1);
  expect(activeEews([base], t + EEW_SHOW_MS + 1)).toHaveLength(0);
  expect(activeEews([{ ...base, status: "training" }], t)).toHaveLength(0);
});
