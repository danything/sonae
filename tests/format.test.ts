import { expect, test } from "bun:test";

import {
  depthText,
  EEW_DRILL_NOTE,
  eewSourceLine,
  floodStationsText,
  jst,
  jstSeconds,
  jstTime,
  magnitudeText,
  quakeName,
  sourceInTrouble,
  sourceStateText,
  STATUS_LABEL,
  transportText,
  waterLevelText,
} from "#lib/format.ts";
import { type Tsunami, tsunamiTop } from "#lib/model.ts";

test("地震の名前: 震源が無ければ最初の地域で「など」、地域も無ければ調査中", () => {
  const h = { name: "島根県西部", lat: 35.2, lon: 132.6 };
  expect(quakeName({ hypocenter: h, areas: [] })).toBe("島根県西部");
  expect(quakeName({ areas: [{ name: "熊本県熊本地方", int: "3" }] })).toBe(
    "熊本県熊本地方 など",
  );
  expect(quakeName({ areas: [] })).toBe("震源は調査中");
});

test("一覧の時刻・深さ・M の書き方", () => {
  expect(jstTime("2026-11-13T15:03:45Z")).toBe("00:03");
  expect(jstTime(undefined)).toBe("—");
  expect(depthText({ name: "x", depthKm: 0 })).toBe("ごく浅い");
  expect(depthText({ name: "x" })).toBe("不明");
  expect(magnitudeText({ magnitude: 3.5 })).toBe("M3.5");
  expect(magnitudeText({ magnitude: 7 })).toBe("M7.0");
  expect(magnitudeText({ magnitudeText: "Ｍ不明" })).toBe("Ｍ不明");
  expect(
    magnitudeText({ magnitude: null, magnitudeText: "Ｍ８を超える巨大地震" }),
  ).toBe("Ｍ８を超える巨大地震");
});

test("津波のいちばん強い区分 (解除・なしだけなら none)", () => {
  const t = (...grades: Tsunami["areas"][number]["grade"][]) => ({
    areas: grades.map((grade) => ({ name: "", kindName: "", grade })),
  });
  expect(tsunamiTop(t("watch", "warning", "none"))).toBe("warning");
  expect(tsunamiTop(t("none"))).toBe("none");
});

test("受信の状態の 1 行 (受信中は最後に受けた時刻、オフは訳)", () => {
  const since = "2026-11-13T00:00:00Z";
  expect(
    sourceStateText({
      id: "jma",
      state: "connected",
      lastSeenAt: "2026-11-13T14:41:07Z",
      since,
    }),
  ).toBe("受信中・11/13 23:41:07");
  expect(sourceStateText({ id: "p2p", state: "retrying", since })).toBe(
    "再接続中",
  );
  expect(
    sourceStateText({
      id: "cwa",
      state: "off",
      reason: "授権碼がありません",
      since,
    }),
  ).toBe("オフ (授権碼がありません)");
});

test("受信の状態の時刻だけ秒まで出す (一覧の時刻は秒を出さない)", () => {
  const at = "2026-11-21T01:00:23Z";
  expect(jstSeconds(at)).toBe("11/21 10:00:23");
  expect(jst(at)).toBe("11/21 10:00");
  expect(jstSeconds(undefined)).toBe("—");
});

test("つなぎ方の一言", () => {
  expect(transportText({ kind: "websocket" })).toBe("WebSocket");
  expect(transportText({ kind: "sse" })).toBe("SSE");
  expect(transportText({ kind: "poll", everyMs: 60_000 })).toBe(
    "1 分ごとに取得",
  );
  expect(transportText({ kind: "poll", everyMs: 30 * 60_000 })).toBe(
    "30 分ごとに取得",
  );
  expect(transportText({ kind: "poll", everyMs: 24 * 60 * 60_000 })).toBe(
    "1 日ごとに取得",
  );
  expect(transportText({ kind: "poll", everyMs: 90_000 })).toBe(
    "90 秒ごとに取得",
  );
  expect(transportText(undefined)).toBe("");
});

test("設定で切ってある情報源は問題にしない (注意の印を出さない)", () => {
  const since = "2026-11-13T00:00:00Z";
  expect(sourceInTrouble({ id: "jma", state: "connected", since })).toBe(false);
  expect(sourceInTrouble({ id: "cwa", state: "off", since })).toBe(false);
  expect(sourceInTrouble({ id: "wolfx", state: "stopped", since })).toBe(true);
  expect(sourceInTrouble({ id: "usgs", state: "connecting", since })).toBe(
    true,
  );
});

test("緊急地震速報の箱の震源の行は、無いものを「・」でつながない", () => {
  const h = { name: "石川県能登地方", depthKm: 10 };
  expect(eewSourceLine({ hypocenter: h, magnitude: 5.6 })).toBe(
    "震源 石川県能登地方・深さ 約 10 km・M5.6",
  );
  expect(eewSourceLine({ hypocenter: h })).toBe(
    "震源 石川県能登地方・深さ 約 10 km",
  );
  // 震源が無く M だけのときに「・M5.6」と始めない
  expect(eewSourceLine({ magnitude: 5.6 })).toBe("M5.6");
  expect(eewSourceLine({})).toBe("");
});

test("訓練・試験の緊急地震速報は、先頭に出す印と文で本物と取り違えないようにする (通常は出さない)", () => {
  expect(STATUS_LABEL.normal).toBe("");
  expect(EEW_DRILL_NOTE.normal).toBe("");
  expect(STATUS_LABEL.training).toBe("訓練");
  expect(EEW_DRILL_NOTE.training).toBe(
    "訓練の緊急地震速報です。実際の地震ではありません。",
  );
  expect(STATUS_LABEL.test).toBe("試験");
  expect(EEW_DRILL_NOTE.test).toBe(
    "試験の緊急地震速報です。実際の地震ではありません。",
  );
});

test("水位は小数 2 桁、一覧の行には基準観測所の実況だけ", () => {
  expect(waterLevelText(5.3)).toBe("5.30 m");
  expect(waterLevelText(undefined)).toBe("—");
  const level = (m?: number) => ({
    time: "2025-11-02T14:50:00+09:00",
    label: "現況",
    ...(m === undefined ? {} : { m }),
  });
  const station = (name: string, base: boolean, m?: number) => ({
    name,
    code: name,
    base,
    levels: [level(m)],
    criteria: [],
  });
  expect(
    floodStationsText({
      stations: [
        station("上川沿", true, 6.19),
        station("北見", false, 54.7),
        station("妙見橋", true),
      ],
    }),
  ).toBe("上川沿 6.19 m (14:50)");
  expect(floodStationsText({})).toBe("");
});
