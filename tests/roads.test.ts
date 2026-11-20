import { describe, expect, test } from "bun:test";

import { jstShort, roadPopup } from "#lib/map/roads.ts";
import { overlayVisibility } from "#lib/map/style.ts";
import { CREDITS, creditText } from "#lib/notice.ts";
import { openDb } from "#lib/server/db.ts";
import {
  parseRoads,
  readLimited,
  ROAD_INTERVAL_MS,
  roadResponse,
  roadSource,
  roadUrlProblem,
  roadUrls,
} from "#lib/server/sources/roads.ts";

import { fixture } from "./helpers.ts";

const UPDATED = "2026-07-31T07:00:00.000Z";
const KUMAMOTO =
  "https://www.mlit.go.jp/road/saigai/r8kumamoto/map/json/dourokisei.geojson";
const ETC =
  "https://www.mlit.go.jp/road/saigai/r8kumamoto/map/json/ETC2.0_speed_data.geojson";

describe("通れるマップの道路規制情報を読む", () => {
  test("全面通行止めで解除されていないものだけを採る (熊本の 7/31 の写し)", () => {
    const lines = parseRoads(fixture("roads/dourokisei.geojson"), UPDATED);
    // 7 つのうち、赤の全面通行止めの 2 つ (高速道路と県道) だけ。解除・灰色・紫・緊急車両のみ通行可は採らない
    expect(lines.map((l) => l.properties)).toEqual([
      {
        kind: "closed",
        route: "南九州自動車道",
        section: "八代JCT〜日奈久IC",
        rule: "全面通行止め",
        reason: "地震",
        updated: UPDATED,
      },
      {
        kind: "closed",
        route: "県道205号向山日之影線",
        section: "高千穂町大字向山秋元〜日之影町大字岩井川松鶴橋",
        rule: "全面通行止め",
        reason: "落石",
        since: "2026/7/28 17:40",
        lengthKm: 2.8,
        updated: UPDATED,
      },
    ]);
    expect(lines[0]?.geometry.type).toBe("LineString");
  });

  test("先頭の BOM と、MultiLineString も読む。形が違えば例外", () => {
    const text = `﻿${JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            路線名: "国道1号",
            規制内容: "全面通行止め",
            _color: "#ff0000",
          },
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [
                [139.123456789, 35.1],
                [139.2, 35.2],
              ],
            ],
          },
        },
      ],
    })}`;
    const [l] = parseRoads(text, UPDATED);
    expect(l?.geometry).toEqual({
      type: "MultiLineString",
      coordinates: [
        [
          [139.12346, 35.1],
          [139.2, 35.2],
        ],
      ],
    });
    expect(() => parseRoads("{}", UPDATED)).toThrow();
  });

  test("ETC2.0 の速度は色で区分にする", () => {
    const lines = parseRoads(
      fixture("roads/ETC2.0_speed_data.geojson"),
      UPDATED,
    );
    expect(lines.map((l) => l.properties.slow)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(lines.every((l) => l.properties.kind === "speed")).toBe(true);
  });
});

describe("URL の登録", () => {
  test("https の go.jp だけ", () => {
    expect(roadUrlProblem(KUMAMOTO)).toBeUndefined();
    expect(
      roadUrlProblem("https://www.qsr.mlit.go.jp/x.geojson"),
    ).toBeUndefined();
    expect(roadUrlProblem("http://www.mlit.go.jp/x")).toBe(
      "https ではありません",
    );
    expect(roadUrlProblem("https://example.com/x")).toContain("go.jp");
    expect(roadUrlProblem("https://mlit.go.jp.example.com/x")).toContain(
      "go.jp",
    );
    expect(roadUrlProblem("https://u:p@www.mlit.go.jp/x")).toContain(
      "パスワード",
    );
    expect(roadUrlProblem("x")).toBe("URL として読めません");
  });

  test("カンマか空白で区切り、重ねず、だめなものは理由を添えて外す", () => {
    const r = roadUrls(`${KUMAMOTO}, ${ETC}\n${KUMAMOTO} http://x.go.jp/a`);
    expect(r.urls).toEqual([KUMAMOTO, ETC]);
    expect(r.rejected).toEqual([
      { url: "http://x.go.jp/a", why: "https ではありません" },
    ]);
    expect(roadUrls(undefined).urls).toEqual([]);
    expect(roadUrls("").urls).toEqual([]);
  });
});

describe("取りに行く輪", () => {
  test("登録が無ければ作らない", () => {
    expect(roadSource(openDb(":memory:"), [])).toBeUndefined();
  });

  test("30 分ごとに条件付きで取り、304 なら前のものを出し続ける", async () => {
    const db = openDb(":memory:");
    const seen: Record<string, string>[] = [];
    let n = 0;
    const waits: number[] = [];
    const controller = new AbortController();
    const source = roadSource(db, [KUMAMOTO, ETC], {
      log: () => {},
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, ...(init.headers as Record<string, string>) });
        n++;
        if (n > 2) return new Response(null, { status: 304 });
        return new Response(
          fixture(
            url === KUMAMOTO
              ? "roads/dourokisei.geojson"
              : "roads/ETC2.0_speed_data.geojson",
          ),
          {
            headers: {
              etag: `"e${n}"`,
              "last-modified": "Fri, 31 Jul 2026 07:00:00 GMT",
            },
          },
        );
      }) as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 2) controller.abort();
      },
    });
    await source?.run(controller.signal);
    expect(waits).toEqual([ROAD_INTERVAL_MS, ROAD_INTERVAL_MS]);
    // 2 回目は前の ETag と Last-Modified を付ける
    expect(seen[2]?.["if-none-match"]).toBe('"e1"');
    expect(seen[2]?.["if-modified-since"]).toBe(
      "Fri, 31 Jul 2026 07:00:00 GMT",
    );
    const r = roadResponse(db, [KUMAMOTO, ETC]);
    expect(r.enabled).toBe(true);
    // 速度の細い線を先に、通行止めを後に (通行止めを上に描く)
    expect(r.data.features.map((f) => f.properties.kind)).toEqual([
      "speed",
      "speed",
      "speed",
      "speed",
      "speed",
      "closed",
      "closed",
    ]);
    expect(r.data.features[6]?.properties.updated).toBe(UPDATED);
    // 登録から外した URL のものは出さない
    expect(roadResponse(db, [ETC]).data.features).toHaveLength(5);
    expect(roadResponse(db, [])).toEqual({
      enabled: false,
      data: { type: "FeatureCollection", features: [] },
    });
  });

  test("失敗したら 5 分から倍々に空ける (上限 30 分)", async () => {
    const db = openDb(":memory:");
    const waits: number[] = [];
    const controller = new AbortController();
    const source = roadSource(db, [KUMAMOTO], {
      log: () => {},
      fetch: (async () =>
        new Response("", { status: 503 })) as unknown as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 4) controller.abort();
      },
    });
    await source?.run(controller.signal);
    expect(waits).toEqual([5 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000]);
    expect(source?.status().lastError).toContain("503");
  });
});
describe("リダイレクトと大きさ", () => {
  const run = async (
    responses: Record<string, () => Response>,
  ): Promise<{
    urls: string[];
    error?: string;
    db: ReturnType<typeof openDb>;
  }> => {
    const db = openDb(":memory:");
    const urls: string[] = [];
    const controller = new AbortController();
    const source = roadSource(db, [KUMAMOTO], {
      log: () => {},
      fetch: (async (url: string, init: RequestInit) => {
        expect(init.redirect).toBe("manual");
        urls.push(url);
        return (responses[url] ?? (() => new Response("", { status: 404 })))();
      }) as unknown as typeof fetch,
      sleep: async () => controller.abort(),
    });
    await source?.run(controller.signal);
    return { urls, error: source?.status().lastError, db };
  };

  test("go.jp の外へのリダイレクトは辿らない", async () => {
    const r = await run({
      [KUMAMOTO]: () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest" },
        }),
    });
    expect(r.urls).toEqual([KUMAMOTO]);
    expect(r.error).toContain("リダイレクト先");
  });

  test("go.jp の中のリダイレクトは辿る", async () => {
    const moved = "https://www.qsr.mlit.go.jp/x/dourokisei.geojson";
    const r = await run({
      [KUMAMOTO]: () =>
        new Response(null, { status: 301, headers: { location: moved } }),
      [moved]: () => new Response(fixture("roads/dourokisei.geojson")),
    });
    expect(r.urls).toEqual([KUMAMOTO, moved]);
    expect(roadResponse(r.db, [KUMAMOTO]).data.features).toHaveLength(2);
  });

  test("上限を超える本文は読みながら打ち切る", async () => {
    await expect(
      readLimited(new Response("x".repeat(100)), 10, "u"),
    ).rejects.toThrow("大きすぎます");
    expect(await readLimited(new Response("あい"), 10, "u")).toBe("あい");
  });
});

describe("画面", () => {
  test("通行止めの吹き出しは路線名・区間・規制の内容・更新の時刻", () => {
    expect(
      roadPopup({
        kind: "closed",
        route: "南九州自動車道",
        section: "日奈久IC〜八代IC",
        rule: "全面通行止め",
        reason: "地震",
        since: "2026/7/28 19:00",
        lengthKm: 18.97,
        updated: UPDATED,
      }).map((l) => l.text),
    ).toEqual([
      "南九州自動車道",
      "通行止め (災害)・全面通行止め",
      "日奈久IC〜八代IC",
      "理由: 地震・2026/7/28 19:00 から・延長 18.97 km",
      "2026/7/31 16:00 更新 (国土交通省)",
      "出典：国土交通省「通れるマップ」を加工して作成",
    ]);
    expect(
      roadPopup({ kind: "speed", slow: true, updated: UPDATED })[1]?.text,
    ).toBe("ETC2.0 の平均速度が時速 20 km 以下");
    expect(
      roadPopup({ kind: "speed", slow: false, updated: UPDATED }).at(-1)?.text,
    ).toBe("出典：国土交通省「通れるマップ」を加工して作成");
    expect(jstShort("2026-11-20T15:05:00Z")).toBe("2026/11/21 00:05");
  });

  test("ハザードマップを重ねている間は通れた道の線を隠し、地震を選んでいる間は出す", () => {
    expect(overlayVisibility("flood")["road-speed"]).toBe(false);
    expect(overlayVisibility("none", 5, true)["road-speed"]).toBe(true);
    expect(overlayVisibility("none")["road-closed"]).toBeUndefined();
  });

  test("入れない道路交通の情報はリンクだけを出典と注意に置く", () => {
    const text = CREDITS.map(creditText).join("\n");
    expect(text).toContain("出典：国土交通省「通れるマップ」");
    expect(text).toContain("日本道路交通情報センター (JARTIC)");
  });
});
