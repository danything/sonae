import { describe, expect, test } from "bun:test";

import { marinePopup, nearestMarine } from "#lib/map/marine.ts";
import { openDb } from "#lib/server/db.ts";
import { LayerCache } from "#lib/server/layer-cache.ts";
import {
  cacheId,
  heightOf,
  marineResponse,
  MSIL_INTERVAL_MS,
  MSIL_LAYERS,
  msilSource,
  msilUrl,
  parseMsil,
} from "#lib/server/sources/msil.ts";

import { fixture } from "./helpers.ts";

const [GNSSA, VOLCANO] = MSIL_LAYERS as [
  (typeof MSIL_LAYERS)[number],
  (typeof MSIL_LAYERS)[number],
];
const KEY = "test-key-0123";

describe("海しるの答えを読む", () => {
  test("海底地殻変動観測点は名前・設置水深・設置機関・設置年月・URL", () => {
    const r = parseMsil(
      GNSSA,
      fixture("msil/seabed-crust-deformation-info.json"),
    );
    expect(r.more).toBe(false);
    expect(r.count).toBe(3);
    expect(r.features[0]).toEqual({
      type: "Feature",
      geometry: { type: "Point", coordinates: [143.36408, 38.88887] },
      properties: {
        kind: "gnssa",
        name: "釜石沖２",
        depthM: 2300,
        org: "海上保安庁",
        since: "2000/07",
        url: "https://www1.kaiho.mlit.go.jp/chikaku/kaitei/sgs/datalist.html",
      },
    });
  });

  test("海域火山は a 要素から URL だけを取り、標高の書き方の違いを読む", () => {
    const r = parseMsil(VOLCANO, fixture("msil/marine-volcano-DB.json"));
    expect(r.features.map((f) => f.properties)).toEqual([
      {
        kind: "volcano",
        name: "渡島大島",
        point: "江良岳",
        heightM: 732,
        basis: "日本活火山総覧 世界測地系へ変換",
        url: "https://www1.kaiho.mlit.go.jp/kaiikiDB/kaiyo3-2.htm",
      },
      {
        kind: "volcano",
        name: "伊豆東部火山群",
        point: "手石海丘（最浅部）",
        heightM: -81,
        basis: "1989年海上保安庁測量 世界測地系",
        url: "https://www1.kaiho.mlit.go.jp/kaiikiDB/kaiyo5-2.htm",
      },
      {
        kind: "volcano",
        name: "海徳海山",
        point: "東海徳場",
        heightM: -95,
        basis: "海上保安庁測量 世界測地系",
        url: "https://www1.kaiho.mlit.go.jp/kaiikiDB/kaiyo20-2.htm",
      },
      {
        kind: "volcano",
        name: "西表島北北東海底火山",
        point: undefined,
        heightM: undefined,
        basis: "日本活火山総覧(第4版）",
        url: "https://www1.kaiho.mlit.go.jp/kaiikiDB/kaiyo36-2.htm",
      },
    ]);
  });

  test("標高・水深の書き方", () => {
    expect(heightOf("732m")).toBe(732);
    expect(heightOf("-81m")).toBe(-81);
    expect(heightOf("‐95m")).toBe(-95);
    expect(heightOf("−14 m")).toBe(-14);
    expect(heightOf(" ")).toBeUndefined();
    expect(heightOf("不明")).toBeUndefined();
  });

  test("海上保安庁のページでない URL・位置の無い点は捨てる。形が違えば例外", () => {
    const text = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [140, 35] },
          properties: { 観測地点名: "A", URL: "javascript:alert(1)" },
        },
        {
          type: "Feature",
          geometry: null,
          properties: { 観測地点名: "B" },
        },
      ],
      exceededTransferLimit: true,
    });
    const r = parseMsil(GNSSA, text);
    expect(r.features).toHaveLength(1);
    expect(r.features[0]?.properties.url).toBeUndefined();
    expect(r.more).toBe(true);
    expect(() => parseMsil(GNSSA, "{}")).toThrow();
  });

  test("URL に鍵を入れない", () => {
    expect(msilUrl(GNSSA)).toBe(
      "https://api.msil.go.jp/seabed-crust-deformation-info/v2/MapServer/1/query?f=geojson&where=1%3D1&outFields=*",
    );
    expect(msilUrl(GNSSA, 1000)).toContain("&resultOffset=1000");
  });
});

/** 決まった答えを返す fetch。取った URL とヘッダーを控える */
function fakeFetch(bodies: Record<string, string | number>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const u = new URL(url);
    const path = u.pathname.split("/")[1] ?? "";
    const offset = u.searchParams.get("resultOffset") ?? "0";
    const b = bodies[`${path}@${offset}`] ?? bodies[path];
    if (typeof b === "number") return new Response("", { status: b });
    if (b === undefined) return new Response("", { status: 404 });
    return new Response(b);
  }) as typeof fetch;
  return { f, calls };
}

const BODIES = {
  "seabed-crust-deformation-info": fixture(
    "msil/seabed-crust-deformation-info.json",
  ),
  "marine-volcano-DB": fixture("msil/marine-volcano-DB.json"),
};

describe("海しるの情報源", () => {
  test("キーが無ければ作らない", () => {
    expect(msilSource(openDb(":memory:"), undefined)).toBeUndefined();
    expect(msilSource(openDb(":memory:"), "  ")).toBeUndefined();
  });

  test("鍵はヘッダーで送り、層を 1 つずつ取って置き、1 日待つ", async () => {
    const db = openDb(":memory:");
    const { f, calls } = fakeFetch(BODIES);
    const waits: number[] = [];
    const controller = new AbortController();
    const now = Date.parse("2026-11-20T00:00:00Z");
    const source = msilSource(db, KEY, {
      fetch: f,
      now: () => now,
      log: () => {},
      sleep: async (ms) => {
        waits.push(ms);
        controller.abort();
      },
    });
    await source?.run(controller.signal);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/seabed-crust-deformation-info/v2/MapServer/1/query",
      "/marine-volcano-DB/v2/MapServer/1/query",
    ]);
    for (const c of calls) {
      expect(c.headers["ocp-apim-subscription-key"]).toBe(KEY);
      expect(c.url).not.toContain(KEY);
    }
    expect(waits).toEqual([MSIL_INTERVAL_MS]);
    const r = marineResponse(db, true);
    expect(r.data.features).toHaveLength(7);
    expect(r.fetchedAt).toEqual({
      gnssa: "2026-11-20T00:00:00.000Z",
      volcano: "2026-11-20T00:00:00.000Z",
    });
    expect(source?.status().state).toBe("stopped");
  });

  test("起動し直しても、前に取ってから 1 日たつまでは取りに行かない", async () => {
    const db = openDb(":memory:");
    const cache = new LayerCache(db);
    const fc = { type: "FeatureCollection", features: [] };
    cache.put(cacheId("gnssa"), fc, "2026-11-19T12:00:00.000Z");
    cache.put(cacheId("volcano"), fc, "2026-11-19T18:00:00.000Z");
    const { f, calls } = fakeFetch(BODIES);
    const waits: number[] = [];
    const controller = new AbortController();
    const source = msilSource(db, KEY, {
      fetch: f,
      now: () => Date.parse("2026-11-20T06:00:00Z"),
      log: () => {},
      sleep: async (ms) => {
        waits.push(ms);
        controller.abort();
      },
    });
    await source?.run(controller.signal);
    expect(calls).toHaveLength(0);
    // 早いほう (海底地殻変動観測点) の 1 日後まで
    expect(waits).toEqual([6 * 60 * 60_000]);
  });

  test("exceededTransferLimit なら resultOffset で続きを取る", async () => {
    const db = openDb(":memory:");
    const first = JSON.parse(BODIES["seabed-crust-deformation-info"]);
    first.exceededTransferLimit = true;
    const second = JSON.parse(BODIES["seabed-crust-deformation-info"]);
    second.features = second.features.slice(0, 1);
    const { f, calls } = fakeFetch({
      "seabed-crust-deformation-info@0": JSON.stringify(first),
      "seabed-crust-deformation-info@3": JSON.stringify(second),
      "marine-volcano-DB": BODIES["marine-volcano-DB"],
    });
    const controller = new AbortController();
    await msilSource(db, KEY, {
      fetch: f,
      log: () => {},
      sleep: async () => controller.abort(),
    })?.run(controller.signal);
    expect(
      calls.map((c) => new URL(c.url).searchParams.get("resultOffset")),
    ).toEqual([null, "3", null]);
    expect(
      marineResponse(db, true).data.features.filter(
        (x) => x.properties.kind === "gnssa",
      ),
    ).toHaveLength(4);
  });

  test("失敗したら 15 分から倍々に空け、前に取ったものは残す", async () => {
    const db = openDb(":memory:");
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [140, 35] },
          properties: { kind: "gnssa", name: "前の点" },
        },
      ],
    };
    new LayerCache(db).put(cacheId("gnssa"), fc, "2026-11-01T00:00:00.000Z");
    const { f } = fakeFetch({ "seabed-crust-deformation-info": 500 });
    const waits: number[] = [];
    const controller = new AbortController();
    const logs: string[] = [];
    const source = msilSource(db, KEY, {
      fetch: f,
      log: (m) => logs.push(m),
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 2) controller.abort();
      },
    });
    await source?.run(controller.signal);
    expect(waits).toEqual([15 * 60_000, 30 * 60_000]);
    expect(logs.join("\n")).not.toContain(KEY);
    expect(source?.status().lastError).toContain("500");
    expect(marineResponse(db, true).data.features[0]?.properties.name).toBe(
      "前の点",
    );
  });

  test("キーが無ければ、置いてあるものも画面に渡さない", () => {
    const db = openDb(":memory:");
    new LayerCache(db).put(cacheId("gnssa"), {
      type: "FeatureCollection",
      features: [{ type: "Feature" }],
    });
    expect(marineResponse(db, false)).toEqual({
      enabled: false,
      fetchedAt: {},
      data: { type: "FeatureCollection", features: [] },
    });
  });
});

describe("海しるの点の吹き出し", () => {
  test("海底地殻変動観測点", () => {
    expect(
      marinePopup({
        kind: "gnssa",
        name: "釜石沖２",
        depthM: 2300,
        org: "海上保安庁",
        since: "2000/07",
        url: "https://www1.kaiho.mlit.go.jp/x",
      }).map((l) => l.text),
    ).toEqual([
      "釜石沖２",
      "海底地殻変動観測点 (GNSS-A)",
      "設置水深 2,300 m",
      "設置機関 海上保安庁・2000 年 7 月 設置",
      "観測の結果 (海上保安庁)",
      "出典：海洋状況表示システム (海しる)。海上保安庁が保証するものではありません",
    ]);
  });

  test("海域火山は海の下なら水深で書く", () => {
    const texts = (heightM?: number) =>
      marinePopup({
        kind: "volcano",
        name: "海徳海山",
        point: "東海徳場",
        heightM,
      })
        .map((l) => l.text)
        .slice(0, 4);
    expect(texts(-95)).toEqual([
      "海徳海山",
      "海域火山",
      "東海徳場",
      "水深 95 m (いちばん浅い所)",
    ]);
    expect(texts(732)[3]).toBe("標高 732 m");
    expect(texts(undefined)[3]).toContain("出典");
  });

  test("押した所にいちばん近い点", () => {
    expect(nearestMarine([{ d2: 9 }, { d2: 4 }, { d2: 16 }])).toEqual({
      d2: 4,
    });
    expect(nearestMarine([])).toBeUndefined();
  });
});
