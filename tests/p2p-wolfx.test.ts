import { describe, expect, test } from "bun:test";

import { parseP2p } from "#lib/server/sources/p2p-json.ts";
import { parseWolfx } from "#lib/server/sources/wolfx-json.ts";

import { json } from "./helpers.ts";

describe("P2P地震情報 (仕様書の例)", () => {
  test("551 地震情報: 震源・M・観測点、日本時間の時刻", () => {
    const [item] = parseP2p(json("p2p/spec-551.json"));
    if (item?.type !== "quake") throw new Error("quake ではない");
    expect(item.eventId).toBeUndefined();
    expect(item.report).toMatchObject({
      kind: "detail",
      source: "p2p",
      reportedAt: "2019-08-26T20:57:00+09:00",
      originTime: "2019-08-26T20:53:00+09:00",
      hypocenter: { name: "宮古島近海", lat: 24.4, lon: 125.2, depthKm: 50 },
      magnitude: 4,
      maxInt: "1",
    });
    expect(item.report.stations).toHaveLength(2);
    expect(item.report.areas).toHaveLength(0);
    expect(item.report.comments).toEqual([
      "この地震による津波の心配はありません。",
    ]);
  });

  test("551: 震源が無いときの -200・-1 は無いものとして扱う", () => {
    const v = json("p2p/spec-551.json");
    const eq = v.earthquake as Record<string, unknown>;
    eq.hypocenter = {
      name: "",
      latitude: -200,
      longitude: -200,
      depth: -1,
      magnitude: -1,
    };
    eq.maxScale = 45;
    (v.issue as Record<string, unknown>).type = "ScalePrompt";
    v.points = [
      { addr: "沖縄本島地方", isArea: true, pref: "沖縄県", scale: 46 },
    ];
    const [item] = parseP2p(v);
    if (item?.type !== "quake") throw new Error("quake ではない");
    expect(item.report.kind).toBe("scale");
    expect(item.report.hypocenter).toBeUndefined();
    expect(item.report.magnitude).toBeUndefined();
    expect(item.report.areas).toEqual([
      { name: "沖縄本島地方", pref: "沖縄県", int: "5-?" },
    ]);
  });

  test("552 津波予報: 区分と到達予想", () => {
    const [item] = parseP2p(json("p2p/spec-552.json"));
    if (item?.type !== "tsunami") throw new Error("tsunami ではない");
    expect(item.report.areas).toEqual([
      {
        name: "福島県",
        grade: "warning",
        kindName: "津波警報",
        immediate: true,
        arrivalTime: undefined,
        condition: "津波到達中と推測",
        maxHeightText: "３ｍ",
      },
      {
        name: "青森県太平洋沿岸",
        grade: "watch",
        kindName: "津波注意報",
        immediate: undefined,
        arrivalTime: "2019-06-18T22:40:00+09:00",
        condition: undefined,
        maxHeightText: "１ｍ",
      },
    ]);
  });

  test("552 の解除 (cancelled) は空の予報区", () => {
    const [item] = parseP2p({ ...json("p2p/spec-552.json"), cancelled: true });
    if (item?.type !== "tsunami") throw new Error("tsunami ではない");
    expect(item.report.areas).toEqual([]);
  });

  test("556 緊急地震速報 (警報): 予測震度は持たない", () => {
    const [item] = parseP2p(json("p2p/spec-556.json"));
    if (item?.type !== "eew") throw new Error("eew ではない");
    expect(item.report).toEqual({
      source: "p2p",
      eventId: "20220811005302",
      serial: 1,
      issuedAt: "2022-08-11T00:53:24+09:00",
      kind: "warning",
      final: false,
      cancelled: false,
      status: "normal",
      assumed: false,
      originTime: "2022-08-11T00:53:00+09:00",
      hypocenter: { name: "宗谷地方北部", lat: 44.9, lon: 142.1, depthKm: 10 },
      magnitude: 5.5,
      warnAreas: ["上川地方北部"],
    });
    expect(JSON.stringify(item.report)).not.toContain("scale");
  });

  test("556 の test は試験として扱う", () => {
    const [item] = parseP2p({ ...json("p2p/spec-556.json"), test: true });
    expect(item?.type === "eew" && item.report.status).toBe("test");
  });

  test("扱わない code は捨てる", () => {
    expect(parseP2p({ id: "x", code: 561, area: 250 })).toEqual([]);
    expect(parseP2p({ id: "x", code: 554, type: "Full" })).toEqual([]);
  });
});

describe("Wolfx (作った JSON)", () => {
  test("heartbeat", () => {
    expect(parseWolfx(json("wolfx/made-heartbeat.json"))).toEqual({
      type: "heartbeat",
    });
  });

  test("予報: 予想震度・原文は持たない", () => {
    const m = parseWolfx(json("wolfx/made-forecast.json"));
    if (m.type !== "eew") throw new Error("eew ではない");
    expect(m.key).toBe("20220811005302-1");
    expect(m.report).toMatchObject({
      kind: "forecast",
      serial: 1,
      issuedAt: "2022-08-11T00:53:20+09:00",
      magnitude: 5.3,
      warnAreas: [],
      status: "normal",
    });
    const text = JSON.stringify(m.report);
    expect(text).not.toContain("OriginalText");
    expect(text).not.toContain("MaxIntensity");
  });

  test("警報: 警報の地域だけを取る", () => {
    const m = parseWolfx(json("wolfx/made-warning.json"));
    if (m.type !== "eew") throw new Error("eew ではない");
    expect(m.report.kind).toBe("warning");
    expect(m.report.warnAreas).toEqual(["上川地方北部"]);
  });

  test("訓練と取消", () => {
    const m = parseWolfx({
      ...json("wolfx/made-warning.json"),
      isTraining: true,
      isCancel: true,
    });
    if (m.type !== "eew") throw new Error("eew ではない");
    expect(m.report.status).toBe("training");
    expect(m.report.cancelled).toBe(true);
    expect(m.key).toBe("20220811005302-2-cancel");
  });

  test("ほかのチャンネルの電文は捨てる", () => {
    expect(parseWolfx({ type: "sc_eew", ID: 1 }).type).toBe("unknown");
  });
});
