import { describe, expect, test } from "bun:test";

import { foreignFeatures } from "#lib/map/style.ts";
import {
  distanceKm,
  type ForeignQuake,
  type ForeignReport,
  sameForeignQuake,
} from "#lib/model.ts";
import { noticeOf } from "#lib/notify.ts";
import { pollSource } from "#lib/server/sources/poll.ts";
import type { Incoming, SourceContext } from "#lib/server/sources/types.ts";
import {
  parseUsgs,
  USGS_DAY_FEED,
  USGS_FEED,
  usgsSource,
} from "#lib/server/sources/usgs.ts";

import { fixture, memoryStore } from "./helpers.ts";

const USGS = fixture("usgs/4.5_day.geojson");

export function context() {
  const got: Incoming[] = [];
  const keys = new Set<string>();
  const ctx: SourceContext = {
    emit: (m) => {
      got.push(m);
      keys.add(`${m.source}:${m.key}`);
    },
    seen: (s, k) => keys.has(`${s}:${k}`),
  };
  return { ctx, got };
}

const report = (over: Partial<ForeignReport> = {}): ForeignReport => ({
  source: "usgs",
  sourceId: "us1",
  originTime: "2026-11-13T12:00:00.000Z",
  lat: -1.5,
  lon: 150,
  depthKm: 10,
  magnitude: 6.1,
  place: "near Papua New Guinea",
  ...over,
});

describe("USGS の GeoJSON", () => {
  test("地震ごとに、id と更新の時刻を鍵にして読む", () => {
    const items = parseUsgs(USGS);
    expect(items).toHaveLength(3);
    const first = items[0];
    expect(first?.key).toBe("us7000ty43@2026-11-13T20:33:12.040Z");
    const item = first?.items[0];
    if (item?.type !== "foreign") throw new Error("海外の地震ではない");
    expect(item.report).toEqual({
      source: "usgs",
      sourceId: "us7000ty43",
      url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000ty43",
      originTime: "2026-11-13T19:49:21.768Z",
      lat: -1.4671,
      lon: 149.9613,
      depthKm: 10,
      magnitude: 4.8,
      magType: "mww",
      place: "153 km NW of Kavieng, Papua New Guinea",
      tsunami: false,
      updatedAt: "2026-11-13T20:33:12.040Z",
    });
  });

  test("形が違えば例外 (その回を捨てる)。地震でないものは飛ばす", () => {
    expect(() => parseUsgs("{}")).toThrow();
    expect(() => parseUsgs("<html>")).toThrow();
    const doc = JSON.parse(USGS);
    doc.features[0].properties.type = "quarry blast";
    expect(parseUsgs(JSON.stringify(doc))).toHaveLength(2);
  });
});

describe("海外の地震をまとめる", () => {
  test("距離と、同じ地震とみなす近さ", () => {
    expect(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(
      111.2,
      0,
    );
    const a = report();
    expect(sameForeignQuake(a, report({ lat: -1.0, magnitude: 6.4 }))).toBe(
      true,
    );
    expect(
      sameForeignQuake(a, report({ originTime: "2026-11-13T12:02:00.000Z" })),
    ).toBe(false);
    expect(sameForeignQuake(a, report({ lat: 1.5 }))).toBe(false);
    expect(sameForeignQuake(a, report({ magnitude: 4.5 }))).toBe(false);
    expect(sameForeignQuake(a, report({ magnitude: undefined }))).toBe(true);
  });

  test("同じ id の続報は置き換え、中身が同じならイベントを出さない", () => {
    const { store } = memoryStore();
    const put = (r: ForeignReport, key: string) =>
      store.ingest({
        source: r.source,
        key,
        code: "test",
        items: [{ type: "foreign", report: r }],
      });
    expect(put(report(), "a")).toHaveLength(1);
    expect(put(report(), "b")).toHaveLength(0);
    const [e] = put(report({ magnitude: 6.3 }), "c");
    if (e?.type !== "foreign") throw new Error("海外の地震ではない");
    expect(e.data.magnitude).toBe(6.3);
    expect(store.foreignQuakes()).toHaveLength(1);
  });

  test("ほかの機関の同じ地震は 1 つにまとめ、いまの姿は機関の順で採る", () => {
    const { store } = memoryStore();
    store.ingest({
      source: "usgs",
      key: "1",
      code: "test",
      items: [{ type: "foreign", report: report() }],
    });
    const [e] = store.ingest({
      source: "emsc",
      key: "2",
      code: "test",
      items: [
        {
          type: "foreign",
          report: report({
            source: "emsc",
            sourceId: "E1",
            lat: -1.6,
            magnitude: 6.0,
            place: "NEW IRELAND REGION, P.N.G.",
          }),
        },
      ],
    });
    const q = e?.data as ForeignQuake;
    expect(q.id).toBe("usgs-us1");
    expect(q.reports.map((r) => r.source)).toEqual(["usgs", "emsc"]);
    // USGS が先 (EMSC は速報で、後から USGS が来ても USGS の値になる)
    expect(q.magnitude).toBe(6.1);
    expect(store.foreignQuakes()).toHaveLength(1);
  });

  test("同じ機関の別の地震は、近くても別にする", () => {
    const { store } = memoryStore();
    for (const [id, key] of [
      ["us1", "1"],
      ["us2", "2"],
    ] as const)
      store.ingest({
        source: "usgs",
        key,
        code: "test",
        items: [{ type: "foreign", report: report({ sourceId: id }) }],
      });
    expect(store.foreignQuakes()).toHaveLength(2);
  });

  test("知らせない。地図の点は色が深さ・大きさが M", () => {
    const { store } = memoryStore();
    const [e] = store.ingest({
      source: "usgs",
      key: "1",
      code: "test",
      items: [{ type: "foreign", report: report() }],
    });
    if (!e) throw new Error("イベントが無い");
    expect(noticeOf(e, Date.parse("2026-11-13T12:01:00Z"))).toBeNull();
    expect(foreignFeatures([e.data as ForeignQuake]).features[0]).toEqual({
      type: "Feature",
      properties: { id: "usgs-us1", m: 6.1, depth: 10, order: 50 },
      geometry: { type: "Point", coordinates: [150, -1.5] },
    });
  });
});

describe("決まった間隔で取りに行く輪", () => {
  test("最初に 1 日分、それから 1 時間分。304 は何もしない。間隔は 60 秒より短くしない", async () => {
    const { ctx, got } = context();
    const urls: string[] = [];
    const headers: Record<string, string>[] = [];
    const waits: number[] = [];
    const controller = new AbortController();
    let n = 0;
    const source = usgsSource(ctx, {
      intervalMs: 1000,
      fetch: (async (url: string, init: RequestInit) => {
        urls.push(url);
        headers.push(init.headers as Record<string, string>);
        n++;
        if (n === 3) return new Response(null, { status: 304 });
        return new Response(USGS, {
          headers: { "last-modified": "Fri, 13 Nov 2026 21:46:30 GMT" },
        });
      }) as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length >= 2) controller.abort();
      },
    });
    await source.run(controller.signal);
    expect(urls).toEqual([USGS_DAY_FEED, USGS_FEED, USGS_FEED]);
    // 2 回目からは If-Modified-Since を付ける
    expect(headers[2]?.["if-modified-since"]).toBe(
      "Fri, 13 Nov 2026 21:46:30 GMT",
    );
    // 1 日分と 1 時間分で同じ地震は 1 回だけ渡す
    expect(got).toHaveLength(3);
    expect(waits).toEqual([60_000, 60_000]);
    expect(source.status().state).toBe("stopped");
  });

  test("失敗したら間隔を倍々に空け (上限あり)、読めない形でも止まらない", async () => {
    const { ctx } = context();
    const waits: number[] = [];
    const controller = new AbortController();
    let n = 0;
    const source = pollSource(ctx, {
      id: "usgs",
      url: "https://example.invalid/feed",
      intervalMs: 60_000,
      minIntervalMs: 60_000,
      maxBackoffMs: 200_000,
      parse: (text) => parseUsgs(text),
      log: () => {},
      fetch: (async () => {
        n++;
        if (n === 1) return new Response("oops", { status: 503 });
        return new Response("<html>形が変わった</html>");
      }) as unknown as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length >= 4) controller.abort();
      },
    });
    await source.run(controller.signal);
    expect(waits).toEqual([60_000, 120_000, 200_000, 200_000]);
    expect(source.status().lastError).toContain("JSON");
  });
});
