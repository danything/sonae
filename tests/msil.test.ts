import { describe, expect, test } from "bun:test";

import {
  marinePopup,
  nearestMarine,
  type TideDay,
  tideDayLabel,
  tidePolyline,
  tideTurns,
  tideTurnText,
} from "#lib/map/marine.ts";
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
  parseTide,
  TIDE_MAX_FETCHES,
  TideFetcher,
  TideRefused,
  tideUrl,
} from "#lib/server/sources/msil.ts";

import { fixture } from "./helpers.ts";

type Layer = (typeof MSIL_LAYERS)[number];
const [GNSSA, VOLCANO, OFFICE, TIDE] = MSIL_LAYERS as [
  Layer,
  Layer,
  Layer,
  Layer,
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
  "coast-guard-office": fixture("msil/coast-guard-office.json"),
  "tide-prediction": fixture("msil/tide-station.json"),
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
      "/coast-guard-office/v2/MapServer/1/query",
      "/tide-prediction/v3/station",
    ]);
    for (const c of calls) {
      expect(c.headers["ocp-apim-subscription-key"]).toBe(KEY);
      expect(c.url).not.toContain(KEY);
    }
    expect(waits).toEqual([MSIL_INTERVAL_MS]);
    const r = marineResponse(db, true);
    // 3 + 4 + 2 + 2 (形の違うコードの地点は捨てる)
    expect(r.data.features).toHaveLength(11);
    expect(r.fetchedAt).toEqual({
      gnssa: "2026-11-20T00:00:00.000Z",
      volcano: "2026-11-20T00:00:00.000Z",
      office: "2026-11-20T00:00:00.000Z",
      tide: "2026-11-20T00:00:00.000Z",
    });
    expect(source?.status().state).toBe("stopped");
  });

  test("起動し直しても、前に取ってから 1 日たつまでは取りに行かない", async () => {
    const db = openDb(":memory:");
    const cache = new LayerCache(db);
    const fc = { type: "FeatureCollection", features: [] };
    cache.put(cacheId("gnssa"), fc, "2026-11-19T12:00:00.000Z");
    cache.put(cacheId("volcano"), fc, "2026-11-19T18:00:00.000Z");
    cache.put(cacheId("office"), fc, "2026-11-19T18:00:00.000Z");
    cache.put(cacheId("tide"), fc, "2026-11-19T18:00:00.000Z");
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
      "coast-guard-office": BODIES["coast-guard-office"],
      "tide-prediction": BODIES["tide-prediction"],
    });
    const controller = new AbortController();
    await msilSource(db, KEY, {
      fetch: f,
      log: () => {},
      sleep: async () => controller.abort(),
    })?.run(controller.signal);
    expect(
      calls.map((c) => new URL(c.url).searchParams.get("resultOffset")),
    ).toEqual([null, "3", null, null, null]);
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

describe("海上保安部署等と潮汐推算の地点", () => {
  test("海上保安部署等は名前・所在地・電話番号・海上保安庁のページ", () => {
    const r = parseMsil(OFFICE, fixture("msil/coast-guard-office.json"));
    expect(r.features.map((f) => f.properties)).toEqual([
      {
        kind: "office",
        name: "横須賀海上保安部",
        address: "〒237-0071 神奈川県横須賀市田浦港町無番地",
        phone: "046-862-0118",
        url: "https://www.kaiho.mlit.go.jp/03kanku/yokosuka/",
      },
      {
        kind: "office",
        name: "作り物海上保安署",
        address: "千葉県千葉市作り物町 1",
        phone: undefined,
        url: undefined,
      },
    ]);
  });

  test("潮汐推算の地点は名前とコード。形の違うコードは捨てる", () => {
    const r = parseMsil(TIDE, fixture("msil/tide-station.json"));
    expect(r.features.map((f) => f.properties)).toEqual([
      { kind: "tide", name: "根室", code: "0114" },
      { kind: "tide", name: "作り物港", code: "9901" },
    ]);
    expect(TIDE.url).toBe("https://api.msil.go.jp/tide-prediction/v3/station");
  });

  test("吹き出し: 海上保安部署は 118 番、潮汐推算は推算であること", () => {
    expect(
      marinePopup({
        kind: "office",
        name: "横須賀海上保安部",
        address: "〒237-0071 神奈川県横須賀市田浦港町無番地",
        phone: "046-862-0118",
        url: "https://www.kaiho.mlit.go.jp/03kanku/yokosuka/",
      }).map((l) => l.text),
    ).toEqual([
      "横須賀海上保安部",
      "海上保安部署 (海上保安庁)",
      "〒237-0071 神奈川県横須賀市田浦港町無番地",
      "電話 046-862-0118",
      "海の事件・事故は 118 番 (海上保安庁)",
      "部署のページ (海上保安庁)",
      "出典：海洋状況表示システム (海しる)。海上保安庁が保証するものではありません",
    ]);
    const tide = marinePopup({ kind: "tide", name: "根室", code: "0114" });
    expect(tide.map((l) => l.text).slice(0, 2)).toEqual([
      "根室",
      "潮汐推算の地点 (海上保安庁)",
    ]);
    expect(tide[2]?.text).toContain("津波や高潮の観測ではなく");
  });
});

/** 1 分ごとの 1 日分 (半日周期の作り物)。山は 3:00 と 15:25 ごろ */
function sineDay(date = "2026-11-28"): TideDay {
  const tide = Array.from({ length: 1441 }, (_, i) =>
    Math.round(100 + 80 * Math.cos(((i - 180) / 745) * 2 * Math.PI)),
  );
  return {
    code: "9901",
    date,
    start: new Date(Date.parse(`${date}T00:00:00+09:00`)).toISOString(),
    stepSec: 60,
    tide,
  };
}

describe("潮汐推算の値", () => {
  test("推算潮位の答えを読む。値の並びが半日に満たない例は 1 時間ごとと読む", () => {
    const d = parseTide(
      "0114",
      "2026-01-05",
      fixture("msil/tide-data-example.json"),
    );
    expect(d.stepSec).toBe(3600);
    expect(d.start).toBe("2026-01-05T12:00:00.000Z");
    expect(d.tide).toHaveLength(24);
    const full = parseTide(
      "0114",
      "2026-11-28",
      JSON.stringify({
        interval: 60,
        stationCode: "0114",
        tide: sineDay().tide,
      }),
    );
    expect(full.stepSec).toBe(60);
    // time が無ければ、その日の 0 時 (日本時間) から
    expect(full.start).toBe("2026-11-27T15:00:00.000Z");
    // 時差の無い時刻は日本時間と読む
    expect(
      parseTide(
        "0114",
        "2026-11-28",
        JSON.stringify({ time: "2026-11-28T00:00:00", tide: sineDay().tide }),
      ).start,
    ).toBe("2026-11-27T15:00:00.000Z");
    expect(() => parseTide("0114", "2026-11-28", "{}")).toThrow();
    expect(() =>
      parseTide("0114", "2026-11-28", JSON.stringify({ tide: [1, "x"] })),
    ).toThrow();
  });

  test("満潮と干潮は値の山と谷を拾うだけ。日の端は拾わない", () => {
    const turns = tideTurns(sineDay());
    expect(turns.map((t) => t.kind)).toEqual(["high", "low", "high", "low"]);
    expect(turns.map(tideTurnText)).toEqual([
      "満潮 3:00 180 cm",
      "干潮 9:13 20 cm",
      "満潮 15:25 180 cm",
      "干潮 21:38 20 cm",
    ]);
  });

  test("同じ値が続く山は真ん中の時刻。小さな揺れは拾わない", () => {
    const d: TideDay = {
      code: "x",
      date: "2026-11-28",
      start: "2026-11-27T15:00:00.000Z",
      stepSec: 600,
      // 10 分ごと。1:00〜1:20 が同じ高さの山、2:30 の小さな揺れ (前後 90 分の中でいちばん高くない)
      tide: [
        10, 20, 30, 40, 50, 60, 70, 70, 70, 60, 50, 40, 30, 31, 30, 20, 10, 5,
        0, 5,
      ],
    };
    expect(tideTurns(d).map((t) => [t.kind, tideTurnText(t)])).toEqual([
      ["high", "満潮 1:10 70 cm"],
      ["low", "干潮 3:00 0 cm"],
    ]);
  });

  test("図の線は値の高さを図の中で合わせる", () => {
    const d: TideDay = {
      code: "x",
      date: "2026-11-28",
      start: "2026-11-27T15:00:00.000Z",
      stepSec: 600,
      tide: [0, 50, 100],
    };
    expect(tidePolyline(d, 100, 10)).toEqual({
      points: "0.0,10.0 50.0,5.0 100.0,0.0",
      min: 0,
      max: 100,
    });
    expect(tideDayLabel("2026-11-28")).toBe("11/28(土)");
  });

  test("URL は地点のコードと日 (8 桁)。鍵は入れない", () => {
    expect(tideUrl("0114", "2026-11-28")).toBe(
      "https://api.msil.go.jp/tide-prediction/v3/data?stationCode=0114&date=20261128",
    );
  });
});

describe("潮汐推算を取りに行く (/api/tide)", () => {
  function setup(now = Date.parse("2026-11-28T03:00:00Z")) {
    const db = openDb(":memory:");
    new LayerCache(db).put(cacheId("tide"), {
      type: "FeatureCollection",
      features: parseMsil(TIDE, fixture("msil/tide-station.json")).features,
    });
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return new Response(
        JSON.stringify({
          time: "2026-11-28T00:00:00+09:00",
          interval: 60,
          stationCode: "0114",
          tide: sineDay().tide,
        }),
      );
    }) as typeof fetch;
    let t = now;
    const fetcher = new TideFetcher(db, KEY, { fetch: f, now: () => t });
    return { fetcher, calls, advance: (ms: number) => (t += ms) };
  }

  test("一覧にある地点の今日の値を取り、同じ日は覚えたものを返す", async () => {
    const { fetcher, calls, advance } = setup();
    const d = await fetcher.today("0114");
    expect(d.date).toBe("2026-11-28");
    expect(d.tide).toHaveLength(1441);
    await fetcher.today("0114");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["ocp-apim-subscription-key"]).toBe(KEY);
    expect(calls[0]?.url).not.toContain(KEY);
    expect(calls[0]?.url).toContain("date=20261128");
    // 日本時間の日が替わったら取り直す
    advance(15 * 60 * 60_000);
    expect((await fetcher.today("0114")).date).toBe("2026-11-29");
    expect(calls).toHaveLength(2);
  });

  test("一覧に無い地点・形の違うコードは取りに行かない", async () => {
    const { fetcher, calls } = setup();
    for (const code of ["1234", "../x", ""]) {
      const err = await fetcher.today(code).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TideRefused);
      expect((err as TideRefused).status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  test("10 分に 30 回より多くは取りに行かない", async () => {
    const db = openDb(":memory:");
    const features = Array.from({ length: TIDE_MAX_FETCHES + 1 }, (_, i) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [140, 35] },
      properties: { kind: "tide", name: `地点${i}`, code: String(1000 + i) },
    }));
    new LayerCache(db).put(cacheId("tide"), {
      type: "FeatureCollection",
      features,
    });
    let n = 0;
    const f = (async () => {
      n++;
      return new Response(JSON.stringify({ tide: sineDay().tide }));
    }) as unknown as typeof fetch;
    let t = Date.parse("2026-11-28T03:00:00Z");
    const fetcher = new TideFetcher(db, KEY, { fetch: f, now: () => t });
    for (let i = 0; i < TIDE_MAX_FETCHES; i++)
      await fetcher.today(String(1000 + i));
    const err = await fetcher
      .today(String(1000 + TIDE_MAX_FETCHES))
      .catch((e: unknown) => e);
    expect((err as TideRefused).status).toBe(429);
    expect(n).toBe(TIDE_MAX_FETCHES);
    t += 10 * 60_000;
    await fetcher.today(String(1000 + TIDE_MAX_FETCHES));
    expect(n).toBe(TIDE_MAX_FETCHES + 1);
  });
});
