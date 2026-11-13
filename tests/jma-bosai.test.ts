import { expect, test } from "bun:test";

import { isPinnedAdvisory } from "#lib/model.ts";
import { noticeOf } from "#lib/notify.ts";
import {
  BOSAI_TSUNAMI_LIST,
  bosaiTsunamiAdvisory,
  bosaiTsunamiSource,
  bosaiTsunamiText,
  parseBosaiTsunamiList,
} from "#lib/server/sources/jma-bosai.ts";
import type { Incoming, SourceContext } from "#lib/server/sources/types.ts";

import { fixture, memoryStore } from "./helpers.ts";

const LIST = fixture("jma-bosai/list.json");
const FNAME = "20261025022014_0_WEPA40_RJTD.txt";
const TEXT = fixture(`jma-bosai/${FNAME}`);

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

test("一覧: 新しい順。形の違う項目は飛ばし、配列でなければ例外", () => {
  const list = parseBosaiTsunamiList(LIST);
  expect(list.length).toBeGreaterThanOrEqual(4);
  expect(list[0]).toEqual({
    time: "2026-10-25T02:20:00Z",
    fname: FNAME,
    lat: "+28.0",
    lon: "+139.9",
    depth: 473,
    mag: 7,
  });
  expect(
    parseBosaiTsunamiList('[{"fname":"../../etc/passwd","time":"x"}]'),
  ).toEqual([]);
  expect(() => parseBosaiTsunamiList('{"list":[]}')).toThrow();
  expect(() => parseBosaiTsunamiList("<html>")).toThrow();
});

test("新しい電報の本文を 1 回だけ取り、お知らせにする", async () => {
  const { ctx, got } = context();
  const urls: string[] = [];
  const waits: number[] = [];
  const controller = new AbortController();
  const source = bosaiTsunamiSource(ctx, {
    fetch: (async (url: string) => {
      urls.push(url);
      if (url === BOSAI_TSUNAMI_LIST) return new Response(LIST);
      if (url === bosaiTsunamiText(FNAME)) return new Response(TEXT);
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
    sleep: async (ms) => {
      waits.push(ms);
      if (waits.length >= 2) controller.abort();
    },
    log: () => {},
  });
  await source.run(controller.signal);
  // 1 回目: 一覧と本文 (取れたのは fixture の 1 つだけ)。2 回目: 一覧だけ (取れなかった本文は 30 分取り直さない)
  const texts = urls.filter((u) => u !== BOSAI_TSUNAMI_LIST);
  expect(urls.filter((u) => u === BOSAI_TSUNAMI_LIST)).toHaveLength(2);
  expect(new Set(texts).size).toBe(texts.length);
  expect(got).toHaveLength(1);
  const item = got[0]?.items[0];
  if (item?.type !== "advisory") throw new Error("お知らせではない");
  expect(item.advisory).toMatchObject({
    id: "WEPA40-20261025022014_0_WEPA40_RJTD",
    code: "WEPA40",
    source: "jma-bosai",
    title: "国際津波関連情報 (北西太平洋)",
    serialName: "TSUNAMI BULLETIN NUMBER 001",
    reportedAt: "2026-10-25T02:20:14.000Z",
    headline:
      "M7.0・深さ 473 km・北緯 28.0 東経 139.9。THERE IS NO POSSIBILITY OF A TSUNAMI",
    url: "https://www.jma.go.jp/bosai/pacifictsunami/data/wepa40/20261025022014_0_WEPA40_RJTD.txt",
  });
  expect(item.advisory.text).toContain("ISSUED BY NWPTAC(JMA)");
  expect(waits).toEqual([60_000, 60_000]);
  expect(source.status().state).toBe("stopped");
});

test("一覧の形が変わったら、その回を捨てて状態にエラーを出す (止まらない)", async () => {
  const { ctx, got } = context();
  const waits: number[] = [];
  const controller = new AbortController();
  const source = bosaiTsunamiSource(ctx, {
    fetch: (async () =>
      new Response('{"new":"shape"}')) as unknown as typeof fetch,
    sleep: async (ms) => {
      waits.push(ms);
      if (waits.length >= 2) controller.abort();
    },
    log: () => {},
  });
  await source.run(controller.signal);
  expect(got).toEqual([]);
  expect(source.status().lastError).toContain("配列");
  expect(waits).toEqual([60_000, 120_000]);
});

test("保存して、一覧の上には出さず、知らせない", () => {
  const { store } = memoryStore();
  const list = parseBosaiTsunamiList(LIST);
  const item = list[0];
  if (!item) throw new Error("無い");
  const [e] = store.ingest({
    source: "jma-bosai",
    key: FNAME,
    code: "WEPA40",
    items: [{ type: "advisory", advisory: bosaiTsunamiAdvisory(item, TEXT) }],
  });
  if (e?.type !== "advisory") throw new Error("お知らせではない");
  expect(isPinnedAdvisory(e.data)).toBe(false);
  expect(noticeOf(e, Date.parse(e.data.reportedAt) + 1000)).toBeNull();
});
