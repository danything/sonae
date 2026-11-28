import { describe, expect, test } from "bun:test";

import { XML } from "bun";

import type { SourceStatus } from "#lib/model.ts";
import { mergeTsunami } from "#lib/server/merge.ts";
import {
  BOSAI_TSUNAMI_LIST,
  BOSAI_VOLCANO_ERUPTION,
  BOSAI_VOLCANO_WARNING,
  bosaiEqvolSource,
  bosaiJsonToXml,
  bosaiTsunami,
  bosaiVolcanoWarning,
  parseBosaiTsunami,
  parseBosaiTsunamiList,
  parseBosaiVolcano,
  parseBosaiVolcanoList,
  tsunamiHeightText,
} from "#lib/server/sources/jma-bosai-eqvol.ts";
import { parseJmaXml } from "#lib/server/sources/jma-xml.ts";
import type { TsunamiReport } from "#lib/server/sources/types.ts";
import { readTsunami } from "#lib/server/store.ts";

import { fixture, memoryStore, sourceContext } from "./helpers.ts";

const TSUNAMI_NAME = "20261106195344_20261106193937_VTSE41_0.json";
const TSUNAMI_LIST = fixture("jma-bosai/tsunami-list.json");
const TSUNAMI = fixture(`jma-bosai/${TSUNAMI_NAME}`);
const VOLCANO_LIST = fixture("jma-bosai/volcano-warning.json");
const VOLCANO_508 = fixture("jma-bosai/volcano-warning-508.json");

const base: SourceStatus = {
  id: "jma",
  state: "connected",
  since: "2026-11-28T09:00:00.000Z",
  lastSeenAt: "2026-11-28T09:19:00.000Z",
};

describe("読み方", () => {
  test("津波の高さの文を、電文の description の形に作り直す", () => {
    expect(tsunamiHeightText("<0.2")).toBe("０．２ｍ未満");
    expect(tsunamiHeightText(">10")).toBe("１０ｍ超");
    expect(tsunamiHeightText("3")).toBe("３ｍ");
    expect(tsunamiHeightText("3.2")).toBe("３．２ｍ");
    expect(tsunamiHeightText("巨大")).toBe("巨大");
  });

  test("津波の一覧から、電文の本文の名前と種別と時刻を読む", () => {
    expect(parseBosaiTsunamiList(TSUNAMI_LIST)).toEqual([
      {
        name: TSUNAMI_NAME,
        code: "VTSE41",
        reportedAt: "2026-11-06T19:53:00+09:00",
      },
    ]);
    // 知らない種別・形の違う名前は採らない
    expect(
      parseBosaiTsunamiList(
        JSON.stringify([
          { json: "x_VTSE99_0.json", rdt: "2026-11-06T19:53:00+09:00" },
          { json: "../a.json", rdt: "2026-11-06T19:53:00+09:00" },
        ]),
      ),
    ).toEqual([]);
    expect(() => parseBosaiTsunamiList("{}")).toThrow();
  });

  test("津波の本文 (電文を JSON にした形) を、気象庁 XML と同じ津波の報に読む", () => {
    const [n] = parseBosaiTsunami(TSUNAMI, "VTSE41");
    if (n?.type !== "tsunami") throw new Error("津波ではありません");
    const r = n.report;
    expect(r.source).toBe("jma-bosai-eqvol");
    expect(r.code).toBe("VTSE41");
    expect(r.status).toBe("normal");
    expect(r.eventIds).toEqual(["20261106193937"]);
    expect(r.reportedAt).toBe("2026-11-06T19:53:00+09:00");
    expect(r.headline).toBe("津波予報（若干の海面変動）を発表しました。");
    expect(r.areas).toEqual([
      {
        code: "310",
        name: "千葉県九十九里・外房",
        grade: "forecast",
        kindName: "津波予報（若干の海面変動）",
        immediate: undefined,
        arrivalTime: undefined,
        condition: undefined,
        maxHeightText: "０．２ｍ未満",
      },
    ]);
  });

  test("津波情報 (到達予想・観測) も、電文と同じに読む (サンプル電文を bosai の形に直したもの)", () => {
    // bosai には 2026-11-28 に津波情報が無かったので、サンプル電文を bosai の形 (要素の名前がキー・属性は捨てる・
    // 津波の高さは値と条件を 1 つの文字に) に直して確かめる
    const xml = fixture("jma/32-39_11_10_250206_VTSE51.xml");
    const toBosai = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(toBosai);
      if (typeof v !== "object" || v === null) return v;
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) {
        if (k.startsWith("@")) continue;
        if (k === "jmx_eb:TsunamiHeight") {
          const h = (Array.isArray(x) ? x[0] : x) as Record<string, string>;
          out.TsunamiHeight =
            typeof h === "string" ? h : (h["#text"] ?? h["@description"]);
          continue;
        }
        const name = k.replace(/^jmx_eb:/, "");
        out[name] =
          typeof x === "object" && x !== null && !Array.isArray(x)
            ? "#text" in (x as object) &&
              Object.keys(x as object).every(
                (kk) => kk.startsWith("@") || kk === "#text",
              )
              ? (x as Record<string, unknown>)["#text"]
              : toBosai(x)
            : toBosai(x);
      }
      return out;
    };
    const tree = XML.parse(xml) as { Report: Record<string, unknown> };
    const bosai = JSON.stringify(toBosai(tree.Report));
    const [fromBosai] = parseBosaiTsunami(bosai, "VTSE51");
    const [fromXml] = parseJmaXml(xml, "VTSE51");
    if (fromBosai?.type !== "tsunami" || fromXml?.type !== "tsunami")
      throw new Error("津波ではありません");
    const pick = (r: TsunamiReport) => ({
      eventIds: r.eventIds,
      reportedAt: r.reportedAt,
      headline: r.headline,
      areas: r.areas?.map((a) => [a.name, a.grade, a.arrivalTime, a.condition]),
      observations: r.observations.map((o) => [
        o.station,
        o.arrivalTime,
        o.initial,
        o.condition,
      ]),
    });
    expect(pick(fromBosai.report)).toEqual(pick(fromXml.report));
    expect(fromBosai.report.observations.length).toBeGreaterThan(0);
    // 観測の高さも、電文の description と同じ形の文になる
    const kamaishi = fromBosai.report.observations.find(
      (o) => o.station === "釜石",
    );
    expect(kamaishi?.maxHeightText).toBe("３．２ｍ");
  });

  test("JSON を XML に戻すとき、字を逃がし、英語の名前と null を捨てる", () => {
    expect(
      bosaiJsonToXml({ Name: "<a&b>", enName: "x", Serial: null }, "Area"),
    ).toBe("<Area><Name>&lt;a&amp;b&gt;</Name></Area>");
    expect(bosaiJsonToXml({ "bad key": "x" }, "A")).toBe("<A></A>");
  });

  test("噴火警報・予報の本文を、気象庁 XML の VFVO50 と同じ火山の報に読む", () => {
    const [n] = parseBosaiVolcano(VOLCANO_508, "VFVO50");
    if (n?.type !== "volcano") throw new Error("火山ではありません");
    const v = n.volcano;
    expect(v.source).toBe("jma-bosai");
    expect(v.id).toBe("VFVO50-508-20210308140000");
    expect(v.eventId).toBe("508");
    expect(v.title).toBe("薩摩硫黄島 噴火警報（火口周辺）");
    expect(v.headline.startsWith("＜薩摩硫黄島の火口周辺警報")).toBe(true);
    expect(v.volcanoes).toEqual([
      {
        code: "508",
        name: "薩摩硫黄島",
        kind: "レベル２（火口周辺規制）",
        kindCode: "12",
        condition: "継続",
        lastKind: undefined,
        level: 2,
      },
    ]);
    expect(v.warning).toEqual({
      name: "火口周辺警報",
      code: "02",
      condition: "切替",
    });
    expect(v.cities).toEqual(["鹿児島県三島村"]);
    expect(v.cityCodes).toEqual(["4630300"]);
    expect(v.prevention).toContain("大きな噴石に警戒してください");
    expect(() => parseBosaiVolcano("{}", "VFVO50")).toThrow();
  });

  test("サンプル電文と同じ中身なら、bosai から読んだ火山の報は id・題・見出しが電文と同じ (置き換えても通知が鳴り直さない)", () => {
    // VFVO50 のサンプル電文を、bosai の本文の形に直す
    const xml = fixture("jma/45_01_01_200522_VFVO50.xml");
    const [fromXml] = parseJmaXml(xml, "VFVO50");
    if (fromXml?.type !== "volcano") throw new Error("火山ではありません");
    const x = fromXml.volcano;
    const bosai = JSON.stringify({
      controlTitle: "噴火警報・予報",
      headTitle: `火山名  ${x.volcanoes[0]?.name}  噴火警報（火口周辺）`,
      reportDatetime: x.reportedAt,
      eventId: x.eventId,
      infoType: x.infoType,
      volcanoInfos: [
        {
          type: "噴火警報・予報（対象火山）",
          items: x.volcanoes.map((a) => ({
            name: a.kind,
            code: a.kindCode,
            condition: a.condition,
            areas: [{ name: a.name, code: a.code }],
          })),
        },
        {
          type: "噴火警報・予報（対象市町村等）",
          items: [
            {
              name: x.warning?.name,
              code: x.warning?.code,
              condition: x.warning?.condition,
              areas: x.cities.map((name, i) => ({
                name,
                code: x.cityCodes?.[i],
              })),
            },
          ],
        },
      ],
      volcanoHeadline: x.headline,
    });
    const [fromBosai] = parseBosaiVolcano(bosai, "VFVO50");
    if (fromBosai?.type !== "volcano") throw new Error("火山ではありません");
    const b = fromBosai.volcano;
    expect(b.id).toBe(x.id);
    expect(b.title).toBe(x.title);
    expect(b.headline).toBe(x.headline);
    expect(b.cities).toEqual(x.cities);
    expect(b.volcanoes.map((a) => [a.code, a.level])).toEqual(
      x.volcanoes.map((a) => [a.code, a.level]),
    );
  });

  test("火山の一覧から、識別番号と発表の時刻を読む", () => {
    expect(parseBosaiVolcanoList(VOLCANO_LIST)).toEqual([
      { eventId: "329", reportedAt: "2007-12-01T10:01:00+09:00" },
      { eventId: "508", reportedAt: "2021-03-08T14:00:00+09:00" },
    ]);
    expect(parseBosaiVolcanoList("[]")).toEqual([]);
    expect(
      parseBosaiVolcanoList(
        JSON.stringify([{ eventId: "../x", reportDatetime: "2026-11-28" }]),
      ),
    ).toEqual([]);
  });
});

describe("合わせ方", () => {
  test("bosai の津波の報は気象庁 XML と同じ重みで、P2P のつなぎを置き換える", () => {
    const [n] = parseBosaiTsunami(TSUNAMI, "VTSE41");
    if (n?.type !== "tsunami") throw new Error("津波ではありません");
    const p2p: TsunamiReport = {
      ...n.report,
      source: "p2p",
      code: "P2P552",
      reportedAt: "2026-11-06T19:52:00+09:00",
    };
    const now = "2026-11-06T10:55:00.000Z";
    const first = mergeTsunami(undefined, p2p, "t1", now);
    if (!first) throw new Error("採られていません");
    expect(first.provisional).toBe(true);
    const next = mergeTsunami(first, n.report, "t1", now);
    expect(next?.provisional).toBe(false);
    expect(next?.sources).toEqual(["p2p", "jma-bosai-eqvol"]);
    expect(next?.areasSource).toBe("jma-bosai-eqvol");
    // bosai の後の P2P は捨てる
    expect(mergeTsunami(next ?? undefined, p2p, "t1", now)).toBeNull();
  });
});

describe("主の源が取れない間だけ取る", () => {
  /** 主が落ちている。fetch を差し替えて、1 回まわす */
  async function once(
    reply: (url: string, headers: Record<string, string>) => Response,
    primary: SourceStatus = {
      ...base,
      state: "retrying",
      lastSeenAt: "2026-11-05T00:00:00.000Z",
    },
  ) {
    const { ctx, got } = sourceContext();
    const urls: string[] = [];
    let after: SourceStatus | undefined;
    const controller = new AbortController();
    const source = bosaiEqvolSource(ctx, {
      primary: () => primary,
      now: () => Date.parse("2026-11-28T09:20:00Z"),
      fetch: (async (url: string, init: RequestInit) => {
        urls.push(url);
        return reply(url, init.headers as Record<string, string>);
      }) as unknown as typeof fetch,
      sleep: async () => {
        // 1 回まわした後の状態を控えてから止める (止めると stopped になる)
        after ??= source.status();
        controller.abort();
      },
      log: () => {},
    });
    await source.run(controller.signal);
    return { got, urls, status: after ?? source.status() };
  }

  test("主が取れている間は何も取らず、待機中", async () => {
    const r = await once(() => new Response("[]"), base);
    expect(r.urls).toEqual([]);
    expect(r.status.state).toBe("standby");
    expect(r.status.reason).toContain("地震火山");
  });

  test("主が取れない間は、津波・噴火速報・噴火警報の一覧を取り、新しい報の本文を 1 回ずつ取る", async () => {
    const r = await once((url) => {
      if (url === BOSAI_TSUNAMI_LIST) return new Response(TSUNAMI_LIST);
      if (url === bosaiTsunami(TSUNAMI_NAME)) return new Response(TSUNAMI);
      if (url === BOSAI_VOLCANO_ERUPTION) return new Response("[]");
      if (url === BOSAI_VOLCANO_WARNING) return new Response(VOLCANO_LIST);
      if (url === bosaiVolcanoWarning("508")) return new Response(VOLCANO_508);
      return new Response("not found", { status: 404 });
    });
    // 主が最後に取れた時刻 (11/5) の 10 分前より前の報 (2007 年・2021 年の噴火警報) は取らない
    expect(r.urls).toEqual([
      BOSAI_TSUNAMI_LIST,
      bosaiTsunami(TSUNAMI_NAME),
      BOSAI_VOLCANO_ERUPTION,
      BOSAI_VOLCANO_WARNING,
    ]);
    expect(r.got.map((m) => [m.source, m.code])).toEqual([
      ["jma-bosai-eqvol", "VTSE41"],
    ]);
    expect(r.status.state).toBe("connected");
  });

  test("主が一度も取れていなければ 1 日前までの報を取る。本文が読めなければ原文を残す", async () => {
    const r = await once(
      (url) => {
        if (url === BOSAI_VOLCANO_WARNING)
          return new Response(
            JSON.stringify([
              { eventId: "508", reportDatetime: "2026-11-28T17:00:00+09:00" },
            ]),
          );
        if (url === bosaiVolcanoWarning("508"))
          return new Response('{"reportDatetime":"2026-11-28T17:00:00+09:00"}');
        return new Response("[]");
      },
      { ...base, state: "retrying", lastSeenAt: undefined },
    );
    expect(r.got).toHaveLength(1);
    expect(r.got[0]?.code).toBe("VFVO50");
    expect(r.got[0]?.error).toContain("対象の火山");
  });

  test("一覧が 5xx・時間切れでも、ほかの一覧は取り、状態を再接続中にする", async () => {
    const r = await once((url) => {
      if (url === BOSAI_TSUNAMI_LIST)
        return new Response("busy", { status: 503 });
      if (url === BOSAI_VOLCANO_ERUPTION)
        throw new DOMException("timed out", "TimeoutError");
      return new Response("[]");
    });
    expect(r.urls).toContain(BOSAI_VOLCANO_WARNING);
    expect(r.status.state).toBe("retrying");
    expect(r.status.lastError).toContain("503");
  });

  test("一覧は ETag と Last-Modified を付けて取り直す (変わっていなければ 304)", async () => {
    const { ctx } = sourceContext();
    const seen: Record<string, string>[] = [];
    let rounds = 0;
    const controller = new AbortController();
    const source = bosaiEqvolSource(ctx, {
      primary: () => ({
        ...base,
        state: "retrying",
        lastSeenAt: "2026-11-05T00:00:00.000Z",
      }),
      now: () => Date.parse("2026-11-28T09:20:00Z"),
      fetch: (async (url: string, init: RequestInit) => {
        if (url !== BOSAI_TSUNAMI_LIST) return new Response("[]");
        const h = init.headers as Record<string, string>;
        seen.push(h);
        return h["if-none-match"]
          ? new Response(null, { status: 304 })
          : new Response("[]", {
              headers: {
                etag: '"t1"',
                "last-modified": "Sun, 08 Nov 2026 21:03:37 GMT",
              },
            });
      }) as unknown as typeof fetch,
      sleep: async () => {
        if (++rounds >= 2) controller.abort();
      },
      log: () => {},
    });
    await source.run(controller.signal);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.["if-none-match"]).toBe('"t1"');
    expect(seen[1]?.["if-modified-since"]).toBe(
      "Sun, 08 Nov 2026 21:03:37 GMT",
    );
  });
});

describe("気象庁 XML との重なり (store)", () => {
  test("bosai から受けた火山の報は、同じ報の気象庁 XML が届いたら置き換わり、予備の印が消える", () => {
    const { store } = memoryStore();
    const items = parseBosaiVolcano(VOLCANO_508, "VFVO50");
    const [n] = items;
    if (n?.type !== "volcano") throw new Error("火山ではありません");
    store.ingest({
      source: "jma-bosai-eqvol",
      key: "VFVO50:508:2021-03-08T14:00:00+09:00",
      code: "VFVO50",
      body: VOLCANO_508,
      items,
    });
    expect(store.volcano(n.volcano.id)?.source).toBe("jma-bosai");
    const { source: _, ...xml } = n.volcano;
    store.ingest({
      source: "jma",
      key: "urn:x",
      code: "VFVO50",
      body: "<Report/>",
      items: [{ type: "volcano", volcano: xml }],
    });
    expect(store.volcano(n.volcano.id)?.source).toBeUndefined();
    expect(store.volcanoes()).toHaveLength(1);
  });
});

test("津波の高さが文字でなければ (形が変わったら)、黙って消さずに読めないとする", () => {
  const d = JSON.parse(TSUNAMI) as {
    Body: { Tsunami: { Forecast: { Item: { MaxHeight: unknown }[] } } };
  };
  const item = d.Body.Tsunami.Forecast.Item[0];
  if (item) item.MaxHeight = { TsunamiHeight: { value: "1" } };
  expect(() => parseBosaiTsunami(JSON.stringify(d), "VTSE41")).toThrow(
    "津波の高さ",
  );
});

test("火山の一覧は古い順に並べる", () => {
  const items = parseBosaiVolcanoList(
    JSON.stringify([
      { eventId: "2", reportDatetime: "2026-11-28T10:00:00+09:00" },
      { eventId: "1", reportDatetime: "2026-11-28T09:00:00+09:00" },
    ]),
  );
  expect(items.map((i) => i.eventId)).toEqual(["1", "2"]);
});

describe("読めない・取れないときは、黙って落とさず受信の状態に出す", () => {
  /** 主が一度も取れていない (1 日前までの報を取る) 形で、`rounds` 回まわす */
  async function run(reply: (url: string, n: number) => Response, rounds = 1) {
    const { ctx, got } = sourceContext();
    const urls: string[] = [];
    const states: SourceStatus[] = [];
    let n = 0;
    const controller = new AbortController();
    const source = bosaiEqvolSource(ctx, {
      primary: () => ({ ...base, state: "retrying", lastSeenAt: undefined }),
      now: () => Date.parse("2026-11-28T09:20:00Z"),
      fetch: (async (url: string) => {
        urls.push(url);
        return reply(url, n);
      }) as unknown as typeof fetch,
      sleep: async () => {
        states.push(source.status());
        if (++n >= rounds) controller.abort();
      },
      log: () => {},
    });
    await source.run(controller.signal);
    return { got, urls, states };
  }
  const LIST = JSON.stringify([
    { eventId: "508", reportDatetime: "2026-11-28T17:00:00+09:00" },
  ]);

  test("本文を読めなければ、原文を残し、一覧に載っている間は状態を再接続中にして訳を出す", async () => {
    const r = await run((url) => {
      if (url === BOSAI_VOLCANO_WARNING) return new Response(LIST);
      if (url === bosaiVolcanoWarning("508"))
        return new Response('{"reportDatetime":"2026-11-28T17:00:00+09:00"}');
      return new Response("[]");
    }, 2);
    expect(r.got).toHaveLength(1);
    for (const s of r.states) {
      expect(s.state).toBe("retrying");
      expect(s.lastError).toContain("読めませんでした");
    }
  });

  test("火山の一覧の項目の形が違えば、黙って捨てずに状態に出す", async () => {
    const r = await run((url) =>
      url === BOSAI_VOLCANO_ERUPTION
        ? new Response(JSON.stringify([{ id: "x", rdt: "2026-11-28" }]))
        : new Response("[]"),
    );
    expect(r.states[0]?.state).toBe("retrying");
    expect(r.states[0]?.lastError).toContain("1 項目を読めませんでした");
  });

  test("本文が 404 でもすぐには諦めず、5 回目で諦めて状態に出す", async () => {
    const r = await run((url) => {
      if (url === BOSAI_VOLCANO_WARNING) return new Response(LIST);
      if (url === bosaiVolcanoWarning("508"))
        return new Response("not found", { status: 404 });
      return new Response("[]");
    }, 7);
    expect(r.urls.filter((u) => u === bosaiVolcanoWarning("508"))).toHaveLength(
      5,
    );
    expect(r.states[3]?.state).toBe("connected");
    expect(r.states[4]?.state).toBe("retrying");
    expect(r.states[6]?.lastError).toContain("本文を取れません");
  });

  test("火山の本文が一覧より古ければ (前の報が残っていれば)、渡さずに次の回に取り直す", async () => {
    const r = await run((url, n) => {
      if (url === BOSAI_VOLCANO_WARNING) return new Response(LIST);
      if (url === bosaiVolcanoWarning("508"))
        return new Response(
          n === 0
            ? VOLCANO_508
            : VOLCANO_508.replaceAll(
                "2021-03-08T14:00:00+09:00",
                "2026-11-28T17:00:00+09:00",
              ),
        );
      return new Response("[]");
    }, 2);
    expect(r.urls.filter((u) => u === bosaiVolcanoWarning("508"))).toHaveLength(
      2,
    );
    expect(r.got).toHaveLength(1);
    expect(r.got[0]?.error).toBeUndefined();
  });
});

test("捨てた一覧の項目の訳は、次の回が 304 でも消さない", async () => {
  const { ctx } = sourceContext();
  const states: SourceStatus[] = [];
  let n = 0;
  const controller = new AbortController();
  const source = bosaiEqvolSource(ctx, {
    primary: () => ({ ...base, state: "retrying", lastSeenAt: undefined }),
    now: () => Date.parse("2026-11-28T09:20:00Z"),
    fetch: (async (url: string, init: RequestInit) => {
      if (url !== BOSAI_VOLCANO_ERUPTION) return new Response("[]");
      const h = init.headers as Record<string, string>;
      return h["if-none-match"]
        ? new Response(null, { status: 304 })
        : new Response(JSON.stringify([{ id: "x" }]), {
            headers: { etag: '"e1"' },
          });
    }) as unknown as typeof fetch,
    sleep: async () => {
      states.push(source.status());
      if (++n >= 3) controller.abort();
    },
    log: () => {},
  });
  await source.run(controller.signal);
  for (const s of states) {
    expect(s.state).toBe("retrying");
    expect(s.lastError).toContain("1 項目を読めませんでした");
  }
});

test("火山の本文が一覧より古いまま続けば、取り直しながら状態に出す", async () => {
  const { ctx, got } = sourceContext();
  const states: SourceStatus[] = [];
  let n = 0;
  const controller = new AbortController();
  const source = bosaiEqvolSource(ctx, {
    primary: () => ({ ...base, state: "retrying", lastSeenAt: undefined }),
    now: () => Date.parse("2026-11-28T09:20:00Z"),
    fetch: (async (url: string) => {
      if (url === BOSAI_VOLCANO_WARNING)
        return new Response(
          JSON.stringify([
            { eventId: "508", reportDatetime: "2026-11-28T17:00:00+09:00" },
          ]),
        );
      if (url === bosaiVolcanoWarning("508")) return new Response(VOLCANO_508);
      return new Response("[]");
    }) as unknown as typeof fetch,
    sleep: async () => {
      states.push(source.status());
      if (++n >= 6) controller.abort();
    },
    log: () => {},
  });
  await source.run(controller.signal);
  expect(got).toHaveLength(0);
  expect(states[3]?.state).toBe("connected");
  expect(states[4]?.state).toBe("retrying");
  expect(states[5]?.lastError).toContain("古いままです");
});

test("1 つの一覧が続けて取れなくても、ほかの一覧は 1 分ごとに取り、取れない一覧だけ間を空ける", async () => {
  const { ctx } = sourceContext();
  let t = Date.parse("2026-11-28T09:20:00Z");
  const asked = new Map<string, number>();
  let last = "";
  let rounds = 0;
  const controller = new AbortController();
  const source = bosaiEqvolSource(ctx, {
    primary: () => ({ ...base, state: "retrying", lastSeenAt: undefined }),
    now: () => t,
    fetch: (async (url: string) => {
      asked.set(url, (asked.get(url) ?? 0) + 1);
      return url === BOSAI_VOLCANO_ERUPTION
        ? new Response("not found", { status: 404 })
        : new Response("[]");
    }) as unknown as typeof fetch,
    sleep: async (ms) => {
      expect(ms).toBe(60_000);
      t += ms;
      last = source.status().state;
      if (++rounds >= 8) controller.abort();
    },
    log: () => {},
  });
  await source.run(controller.signal);
  expect(asked.get(BOSAI_TSUNAMI_LIST)).toBe(8);
  expect(asked.get(BOSAI_VOLCANO_WARNING)).toBe(8);
  // 0・1・3・7 分目 (間は 1・2・4 分)
  expect(asked.get(BOSAI_VOLCANO_ERUPTION)).toBe(4);
  expect(last).toBe("retrying");
});

test("前の報を気象庁 XML で受けていても、いまの予報区を予備から受けたら、そう分かる (詳しい内容の注記)", () => {
  const [n] = parseBosaiTsunami(TSUNAMI, "VTSE41");
  if (n?.type !== "tsunami") throw new Error("津波ではありません");
  const now = "2026-11-06T10:55:00.000Z";
  const xml: TsunamiReport = {
    ...n.report,
    source: "jma",
    reportedAt: "2026-11-06T19:50:00+09:00",
  };
  const first = mergeTsunami(undefined, xml, "t1", now);
  expect(first?.areasSource).toBe("jma");
  const next = mergeTsunami(first ?? undefined, n.report, "t1", now);
  expect(next?.sources).toEqual(["jma", "jma-bosai-eqvol"]);
  expect(next?.areasSource).toBe("jma-bosai-eqvol");
  // 同じ報を気象庁 XML で受け直したら、XML に戻る
  const back = mergeTsunami(
    next ?? undefined,
    { ...n.report, source: "jma" },
    "t1",
    now,
  );
  expect(back?.areasSource).toBe("jma");
});

test("気象庁 XML で受けた同じ報を予備で受け直しても採らない (予備の注記を出さない)", () => {
  const [n] = parseBosaiTsunami(TSUNAMI, "VTSE41");
  if (n?.type !== "tsunami") throw new Error("津波ではありません");
  const now = "2026-11-06T10:55:00.000Z";
  const xml = mergeTsunami(
    undefined,
    { ...n.report, source: "jma" },
    "t1",
    now,
  );
  expect(xml?.areasSource).toBe("jma");
  expect(mergeTsunami(xml ?? undefined, n.report, "t1", now)).toBeNull();
});

test("津波の高さが数でも言葉 (巨大・高い) でもなければ、説明を作らず条件に落とす", () => {
  expect(tsunamiHeightText("<0.2")).toBe("０．２ｍ未満");
  expect(tsunamiHeightText("巨大")).toBe("巨大");
  expect(tsunamiHeightText("NaN")).toBe("");
  expect(tsunamiHeightText("")).toBe("");
  const d = JSON.parse(TSUNAMI) as {
    Body: {
      Tsunami: { Forecast: { Item: { MaxHeight: Record<string, unknown> }[] } };
    };
  };
  const item = d.Body.Tsunami.Forecast.Item[0];
  if (!item) throw new Error("無い");
  item.MaxHeight = { TsunamiHeight: "NaN", Condition: "高い" };
  const [m] = parseBosaiTsunami(JSON.stringify(d), "VTSE41");
  if (m?.type !== "tsunami") throw new Error("津波ではありません");
  const first = m.report.areas?.[0];
  expect(first?.maxHeightText).toBe("高い");
});

test("前のデータの津波の源 jma-bosai は、読むときに jma-bosai-eqvol に読み替える", () => {
  const t = readTsunami(
    JSON.stringify({ sources: ["jma", "jma-bosai"], areasSource: "jma-bosai" }),
  );
  expect(t.sources).toEqual(["jma", "jma-bosai-eqvol"]);
  expect(t.areasSource).toBe("jma-bosai-eqvol");
});
