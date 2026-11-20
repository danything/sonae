import { describe, expect, test } from "bun:test";

import { sourceInTrouble, sourceStateText } from "#lib/format.ts";
import type { SourceStatus } from "#lib/model.ts";
import { openDb } from "#lib/server/db.ts";
import {
  disasterMapUrl,
  disasterSlugs,
  DISCOVER_INTERVAL_MS,
  discovered,
  DISCOVERED_GEOJSON,
  discoverOnce,
  readDisasterMap,
  ROAD_LIST_URL,
  roadDiscoverOn,
} from "#lib/server/sources/road-discover.ts";
import {
  activeRoadUrls,
  roadResponse,
  roadSource,
} from "#lib/server/sources/roads.ts";

import { fixture } from "./helpers.ts";

const KUMAMOTO =
  "https://www.mlit.go.jp/road/saigai/r8kumamoto/map/json/dourokisei.geojson";
const ETC =
  "https://www.mlit.go.jp/road/saigai/r8kumamoto/map/json/ETC2.0_speed_data.geojson";
const MAP = disasterMapUrl("r8kumamoto");

describe("一覧のページを読む", () => {
  test("道路局のトップページから災害のページを見つける (2026-11-21 の写し)", () => {
    // 熊本の通れるマップだけ。能登 (/road/r6noto/) は形の違う地図なので採らない
    expect(disasterSlugs(fixture("roads/road-index.html"))).toEqual([
      "r8kumamoto",
    ]);
  });

  test("http のリンクも同じページとして扱い、試しのページとほかの所は採らない", () => {
    const html = `<title>道路 - 国土交通省</title>
      <a href="http://www.mlit.go.jp/road/saigai/r9a/">a</a>
      <a href="/road/saigai/r9b/index.html?x=1#y">b</a>
      <a href="https://www.mlit.go.jp/road/saigai/test/index.html">試し</a>
      <a href="https://www.qsr.mlit.go.jp/road/saigai/r9c/">地方整備局</a>
      <a href="https://www.mlit.go.jp/road/saigai/R9D/">大文字</a>
      <a href="https://www.mlit.go.jp/road/saigai/r9a/map/map.html">地図</a>
      <a href="https://www.mlit.go.jp/road/saigai/r9a/">重なり</a>`;
    expect(disasterSlugs(html)).toEqual(["r9a", "r9b"]);
  });

  test("災害が無ければ空。タイトルの無いページは作りが変わったとみなして例外", () => {
    expect(
      disasterSlugs(
        `<title>道路 - 国土交通省</title><a href="/road/index.html">x</a>`,
      ),
    ).toEqual([]);
    expect(() => disasterSlugs("<html>メンテナンス中</html>")).toThrow(
      "タイトル",
    );
  });

  test("地図のページから災害の名前と GeoJSON の URL を取る (熊本の写し)", () => {
    expect(
      readDisasterMap(fixture("roads/kumamoto-map.html"), "r8kumamoto"),
    ).toEqual({ name: "令和8年熊本地震", urls: [KUMAMOTO, ETC] });
  });

  test("形の違う URL は捨てる", () => {
    const html = `<title>道路：令和９年テスト豪雨　通れるマップ - 国土交通省</title><script>
      var a = './json/dourokisei.geojson';
      var b = './json/tukoujisseki.geojson';
      var c = './json/gsimap1.geojson';
      var d = 'https://example.com/road/saigai/x/map/json/dourokisei.geojson';
      var e = '../../r9z/map/json/dourokisei.geojson';
      var f = 'http://www.mlit.go.jp/road/saigai/r9x/map/json/dourokisei.geojson';
      var g = './json/ETC2.0_speed_data_2.geojson';
    </script>`;
    expect(readDisasterMap(html, "r9x")).toEqual({
      name: "令和9年テスト豪雨",
      urls: [
        "https://www.mlit.go.jp/road/saigai/r9x/map/json/dourokisei.geojson",
        "https://www.mlit.go.jp/road/saigai/r9x/map/json/ETC2.0_speed_data_2.geojson",
      ],
    });
    expect(DISCOVERED_GEOJSON.test(KUMAMOTO)).toBe(true);
    expect(
      DISCOVERED_GEOJSON.test(
        "https://www.mlit.go.jp/road/saigai/r8kumamoto/map/json/x/dourokisei.geojson",
      ),
    ).toBe(false);
    expect(readDisasterMap("<title></title>", "r9y")).toEqual({
      name: "r9y",
      urls: [],
    });
  });

  test("SONAE_ROAD_DISCOVER は既定でオン。off で切る", () => {
    expect(roadDiscoverOn(undefined)).toBe(true);
    expect(roadDiscoverOn("")).toBe(true);
    expect(roadDiscoverOn(" OFF ")).toBe(false);
  });
});

/** トップページと地図のページと GeoJSON を返す fetch。呼ばれた URL と付けた見出しを残す */
const site = (pages: Record<string, () => Response>) => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    return (pages[url] ?? (() => new Response("", { status: 404 })))();
  }) as unknown as typeof fetch;
  return { calls, doFetch };
};
const ok = (body: string, etag: string) => () =>
  new Response(body, { headers: { etag } });
const signal = () => new AbortController().signal;
const kumamotoSite = () =>
  site({
    [ROAD_LIST_URL]: ok(fixture("roads/road-index.html"), '"l1"'),
    [MAP]: ok(fixture("roads/kumamoto-map.html"), '"m1"'),
    [KUMAMOTO]: ok(fixture("roads/dourokisei.geojson"), '"g1"'),
    [ETC]: ok(fixture("roads/ETC2.0_speed_data.geojson"), '"g2"'),
  });

describe("見つけた URL を取る", () => {
  test("一覧から見つけた URL を取り、3 時間たつまで一覧を読み直さない", async () => {
    const db = openDb(":memory:");
    const { calls, doFetch } = kumamotoSite();
    let t = Date.parse("2026-11-21T01:00:00Z");
    const end = t + DISCOVER_INTERVAL_MS;
    const controller = new AbortController();
    const statuses: SourceStatus[] = [];
    const source = roadSource(db, [], {
      discover: true,
      log: () => {},
      fetch: doFetch,
      now: () => t,
      onStatus: (s) => statuses.push(s),
      sleep: async (ms) => {
        t += ms;
        if (t > end) controller.abort();
      },
    });
    await source?.run(controller.signal);
    const lists = calls.filter((c) => c.url === ROAD_LIST_URL);
    // 起動したときと、3 時間たったとき
    expect(lists).toHaveLength(2);
    expect(lists[0]?.headers["user-agent"]).toContain("sonae");
    expect(lists[1]?.headers["if-none-match"]).toBe('"l1"');
    expect(calls.filter((c) => c.url === MAP)).toHaveLength(2);
    // GeoJSON は 30 分ごと
    expect(calls.filter((c) => c.url === KUMAMOTO)).toHaveLength(7);
    expect(activeRoadUrls(db, [], true)).toEqual([KUMAMOTO, ETC]);
    expect(activeRoadUrls(db, [], false)).toEqual([]);
    expect(
      roadResponse(db, activeRoadUrls(db, [], true)).data.features,
    ).toHaveLength(7);
    expect(discovered(db)?.disasters.map((d) => d.name)).toEqual([
      "令和8年熊本地震",
    ]);
    const last = statuses.findLast((s) => s.roads)?.roads;
    expect(last).toMatchObject({
      discover: true,
      disasters: ["令和8年熊本地震"],
      manual: 0,
    });
    expect(last?.problem).toBeUndefined();
  });

  test("起動し直しても、前に一覧を読んでから 3 時間たつまで読まない", async () => {
    const db = openDb(":memory:");
    await discoverOnce(db, kumamotoSite().doFetch, signal(), () => 0);
    const { calls, doFetch } = kumamotoSite();
    const controller = new AbortController();
    const source = roadSource(db, [], {
      discover: true,
      log: () => {},
      fetch: doFetch,
      now: () => 60_000,
      sleep: async () => controller.abort(),
    });
    await source?.run(controller.signal);
    expect(calls.map((c) => c.url)).toEqual([KUMAMOTO, ETC]);
  });

  test("トップページが 304 なら地図のページは読まない。手で入れた URL と合わせる", async () => {
    const db = openDb(":memory:");
    const extra = "https://www.qsr.mlit.go.jp/x/dourokisei.geojson";
    await discoverOnce(db, kumamotoSite().doFetch, signal(), () => 0);
    const second = site({
      [ROAD_LIST_URL]: () => new Response(null, { status: 304 }),
    });
    const r = await discoverOnce(db, second.doFetch, signal(), () => 1000);
    expect(second.calls.map((c) => c.url)).toEqual([ROAD_LIST_URL]);
    expect(second.calls[0]?.headers["if-none-match"]).toBe('"l1"');
    expect(r.data.checkedAt).toBe(new Date(1000).toISOString());
    expect(r.data.disasters).toHaveLength(1);
    expect(activeRoadUrls(db, [extra, KUMAMOTO], true)).toEqual([
      extra,
      KUMAMOTO,
      ETC,
    ]);
  });

  test("一覧が読めないときは前に見つけたものを使い続け、「一覧が読めません」を出す", async () => {
    const db = openDb(":memory:");
    await discoverOnce(db, kumamotoSite().doFetch, signal(), () => 0);
    // 作りが変わったページ (タイトルが無い) が返る
    const { doFetch } = site({
      [ROAD_LIST_URL]: () => new Response("<html></html>"),
      [KUMAMOTO]: ok(fixture("roads/dourokisei.geojson"), '"g1"'),
      [ETC]: ok(fixture("roads/ETC2.0_speed_data.geojson"), '"g2"'),
    });
    const controller = new AbortController();
    const waits: number[] = [];
    let s = {} as SourceStatus;
    const source = roadSource(db, [], {
      discover: true,
      log: () => {},
      fetch: doFetch,
      now: () => DISCOVER_INTERVAL_MS + 1,
      sleep: async (ms) => {
        waits.push(ms);
        s = source?.status() as SourceStatus;
        controller.abort();
      },
    });
    await source?.run(controller.signal);
    expect(s.roads?.problem).toBe("一覧が読めません");
    expect(s.roads?.disasters).toEqual(["令和8年熊本地震"]);
    expect(s.lastError).toContain("タイトル");
    // 前に見つけた GeoJSON は取り続ける
    expect(
      roadResponse(db, activeRoadUrls(db, [], true)).data.features,
    ).toHaveLength(7);
    expect(s.state).toBe("connected");
    expect(sourceInTrouble(s)).toBe(true);
    expect(sourceStateText(s)).toBe(
      "一覧が読めません (最後に読めたのは 1/1 09:00)",
    );
    expect(waits).toEqual([5 * 60_000]);
  });

  test("地図のページに使える GeoJSON が無ければ、その災害を添えて出す", async () => {
    const db = openDb(":memory:");
    const r = await discoverOnce(
      db,
      site({
        [ROAD_LIST_URL]: ok(fixture("roads/road-index.html"), '"l1"'),
        [MAP]: ok(
          "<title>道路：令和８年熊本地震　通れるマップ - 国土交通省</title>",
          '"m1"',
        ),
      }).doFetch,
      signal(),
      () => 0,
    );
    expect(r.problems.map((p) => p.name)).toEqual(["r8kumamoto"]);
    expect(r.problems[0]?.error).toContain("GeoJSON が見当たりません");
    expect(r.data.disasters).toEqual([]);
    // 次も地図のページを読み直すよう、トップページの ETag を残さない
    expect(r.data.etag).toBeUndefined();
  });

  test("災害が無ければ何も取らず、受信中のまま", async () => {
    const db = openDb(":memory:");
    const { calls, doFetch } = site({
      [ROAD_LIST_URL]: ok(
        `<title>道路 - 国土交通省</title><a href="/road/index.html">x</a>`,
        '"l2"',
      ),
    });
    const controller = new AbortController();
    let s = {} as SourceStatus;
    const source = roadSource(db, [], {
      discover: true,
      log: () => {},
      fetch: doFetch,
      sleep: async () => {
        s = source?.status() as SourceStatus;
        controller.abort();
      },
    });
    await source?.run(controller.signal);
    expect(calls.map((c) => c.url)).toEqual([ROAD_LIST_URL]);
    expect(s.state).toBe("connected");
    expect(s.roads?.disasters).toEqual([]);
    expect(sourceStateText(s)).toMatch(/^災害の通行止めはありません \(/);
    expect(roadResponse(db, activeRoadUrls(db, [], true)).enabled).toBe(false);
  });

  test("一覧の行き先が go.jp の外へリダイレクトしたら辿らない", async () => {
    const db = openDb(":memory:");
    const { calls, doFetch } = site({
      [ROAD_LIST_URL]: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://example.com/road/index.html" },
        }),
    });
    await expect(discoverOnce(db, doFetch, signal(), () => 0)).rejects.toThrow(
      "リダイレクト先",
    );
    expect(calls).toHaveLength(1);
  });
});

describe("受信の状態の文", () => {
  const at = "2026-11-21T01:00:00Z";
  const text = (
    roads: SourceStatus["roads"],
    state: SourceStatus["state"] = "connected",
  ) => sourceStateText({ id: "roads", state, since: at, roads });

  test("災害が無いときと、あるとき", () => {
    expect(
      text({ discover: true, disasters: [], manual: 0, checkedAt: at }),
    ).toBe("災害の通行止めはありません (11/21 10:00 に確かめた)");
    expect(
      text({
        discover: true,
        disasters: ["令和8年熊本地震"],
        manual: 0,
        checkedAt: at,
      }),
    ).toBe("受信中・令和8年熊本地震 (1 件)・11/21 10:00 に一覧を確かめた");
    expect(
      text({
        discover: true,
        disasters: ["令和8年熊本地震", "令和8年8月千葉豪雨"],
        manual: 2,
        checkedAt: at,
      }),
    ).toBe(
      "受信中・令和8年熊本地震、令和8年8月千葉豪雨 (2 件)、登録した URL 2 件・11/21 10:00 に一覧を確かめた",
    );
    expect(
      text({ discover: true, disasters: [], manual: 1, checkedAt: at }),
    ).toBe(
      "受信中・登録した URL 1 件・一覧に災害はありません (11/21 10:00 に確かめた)",
    );
  });

  test("読めないとき・まだ読んでいないとき・自動の発見を切ったとき", () => {
    expect(
      text({
        discover: true,
        disasters: [],
        manual: 0,
        checkedAt: at,
        problem: "一覧が読めません",
      }),
    ).toBe("一覧が読めません (最後に読めたのは 11/21 10:00)");
    expect(
      text({ discover: true, disasters: [], manual: 0 }, "connecting"),
    ).toBe("一覧を確かめています");
    // 自動の発見を切っていれば、ほかの情報源と同じ
    expect(
      text({ discover: false, disasters: [], manual: 1 }, "connecting"),
    ).toBe("接続中");
    expect(
      sourceInTrouble({
        id: "roads",
        state: "connected",
        since: at,
        roads: { discover: true, disasters: [], manual: 0, checkedAt: at },
      }),
    ).toBe(false);
  });
});
