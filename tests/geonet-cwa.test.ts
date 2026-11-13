import { describe, expect, test } from "bun:test";

import {
  CWA_URL,
  cwaSource,
  cwaTime,
  parseCwa,
} from "#lib/server/sources/cwa.ts";
import {
  GEONET_URL,
  geonetSource,
  parseGeonet,
} from "#lib/server/sources/geonet.ts";
import type { Incoming, SourceContext } from "#lib/server/sources/types.ts";

import { fixture } from "./helpers.ts";

function context() {
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

describe("GeoNet", () => {
  test("取り消された地震を除いて、海外の地震の発表に読む", () => {
    const items = parseGeonet(fixture("geonet/quake-mmi4.json"));
    expect(items).toHaveLength(2);
    const item = items[0]?.items[0];
    if (item?.type !== "foreign") throw new Error("海外の地震ではない");
    expect(item.report).toEqual({
      source: "geonet",
      sourceId: "2026p829637",
      url: "https://www.geonet.org.nz/earthquake/2026p829637",
      originTime: "2026-11-03T23:10:49.061Z",
      lat: -42.003051758,
      lon: 172.971298218,
      depthKm: 59.33455657958984,
      magnitude: 4.1,
      place: "20 km south-east of St Arnaud",
    });
    expect(() => parseGeonet("[]")).toThrow();
  });

  test("Accept を付け、2 分ごとに取る", async () => {
    const { ctx, got } = context();
    const accepts: (string | undefined)[] = [];
    const waits: number[] = [];
    const controller = new AbortController();
    const source = geonetSource(ctx, {
      fetch: (async (url: string, init: RequestInit) => {
        expect(url).toBe(GEONET_URL);
        accepts.push((init.headers as Record<string, string>).accept);
        return new Response(fixture("geonet/quake-mmi4.json"));
      }) as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms);
        controller.abort();
      },
    });
    await source.run(controller.signal);
    expect(accepts).toEqual(["application/vnd.geo+json;version=2"]);
    expect(got).toHaveLength(2);
    expect(waits).toEqual([120_000]);
  });
});

describe("中央氣象署 (台湾)", () => {
  test("時刻は台湾の時刻 (UTC+8)", () => {
    expect(cwaTime("2026-11-13 10:20:30")).toBe("2026-11-13T02:20:30.000Z");
    expect(cwaTime("2026-11-13T10:20:30+08:00")).toBe(
      "2026-11-13T02:20:30.000Z",
    );
    expect(cwaTime("不明")).toBeUndefined();
  });

  test("地震を読み、読めない項目は飛ばす", () => {
    const items = parseCwa(fixture("cwa/made-E-A0015-001.json"));
    expect(items).toHaveLength(1);
    const item = items[0]?.items[0];
    if (item?.type !== "foreign") throw new Error("海外の地震ではない");
    expect(item.report).toMatchObject({
      source: "cwa",
      sourceId: "115123",
      url: "https://scweb.cwa.gov.tw/zh-tw/earthquake/details/2026111310203051123",
      originTime: "2026-11-13T02:20:30.000Z",
      lat: 23.88,
      lon: 121.85,
      depthKm: 15.2,
      magnitude: 5.1,
      magType: "芮氏規模",
    });
    expect(() => parseCwa('{"success":"false"}')).toThrow();
  });

  test("授権碼が無ければ作らない。あれば query で渡す", async () => {
    const { ctx } = context();
    expect(cwaSource(ctx, undefined)).toBeUndefined();
    expect(cwaSource(ctx, "  ")).toBeUndefined();
    const urls: string[] = [];
    const controller = new AbortController();
    const source = cwaSource(ctx, "CWA-TEST", {
      fetch: (async (url: string) => {
        urls.push(url);
        return new Response(fixture("cwa/made-E-A0015-001.json"));
      }) as typeof fetch,
      sleep: async () => controller.abort(),
    });
    await source?.run(controller.signal);
    expect(urls[0]?.startsWith(`${CWA_URL}?`)).toBe(true);
    expect(new URL(urls[0] ?? "").searchParams.get("Authorization")).toBe(
      "CWA-TEST",
    );
  });
});
