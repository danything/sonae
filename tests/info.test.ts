import { describe, expect, test } from "bun:test";

import { type Advisory, isPinnedAdvisory } from "#lib/model.ts";
import { noticeOf } from "#lib/notify.ts";
import { parseJmaXml, WANTED_CODES } from "#lib/server/sources/jma-xml.ts";
import type { Incoming } from "#lib/server/sources/types.ts";
import { readView, selectHref } from "#lib/view.ts";

import { codeOf, fixture, memoryStore } from "./helpers.ts";

const ACTIVITY = "32-35_09_01_191111_VXSE56.xml"; // 伊豆東部の地震活動の見通しに関する情報
const COUNT = "32-35_03_01_100514_VXSE60.xml"; // 地震回数に関する情報 (伊豆半島東方沖)
const COUNT_CANCEL = "32-35_10_02_220510_VXSE60.xml"; // 地震回数に関する情報の取消

function advisory(file: string) {
  const items = parseJmaXml(fixture(`jma/${file}`), codeOf(file));
  expect(items).toHaveLength(1);
  const item = items[0];
  if (item?.type !== "advisory") throw new Error("お知らせではありません");
  return item.advisory;
}
const incoming = (file: string): Incoming => {
  const body = fixture(`jma/${file}`);
  return {
    source: "jma",
    key: file,
    code: codeOf(file),
    body,
    items: parseJmaXml(body, codeOf(file)),
  };
};

describe("地震の活動状況・地震回数 (VXSE56・60)", () => {
  test("取る種別に入っている", () => {
    expect(WANTED_CODES.has("VXSE56")).toBe(true);
    expect(WANTED_CODES.has("VXSE60")).toBe(true);
  });

  test("VXSE56: 見出しと本文", () => {
    const a = advisory(ACTIVITY);
    expect(a.code).toBe("VXSE56");
    expect(a.id).toBe("VXSE56-20191111170000");
    expect(a.title).toBe("地震の活動状況等に関する情報");
    expect(a.headline).toBe(
      "伊豆東部の地震活動の見通しに関する情報を発表します。",
    );
    expect(a.text).toContain(
      "伊豆東部の地震活動の見通しに関する情報（第１号）",
    );
    expect(a.counts).toBeUndefined();
  });

  test("VXSE60: 期間ごとの回数・付加文・次の発表", () => {
    const a = advisory(COUNT);
    expect(a.code).toBe("VXSE60");
    expect(a.counts).toHaveLength(5);
    expect(a.counts?.[0]).toEqual({
      type: "地震回数",
      start: "2008-08-24T15:00:00+09:00",
      end: "2008-08-25T09:00:00+09:00",
      number: 1587,
      felt: 1,
    });
    expect(a.counts?.at(-1)?.type).toBe("累積地震回数");
    expect(a.text).toContain("伊豆半島東方沖");
    expect(a.next).toContain("２６日１８時００分頃");
  });

  test("取消は同じ一連の情報に印を付ける", () => {
    const { store } = memoryStore();
    store.ingest(incoming(COUNT));
    // 取消の電文は別の地震の番号 (サンプルどうしは別の事象) なので、取消だけの行になる
    const [e] = store.ingest(incoming(COUNT_CANCEL));
    if (e?.type !== "advisory") throw new Error("お知らせではありません");
    expect(e.data.cancelled).toBe(true);
    expect(store.advisories()).toHaveLength(2);
  });

  test("一覧の上には出さず、知らせない", () => {
    const a: Advisory = {
      ...advisory(COUNT),
      cancelled: false,
      updatedAt: "2008-08-26T03:00:00Z",
    };
    expect(isPinnedAdvisory(a)).toBe(false);
    expect(isPinnedAdvisory({ code: "VYSE50" })).toBe(true);
    expect(
      noticeOf(
        { seq: 1, type: "advisory", data: a },
        Date.parse(a.reportedAt) + 60_000,
      ),
    ).toBeNull();
  });
});

test("お知らせを選ぶ URL は k=info と i=<id>", () => {
  const href = selectHref(new URLSearchParams(), "info", "VXSE56-1");
  expect(href).toBe("/?k=info&i=VXSE56-1");
  expect(readView(new URLSearchParams(href.slice(2)))).toMatchObject({
    kind: "info",
    selected: { kind: "info", id: "VXSE56-1" },
  });
});
