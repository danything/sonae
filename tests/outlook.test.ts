import { describe, expect, test } from "bun:test";

import { outlookDay } from "#lib/format.ts";
import {
  outlookFor,
  type SonaeEvent,
  type WarningOutlook,
} from "#lib/model.ts";
import { noticeOf } from "#lib/notify.ts";
import {
  parseWeatherXml,
  WEATHER_CODES,
  WEATHER_SNAPSHOT_CODES,
} from "#lib/server/sources/jma-weather.ts";
import { jmaWeatherSource } from "#lib/server/sources/jma.ts";

import { fixture, memoryStore, sourceContext } from "./helpers.ts";

/** 早期注意情報 (警報級の可能性。docs/design.md の 2.8) */
const ASATTE = "90_01_01_241031_VPFD61.xml"; // 香川県 明後日まで。大雨・土砂災害が「中」
const SAKI = "69_01_01_241031_VPFW60.xml"; // 香川県 明々後日以降。雨・風・波・潮位に「高」「中」

function outlook(file: string, code: string, url?: string): WarningOutlook {
  const [item] = parseWeatherXml(fixture(`jma/${file}`), code, url);
  if (item?.type !== "outlook") throw new Error("早期注意情報ではありません");
  return { ...item.outlook, updatedAt: "" };
}

describe("電文を読む", () => {
  test("取る種別。府県予報区ごとにいちばん新しい 1 通だけを取る", () => {
    for (const c of ["VPFD61", "VPFW60"]) {
      expect(WEATHER_CODES.has(c)).toBe(true);
      expect(WEATHER_SNAPSHOT_CODES.has(c)).toBe(true);
    }
    // 経過措置の警報級の可能性 (明日まで、令和 10 年度に廃止の予定) は取らない
    expect(WEATHER_CODES.has("VPFD60")).toBe(false);
  });

  test("明後日まで: 6 時間ごとの段を日ごとにまとめ、高・中だけを持つ", () => {
    const o = outlook(ASATTE, "VPFD61");
    expect(o.id).toBe("VPFD61-370000");
    expect(o.office).toEqual({ code: "370000", name: "香川県" });
    expect(o.areas).toEqual([
      {
        code: "370000",
        name: "香川県",
        kinds: [
          {
            name: "大雨",
            days: [
              { date: "2024-09-21", rank: "中" },
              { date: "2024-09-22", rank: "中" },
            ],
          },
          {
            name: "土砂災害",
            days: [
              { date: "2024-09-21", rank: "中" },
              { date: "2024-09-22", rank: "中" },
            ],
          },
        ],
      },
    ]);
  });

  test("明々後日以降: 日ごとの段。府県予報区のコードはフィードのファイル名から", () => {
    const o = outlook(
      SAKI,
      "VPFW60",
      "https://www.data.jma.go.jp/developer/xml/data/20241014020000_0_VPFW60_370000.xml",
    );
    expect(o.office.code).toBe("370000");
    const kinds = o.areas[0]?.kinds ?? [];
    expect(kinds.map((k) => k.name)).toEqual([
      "雨",
      "風（風雪）",
      "波",
      "潮位",
    ]);
    expect(kinds[0]?.days).toEqual([
      { date: "2024-10-16", rank: "高" },
      { date: "2024-10-18", rank: "高" },
      { date: "2024-10-19", rank: "中" },
    ]);
  });
});

describe("住んでいる地域の警報級の可能性", () => {
  test("明後日までと明々後日以降を日の順に並べ、同じ日・同じ現象は高いほう", () => {
    const a = outlook(ASATTE, "VPFD61");
    const b = outlook(SAKI, "VPFW60");
    const days = outlookFor([b, a], { office: "370000", ichiji: "370000" });
    expect(days.map((d) => d.date)).toEqual([
      "2024-09-21",
      "2024-09-22",
      "2024-10-16",
      "2024-10-17",
      "2024-10-18",
      "2024-10-19",
    ]);
    expect(days[0]?.kinds).toEqual([
      { name: "大雨", rank: "中" },
      { name: "土砂災害", rank: "中" },
    ]);
    // ほかの府県予報区は当たらない
    expect(outlookFor([a, b], { office: "130000", ichiji: "130010" })).toEqual(
      [],
    );
  });

  test("日の言い方: 今日・明日・明後日と、その先は月日と曜日 (日本時間)", () => {
    const now = Date.parse("2026-11-21T01:00:00+09:00");
    expect(outlookDay("2026-11-21", now)).toBe("今日");
    expect(outlookDay("2026-11-22", now)).toBe("明日");
    expect(outlookDay("2026-11-23", now)).toBe("明後日");
    expect(outlookDay("2026-11-24", now)).toBe("11/24 (火)");
  });
});

describe("保存と通知", () => {
  test("府県予報区と種別ごとに置き換え、前の報より古い報は捨てる", () => {
    const { store } = memoryStore("2024-09-21T00:00:00.000Z");
    const o = outlook(ASATTE, "VPFD61");
    const put = (x: WarningOutlook, key: string) =>
      store.ingest({
        source: "jma-weather",
        key,
        code: "VPFD61",
        items: [{ type: "outlook", outlook: x }],
      });
    expect(put(o, "a")).toHaveLength(1);
    const newer = { ...o, reportedAt: "2024-09-21T11:00:00+09:00", areas: [] };
    expect(put(newer, "b")).toHaveLength(1);
    expect(put(o, "c")).toEqual([]);
    expect(store.outlooks()).toEqual([
      { ...newer, updatedAt: expect.any(String) },
    ]);
  });

  test("知らせない (備えの情報)", () => {
    const o = outlook(ASATTE, "VPFD61");
    const e: SonaeEvent = { seq: 1, type: "outlook", data: o };
    expect(noticeOf(e, Date.parse(o.reportedAt) + 60_000)).toBeNull();
  });
});

describe("フィード", () => {
  test("定時のフィード (regular.xml) から、府県予報区ごとに新しい 1 通だけを取る", async () => {
    const { ctx, got } = sourceContext();
    const urls: string[] = [];
    const base = "https://example.invalid/data";
    const newer = `${base}/20241014020000_0_VPFW60_370000.xml`;
    const older = `${base}/20241013080000_0_VPFW60_370000.xml`;
    const feed = (entries: string[]) =>
      `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries
        .map(
          (u) =>
            `<entry><title>t</title><id>${u}</id><updated>2026-11-21T00:00:00Z</updated><link type="application/xml" href="${u}"/></entry>`,
        )
        .join("")}</feed>`;
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("regular.xml") || url.endsWith("regular_l.xml"))
        return new Response(feed([newer, older]));
      if (url.includes("/feed/")) return new Response(feed([]));
      if (url === newer) return new Response(fixture(`jma/${SAKI}`));
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const ac = new AbortController();
    await jmaWeatherSource(ctx, {
      fetch: fakeFetch,
      log: () => {},
      sleep: async () => {
        ac.abort();
      },
    }).run(ac.signal);
    expect(
      urls.filter((u) => u.includes("/feed/")).map((u) => u.split("/").pop()),
    ).toContain("regular.xml");
    expect(urls).not.toContain(older);
    const item = got[0]?.items[0];
    expect(item?.type === "outlook" && item.outlook.id).toBe("VPFW60-370000");
  });
});
