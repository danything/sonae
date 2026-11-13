import { expect, test } from "bun:test";

import { isPinnedAdvisory } from "#lib/model.ts";
import { noticeOf } from "#lib/notify.ts";
import { parsePtwc, PTWC_FEED, ptwcSource } from "#lib/server/sources/ptwc.ts";
import type { Incoming, SourceContext } from "#lib/server/sources/types.ts";

import { fixture, memoryStore } from "./helpers.ts";

const FEED = fixture("ptwc/PHEBAtom.xml");

test("PTWC の Atom: 電報 1 つを、お知らせ (英文の要約とリンク) にする", () => {
  const items = parsePtwc(FEED);
  expect(items).toHaveLength(1);
  const m = items[0];
  expect(m?.source).toBe("ptwc");
  expect(m?.key).toBe("urn:uuid:4e58fbfd-f504-4705-9b75-a82babbdde3c");
  const item = m?.items[0];
  if (item?.type !== "advisory") throw new Error("お知らせではない");
  const a = item.advisory;
  expect(a.code).toBe("PTWC");
  expect(a.source).toBe("ptwc");
  expect(a.id).toBe("PTWC-4e58fbfd-f504-4705-9b75-a82babbdde3c");
  expect(a.serialName).toBe("Information");
  expect(a.headline).toBe("TSUNAMI INFORMATION STATEMENT NUMBER 1");
  expect(a.reportedAt).toBe("2026-11-13T16:43:19.000Z");
  expect(a.text).toBe(
    [
      "地域: ABOUT 84 MILES NORTHWEST OF ISLA MONA",
      "規模 (速報): 4.9(Mwp)",
      "震央: 緯度 18.6・経度 -69.1",
    ].join("\n"),
  );
  expect(a.url).toBe(
    "https://www.tsunami.gov/events/PHEB/2026/11/13/26317050/1/WECA42/WECA42.txt",
  );
  expect(isPinnedAdvisory(a)).toBe(false);
});

test("Atom でなければ例外 (その回を捨てる)。電報が無ければ空。外のリンクは採らない", () => {
  expect(() => parsePtwc("<html></html>")).toThrow();
  expect(parsePtwc("<feed><title>x</title></feed>")).toEqual([]);
  const evil = FEED.replaceAll(
    "https://www.tsunami.gov/events/PHEB/2026/11/13/26317050/1/WECA42/WECA42.txt",
    "javascript:alert(1)",
  );
  const item = parsePtwc(evil)[0]?.items[0];
  if (item?.type !== "advisory") throw new Error("お知らせではない");
  expect(item.advisory.url).toBeUndefined();
});

test("リンクの http は https に直し、属性の順が違っても読む。文字参照も戻す", () => {
  const entry = (link: string, title: string) =>
    `<feed><title>T</title><entry><id>urn:uuid:x</id><updated>2026-11-13T16:43:19Z</updated><title>${title}</title>${link}</entry></feed>`;
  const read = (xml: string) => {
    const item = parsePtwc(xml)[0]?.items[0];
    if (item?.type !== "advisory") throw new Error("お知らせではない");
    return item.advisory;
  };
  expect(
    read(
      entry(
        '<link href="http://www.tsunami.gov/a.txt" rel="alternate"/>',
        "A &amp; B &#x41;&#66; <b>C</b>",
      ),
    ),
  ).toMatchObject({
    url: "https://www.tsunami.gov/a.txt",
    text: "地域: A & B AB C",
  });
  // 入れ子のタグや閉じていない山括弧も残さない
  expect(read(entry("", "<scr<b>ipt>x")).text).toBe("地域: x");
});

test("保存して、知らせない", () => {
  const { store } = memoryStore();
  const [m] = parsePtwc(FEED);
  if (!m) throw new Error("無い");
  const [e] = store.ingest(m);
  if (e?.type !== "advisory") throw new Error("お知らせではない");
  expect(store.advisory(e.data.id)?.code).toBe("PTWC");
  expect(noticeOf(e, Date.parse(e.data.reportedAt) + 1000)).toBeNull();
  // 同じ電報は取り直さない (鍵で除く)
  expect(store.ingest(m)).toEqual([]);
});

test("60 秒ごとに取り、同じ電報は 1 回だけ渡す", async () => {
  const got: Incoming[] = [];
  const keys = new Set<string>();
  const ctx: SourceContext = {
    emit: (m) => {
      got.push(m);
      keys.add(m.key);
    },
    seen: (_s, k) => keys.has(k),
  };
  const urls: string[] = [];
  const waits: number[] = [];
  const controller = new AbortController();
  const source = ptwcSource(ctx, {
    intervalMs: 5_000,
    fetch: (async (url: string) => {
      urls.push(url);
      return new Response(FEED);
    }) as typeof fetch,
    sleep: async (ms) => {
      waits.push(ms);
      if (waits.length >= 2) controller.abort();
    },
  });
  await source.run(controller.signal);
  expect(urls).toEqual([PTWC_FEED, PTWC_FEED]);
  expect(got).toHaveLength(1);
  expect(waits).toEqual([60_000, 60_000]);
});
