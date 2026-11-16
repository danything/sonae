import { describe, expect, test } from "bun:test";

import type {
  Eew,
  LongPeriod,
  Quake,
  SonaeEvent,
  Tsunami,
} from "#lib/model.ts";
import { noticeOf } from "#lib/notify.ts";
import { parseJmaXml } from "#lib/server/sources/jma-xml.ts";
import { parseP2p } from "#lib/server/sources/p2p-json.ts";
import type { Incoming } from "#lib/server/sources/types.ts";
import {
  parseWolfx,
  parseWolfxEqlist,
} from "#lib/server/sources/wolfx-json.ts";

import { fixture, jmaIncoming as jma, json, memoryStore } from "./helpers.ts";

const p2p = (value: Record<string, unknown>, id: string): Incoming => ({
  source: "p2p",
  key: id,
  code: String(value.code),
  body: JSON.stringify(value),
  items: parseP2p(value),
});
/** 岩手・宮城内陸地震の P2P の 551 (仕様書の例を、気象庁のサンプル電文の地震に書き換えたもの) */
const p2pIwate = () => {
  const v = json("p2p/spec-551.json");
  v.issue = {
    source: "気象庁",
    time: "2008/06/14 08:50:00",
    type: "ScaleAndDestination",
    correct: "None",
  };
  v.earthquake = {
    ...(v.earthquake as object),
    time: "2008/06/14 08:43:00",
    hypocenter: {
      name: "岩手県内陸南部",
      latitude: 39.1,
      longitude: 140.9,
      depth: 10,
      magnitude: 6.9,
    },
    maxScale: 60,
  };
  return p2p(v, "p2p-q");
};
const wolfx = (value: Record<string, unknown>): Incoming => {
  const m = parseWolfx(value);
  if (m.type !== "eew") throw new Error("eew ではない");
  return {
    source: "wolfx",
    key: m.key,
    code: "jma_eew",
    items: [{ type: "eew", report: m.report }],
  };
};

/** 返ってきたイベントの中身。無ければ落とす */
function dataOf<T>(e: SonaeEvent | undefined): T {
  if (!e) throw new Error("イベントが返っていません");
  return e.data as T;
}

describe("緊急地震速報の新旧の判定", () => {
  const forecast = json("wolfx/made-forecast.json");
  const warning = json("wolfx/made-warning.json");
  const p2pWarning: Record<string, unknown> = {
    ...json("p2p/spec-556.json"),
    id: "p2p-1",
  };

  test("報数が大きいものだけを採り、同じ報数は情報源を足す", () => {
    const { store } = memoryStore();
    expect(store.ingest(wolfx(forecast))).toHaveLength(1);
    const [w] = store.ingest(wolfx(warning));
    expect(dataOf<Eew>(w).kind).toBe("warning");
    expect(dataOf<Eew>(w).serial).toBe(2);

    // P2P の 1 報目 (報数が小さい) は捨てる
    expect(store.ingest(p2p(p2pWarning, "p2p-1"))).toEqual([]);
    // P2P の 2 報目 (同じ報数) は情報源に足す
    const issue = { ...(p2pWarning.issue as object), serial: "2" };
    const [both] = store.ingest(p2p({ ...p2pWarning, issue }, "p2p-2"));
    expect(dataOf<Eew>(both).sources).toEqual(["wolfx", "p2p"]);
    expect(dataOf<Eew>(both).warnAreas).toEqual(["上川地方北部"]);
  });

  test("同じ電文を二度受けても一度だけ", () => {
    const { store } = memoryStore();
    store.ingest(wolfx(warning));
    expect(store.ingest(wolfx(warning))).toEqual([]);
  });

  test("報数の逆転 (2 報が先、1 報が後) は後のものを捨てる", () => {
    const { store } = memoryStore();
    store.ingest(wolfx(warning));
    expect(store.ingest(wolfx(forecast))).toEqual([]);
    expect(store.eew("20220811005302")?.serial).toBe(2);
  });

  test("一度出た警報は、予報の形の続報でも警報のまま", () => {
    const { store } = memoryStore();
    store.ingest(wolfx(warning));
    store.ingest(wolfx({ ...forecast, Serial: 3 }));
    expect(store.eew("20220811005302")?.kind).toBe("warning");
    expect(store.eew("20220811005302")?.serial).toBe(3);
  });

  test("取消を受けたら、その地震の速報はそこで終わり", () => {
    const { store } = memoryStore();
    store.ingest(wolfx(warning));
    const [c] = store.ingest(wolfx({ ...warning, Serial: 3, isCancel: true }));
    expect(dataOf<Eew>(c).cancelled).toBe(true);
    expect(store.ingest(wolfx({ ...warning, Serial: 4 }))).toEqual([]);
  });

  test("訓練が本番と同じ地震識別番号で来ても混ぜない", () => {
    const { store } = memoryStore();
    store.ingest(wolfx(forecast));
    store.ingest(wolfx({ ...warning, Serial: 5, isTraining: true }));
    expect(store.eew("20220811005302")?.kind).toBe("forecast");
    expect(store.eew("20220811005302", "training")?.serial).toBe(5);
  });

  test("訓練は保存するが、一覧には既定で出さない", () => {
    const { store } = memoryStore();
    store.ingest(wolfx({ ...warning, isTraining: true }));
    expect(store.eews()).toEqual([]);
    expect(store.eews(20, true)).toHaveLength(1);
  });
});

describe("地震情報の新旧の判定", () => {
  test("震度速報に、同じ地震識別番号の震源要素更新を重ねる", () => {
    const { store } = memoryStore();
    store.ingest(jma("32-35_01_01_100806_VXSE51.xml"));
    const [e] = store.ingest(jma("32-35_03_02_240613_VXSE61.xml"));
    const q = dataOf<Quake>(e);
    expect(q.id).toBe("20090811050711");
    expect(q.maxInt).toBe("6-");
    expect(q.hypocenter?.name).toBe("駿河湾");
    expect(q.magnitude).toBe(6.5);
    expect(q.reports).toHaveLength(2);
  });

  test("取消は一連の情報 (同じ種別) だけを取り消し、全部消えたら地震ごと取消", () => {
    const { store } = memoryStore();
    store.ingest(jma("32-35_06_01_240613_VXSE52.xml"));
    store.ingest(jma("32-35_06_04_240613_VXSE53.xml"));
    const [a] = store.ingest(jma("32-35_06_02_100915_VXSE52.xml"));
    expect(dataOf<Quake>(a).cancelled).toBe(false);
    expect(dataOf<Quake>(a).maxInt).toBe("6+");
    const [b] = store.ingest(jma("32-35_06_06_100915_VXSE53.xml"));
    expect(dataOf<Quake>(b).cancelled).toBe(true);
  });

  test("P2P で先に受けたら仮に出し、XML が来たら置き換える", () => {
    const { store } = memoryStore();
    const [first] = store.ingest(p2pIwate());
    expect(dataOf<Quake>(first).provisional).toBe(true);
    expect(dataOf<Quake>(first).magnitude).toBe(6.9);

    const [second] = store.ingest(jma("32-35_06_04_240613_VXSE53.xml"));
    const q = dataOf<Quake>(second);
    expect(q.id).toBe(dataOf<Quake>(first).id);
    expect(q.eventId).toBe("20080614084350");
    expect(q.provisional).toBe(false);
    expect(q.magnitude).toBe(7);
    expect(q.sources).toEqual(["p2p", "jma"]);
    expect(store.quakes()).toHaveLength(1);
  });

  describe("Wolfx の地震情報の一覧 (P2P の予備) も同じ地震にまとめる", () => {
    /** 一覧のうち岩手・宮城内陸地震の行 (No1 は新しい順の先頭なので、古い順に返る並びの最後) */
    const wolfxIwate = (
      magnitude = "7.0",
      receivedAt = "2008-06-14T08:52:00+09:00",
    ): Incoming => {
      const v = json("wolfx/made-eqlist.json");
      v.No1 = { ...(v.No1 as object), magnitude };
      const row = parseWolfxEqlist(v, receivedAt).at(-1);
      if (!row) throw new Error("行が無い");
      return {
        source: "wolfx",
        key: row.key,
        code: "jma_eqlist",
        items: [row.item],
      };
    };
    const xml = () => jma("32-35_06_04_240613_VXSE53.xml");
    const NOW = Date.parse("2008-06-14T08:55:00+09:00");

    const orders: [string, (() => Incoming)[]][] = [
      ["Wolfx → P2P → XML", [wolfxIwate, p2pIwate, xml]],
      ["Wolfx → XML → P2P", [wolfxIwate, xml, p2pIwate]],
      ["P2P → Wolfx → XML", [p2pIwate, wolfxIwate, xml]],
      ["P2P → XML → Wolfx", [p2pIwate, xml, wolfxIwate]],
      ["XML → Wolfx → P2P", [xml, wolfxIwate, p2pIwate]],
      ["XML → P2P → Wolfx", [xml, p2pIwate, wolfxIwate]],
    ];
    for (const [name, steps] of orders) {
      test(`${name}: 一覧は 1 行、通知は同じ事象 (同じ tag) で、XML が来たら XML の姿`, () => {
        const { store } = memoryStore();
        const events = steps.flatMap((s) => store.ingest(s()));
        const quakes = store.quakes();
        expect(quakes).toHaveLength(1);
        const q = quakes[0] as Quake;
        expect(new Set(events.map((e) => dataOf<Quake>(e).id))).toEqual(
          new Set([q.id]),
        );
        const tags = events.map((e) => noticeOf(e, NOW)?.tag);
        expect(new Set(tags)).toEqual(new Set([`quake:${q.id}`]));
        expect(q.eventId).toBe("20080614084350");
        expect(q.provisional).toBe(false);
        expect(q.magnitude).toBe(7);
        expect(q.areas.length).toBeGreaterThan(0);
        expect([...q.sources].sort()).toEqual(["jma", "p2p", "wolfx"]);
      });
    }

    test("Wolfx だけなら仮の姿を出し、P2P が来たら P2P を、XML が来たら XML を正とする", () => {
      const { store } = memoryStore();
      const [a] = store.ingest(wolfxIwate("7.0"));
      expect(dataOf<Quake>(a)).toMatchObject({
        id: "20080614084350",
        provisional: true,
        magnitude: 7,
        maxInt: "6+",
        hypocenter: { name: "岩手県内陸南部" },
        sources: ["wolfx"],
      });
      const [b] = store.ingest(p2pIwate());
      expect(dataOf<Quake>(b)).toMatchObject({
        provisional: true,
        magnitude: 6.9,
      });
      // P2P があるうちは、Wolfx の続報で姿を変えない (地域・観測点の震度を持つ P2P が先)
      const later = "2008-06-14T08:54:00+09:00";
      const [c] = store.ingest(wolfxIwate("7.1", later));
      expect(dataOf<Quake>(c).magnitude).toBe(6.9);
      const [d] = store.ingest(xml());
      expect(dataOf<Quake>(d)).toMatchObject({
        provisional: false,
        magnitude: 7,
      });
      // 中身の同じ一覧の行をもう一度受けても、何も変わらない
      expect(store.ingest(wolfxIwate("7.1", later))).toEqual([]);
      expect(store.quakes()).toHaveLength(1);
    });

    /** P2P の 551 の震度速報 (震源は無い。P2P の決まりで名前は空、深さ・M は -1) */
    const p2pScaleOnly = () => {
      const v = json("p2p/spec-551.json");
      v.issue = {
        source: "気象庁",
        time: "2008/06/14 08:45:00",
        type: "ScalePrompt",
        correct: "None",
      };
      v.earthquake = {
        ...(v.earthquake as object),
        time: "2008/06/14 08:43:00",
        hypocenter: {
          name: "",
          latitude: -200,
          longitude: -200,
          depth: -1,
          magnitude: -1,
        },
        maxScale: 60,
      };
      // 震度速報の点は地域
      v.points = [
        { addr: "岩手県内陸南部", isArea: true, pref: "岩手県", scale: 60 },
      ];
      return p2p(v, "p2p-scale");
    };

    for (const [name, steps] of [
      ["P2P → Wolfx → XML", [p2pScaleOnly, wolfxIwate, xml]],
      ["Wolfx → P2P → XML", [wolfxIwate, p2pScaleOnly, xml]],
    ] as [string, (() => Incoming)[]][]) {
      test(`${name}: P2P が震度速報だけなら、震源・M・深さだけを Wolfx から補い、出典に残す`, () => {
        const { store } = memoryStore();
        const events = steps.slice(0, 2).flatMap((s) => store.ingest(s()));
        const q = store.quakes()[0] as Quake;
        expect(store.quakes()).toHaveLength(1);
        expect(q).toMatchObject({
          provisional: true,
          hypocenter: { name: "岩手県内陸南部", depthKm: 10 },
          magnitude: 7,
          hypocenterSource: "wolfx",
          // 震度は P2P のまま (Wolfx には地域ごとの震度が無い)
          maxInt: "6+",
        });
        expect(q.areas).toEqual([
          { name: "岩手県内陸南部", pref: "岩手県", int: "6+" },
        ]);
        // XML が来たら XML だけの姿になり、補った印は消える
        events.push(...store.ingest(steps[2]?.() as Incoming));
        const done = store.quakes()[0] as Quake;
        expect(store.quakes()).toHaveLength(1);
        expect(done.provisional).toBe(false);
        expect(done.hypocenterSource).toBeUndefined();
        // 通知は同じ事象 (同じ tag) で、二重に鳴らない
        const tags = events.map((e) => noticeOf(e, NOW)?.tag);
        expect(new Set(tags)).toEqual(new Set([`quake:${done.id}`]));
      });
    }

    test("P2P に震源があれば、Wolfx の震源は使わない", () => {
      const { store } = memoryStore();
      store.ingest(wolfxIwate("7.1"));
      store.ingest(p2pIwate());
      const q = store.quakes()[0] as Quake;
      expect(q.magnitude).toBe(6.9);
      expect(q.hypocenterSource).toBeUndefined();
    });
  });

  test("訓練の電文は別の地震として持ち、一覧には出さない", () => {
    const { store } = memoryStore();
    store.ingest(jma("32-35_01_03_240613_VXSE53.xml"));
    expect(store.quakes()).toEqual([]);
    expect(
      store.db.query<{ status: string }, []>("SELECT status FROM quakes").all(),
    ).toEqual([{ status: "training" }]);
  });
});

describe("津波", () => {
  test("VTSE41 は予報区をまるごと置き換え、VTSE52 は沖合の観測を足す", () => {
    const { store } = memoryStore();
    const [a] = store.ingest(jma("32-39_11_02_250206_VTSE41.xml"));
    const t1 = dataOf<Tsunami>(a);
    expect(t1.ended).toBe(false);
    expect(t1.areas.some((x) => x.grade === "major")).toBe(true);

    const [b] = store.ingest(jma("61_11_01_250206_VTSE52.xml"));
    expect(dataOf<Tsunami>(b).observations.every((o) => o.offshore)).toBe(true);
    expect(dataOf<Tsunami>(b).areas).toEqual(t1.areas);

    const [c] = store.ingest(jma("32-39_11_13_250206_VTSE41.xml"));
    const t3 = dataOf<Tsunami>(c);
    expect(t3.id).toBe(t1.id);
    expect(t3.areas.every((x) => x.grade === "forecast")).toBe(true);
    expect(t3.ended).toBe(false);
  });

  test("P2P で先に受けた津波に、XML を重ねる。XML の後の P2P は捨てる", () => {
    const { store } = memoryStore();
    const v = {
      ...json("p2p/spec-552.json"),
      issue: { source: "気象庁", time: "2011/03/11 14:49:30", type: "Focus" },
    };
    const [a] = store.ingest(p2p(v, "p2p-t1"));
    expect(dataOf<Tsunami>(a).provisional).toBe(true);
    const [b] = store.ingest(jma("32-39_11_02_250206_VTSE41.xml"));
    expect(dataOf<Tsunami>(b).id).toBe(dataOf<Tsunami>(a).id);
    expect(dataOf<Tsunami>(b).provisional).toBe(false);
    const later = {
      ...v,
      issue: { source: "気象庁", time: "2011/03/11 15:00:00", type: "Focus" },
    };
    expect(store.ingest(p2p(later, "p2p-t2"))).toEqual([]);
  });

  test("P2P の 552 には訓練の印が無いので、P2P だけの津波は normal。番号の無い訓練の津波は id で分ける", () => {
    const { store } = memoryStore();
    const v = {
      ...json("p2p/spec-552.json"),
      issue: { source: "気象庁", time: "2011/03/11 14:49:30", type: "Focus" },
    };
    const [a] = store.ingest(p2p(v, "p2p-t1"));
    expect(dataOf<Tsunami>(a).status).toBe("normal");
    expect(dataOf<Tsunami>(a).id).toBe("p2p-20110311144930");

    // 地震識別番号の無い訓練の津波 (いまは P2P から来ないが、来たら本番と混ぜない)
    const items = parseP2p({
      ...v,
      issue: { source: "気象庁", time: "2011/03/11 15:49:30", type: "Focus" },
    }).map((i) =>
      i.type === "tsunami"
        ? { ...i, report: { ...i.report, status: "training" as const } }
        : i,
    );
    const [b] = store.ingest({
      source: "p2p",
      key: "p2p-t2",
      code: "552",
      body: "{}",
      items,
    });
    expect(dataOf<Tsunami>(b).id).toBe("p2p-20110311154930-training");
    expect(store.tsunamis().map((t) => t.id)).toEqual([dataOf<Tsunami>(a).id]);
  });

  test("取消", () => {
    const { store } = memoryStore();
    const [a] = store.ingest(jma("38-39_03_01_210805_VTSE41.xml"));
    expect(dataOf<Tsunami>(a).cancelled).toBe(true);
  });
});

test("お知らせは番号ごとに 1 つ", () => {
  const { store } = memoryStore();
  store.ingest(jma("74_01_01_200512_VYSE50.xml"));
  store.ingest(jma("42_01_01_100514_VZSE40.xml"));
  expect(
    store
      .advisories()
      .map((a) => a.code)
      .sort(),
  ).toEqual(["VYSE50", "VZSE40"]);
});

test("events は通し番号で、Last-Event-ID より後を古い順に返す", () => {
  const { store } = memoryStore();
  store.ingest(jma("32-35_01_01_100806_VXSE51.xml"));
  store.ingest(jma("32-35_03_02_240613_VXSE61.xml"));
  store.ingest(jma("74_01_01_200512_VYSE50.xml"));
  expect(store.lastSeq()).toBe(3);
  const after = store.eventsAfter(1);
  expect(after.map((e) => [e.seq, e.type])).toEqual([
    [2, "quake"],
    [3, "advisory"],
  ]);
});

test("古い原文は捨てるが、鍵は残して取り直さない", () => {
  const { store, advance } = memoryStore();
  store.ingest(jma("32-35_01_01_100806_VXSE51.xml"));
  advance(31 * 24 * 60 * 60 * 1000);
  expect(store.prune()).toBe(1);
  expect(store.seen("jma", "32-35_01_01_100806_VXSE51.xml")).toBe(true);
});

describe("長周期地震動に関する観測情報", () => {
  const file = "78_01_01_240613_VXSE62.xml";
  const xml = fixture(`jma/${file}`);
  const incoming = (body: string, key: string): Incoming => ({
    source: "jma",
    key,
    code: "VXSE62",
    body,
    items: parseJmaXml(body, "VXSE62"),
  });

  test("地震識別番号で持ち、新しい報で置き換え、古い報は捨て、取消は中身を残して印を付ける", () => {
    const { store } = memoryStore();
    const [first] = store.ingest(incoming(xml, "a"));
    expect(first?.type).toBe("longperiod");
    expect(dataOf<LongPeriod>(first).id).toBe("20201121023300");

    const later = xml
      .replace(
        "<ReportDateTime>2020-11-21T02:33:10+09:00",
        "<ReportDateTime>2020-11-21T02:43:10+09:00",
      )
      .replace("<Serial>1</Serial>", "<Serial>2</Serial>");
    const [second] = store.ingest(incoming(later, "b"));
    expect(dataOf<LongPeriod>(second).serial).toBe(2);
    // 古い報 (第 1 報の訂正の形で後から来た) は捨てる
    expect(store.ingest(incoming(xml, "c"))).toEqual([]);

    const cancel = later
      .replace(
        "<ReportDateTime>2020-11-21T02:43:10+09:00",
        "<ReportDateTime>2020-11-21T02:53:10+09:00",
      )
      .replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>")
      .replace(/<Body[\s\S]*<\/Body>/, "<Body></Body>");
    const [gone] = store.ingest(incoming(cancel, "d"));
    const lp = dataOf<LongPeriod>(gone);
    expect(lp.cancelled).toBe(true);
    expect(lp.maxLg).toBe("3");
    expect(store.longPeriods()).toHaveLength(1);
    expect(store.longPeriod("20201121023300")?.cancelled).toBe(true);
  });

  test("知らせない (地震情報で知らせている)", () => {
    const { store } = memoryStore("2020-11-20T17:34:00Z");
    const [e] = store.ingest(incoming(xml, "a"));
    if (!e) throw new Error("イベントが無い");
    expect(noticeOf(e, Date.parse("2020-11-20T17:35:00Z"))).toBeNull();
  });
});

test("長周期地震動は地震識別番号と状態で引く (P2P で先に受けて id が番号でない地震でも)", () => {
  const { store } = memoryStore();
  const xml = fixture("jma/78_01_01_240613_VXSE62.xml");
  store.ingest({
    source: "jma",
    key: "lp",
    code: "VXSE62",
    body: xml,
    items: parseJmaXml(xml, "VXSE62"),
  });
  expect(store.longPeriodOf("20201121023300", "normal")?.maxLg).toBe("3");
  expect(store.longPeriodOf("20201121023300", "training")).toBeUndefined();
});
