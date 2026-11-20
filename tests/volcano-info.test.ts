import { describe, expect, test } from "bun:test";

import {
  collapseRoutineVolcanoes,
  type SonaeEvent,
  type Volcano,
} from "#lib/model.ts";
import { matches, noticeOf } from "#lib/notify.ts";
import { DEFAULT_PREFS, type PushPrefs } from "#lib/push.ts";
import { parseJmaXml } from "#lib/server/sources/jma-xml.ts";

import {
  codeOf,
  fixture,
  homeAt,
  jmaIncoming as incoming,
  memoryStore,
} from "./helpers.ts";

/** 火山の解説情報・観測報・降灰予報・推定噴煙流向報 (docs/design.md の 2.2「火山」) */
const KAISETSU = "44_03_01_200731_VFVO51.xml"; // 草津白根山 解説情報 (臨時)。レベル 2 継続
const KANSOKU = "43_01_01_200522_VFVO52.xml"; // 浅間山 噴火に関する火山観測報
const TEIJI = "66_01_01_210517_VFVO53.xml"; // 桜島 降灰予報 (定時)
const SOKUHO = "66_01_02_210514_VFVO54.xml"; // 桜島 降灰予報 (速報)。やや多量
const SHOSAI = "66_01_03_210514_VFVO55.xml"; // 桜島 降灰予報 (詳細)
const NEW_ASH = "66_02_02_261118_VFVO54.xml"; // 霧島山 火山灰予報 (速報)。提供の時期が未定の新しい形
const RYUKO = "79_01_01_210527_VFVO60.xml"; // 桜島 推定噴煙流向報

function volcano(file: string): Volcano {
  const items = parseJmaXml(fixture(`jma/${file}`), codeOf(file));
  expect(items).toHaveLength(1);
  const item = items[0];
  if (item?.type !== "volcano") throw new Error("火山ではありません");
  return {
    ...item.volcano,
    cancelled: false,
    updatedAt: item.volcano.reportedAt,
  };
}
const event = (v: Volcano): SonaeEvent => ({
  seq: 1,
  type: "volcano",
  data: v,
});
const soon = (v: Volcano) => Date.parse(v.reportedAt) + 60_000;
/** 鹿児島市 (4620100) に住んでいる */
const KAGOSHIMA: PushPrefs = { ...DEFAULT_PREFS, home: homeAt("4620100") };

describe("電文を読む", () => {
  test("解説情報: いまの段と、活動の状況・警戒事項・次の発表", () => {
    const v = volcano(KAISETSU);
    expect(v.code).toBe("VFVO51");
    expect(v.title).toBe(
      "草津白根山（白根山（湯釜付近）） 火山の状況に関する解説情報（臨時）",
    );
    expect(v.volcanoes[0]?.level).toBe(2);
    expect(v.volcanoes[0]?.condition).toBe("継続");
    expect(v.activity).toContain("火山性地震が増加");
    expect(v.prevention).toContain("大きな噴石に警戒");
    expect(v.nextAdvisory).toContain("随時お知らせします");
  });

  test("観測報: 噴火の時刻と噴煙。種類 (噴火) は段にしない", () => {
    const v = volcano(KANSOKU);
    expect(v.code).toBe("VFVO52");
    expect(v.eventTime).toBe("2020-05-22T14:45:00+09:00");
    expect(v.volcanoes[0]?.kind).toBe("噴火");
    expect(v.volcanoes[0]?.level).toBeUndefined();
    expect(v.plume).toEqual({
      height: "不明",
      seaLevel: "不明",
      direction: "流向不明",
    });
  });

  test("降灰予報 (速報): 降灰の範囲を種類ごとの市町村等で持つ", () => {
    const v = volcano(SOKUHO);
    expect(v.code).toBe("VFVO54");
    expect(v.validUntil).toBe("2021-05-14T13:31:00+09:00");
    expect(v.eventTime).toBe("2021-05-14T12:31:00+09:00");
    expect(v.ash).toEqual([
      {
        name: "やや多量の降灰",
        code: "72",
        cities: ["鹿児島県鹿児島市"],
        cityCodes: ["4620100"],
      },
      {
        name: "少量の降灰",
        code: "71",
        cities: ["鹿児島県鹿児島市"],
        cityCodes: ["4620100"],
      },
      {
        name: "小さな噴石の落下",
        code: "75",
        cities: ["鹿児島県鹿児島市"],
        cityCodes: ["4620100"],
      },
    ]);
    expect(v.plume?.height).toBe("火口上2200m");
    expect(v.observation).toContain("南岳山頂火口");
    expect(v.appendix).toContain("降灰量階級");
    // 降灰予報の種類のコード (07) は段にしない
    expect(v.volcanoes[0]?.level).toBeUndefined();
  });

  test("降灰予報 (定時・詳細) と、新しい形の火山灰予報も読む", () => {
    const teiji = volcano(TEIJI);
    expect(teiji.ash?.map((a) => a.name)).toEqual(["降灰", "小さな噴石の落下"]);
    expect(teiji.ash?.[0]?.cities).toContain("宮崎県宮崎市");
    expect(volcano(SHOSAI).ash?.map((a) => a.name)).toEqual([
      "やや多量の降灰",
      "少量の降灰",
    ]);
    const next = volcano(NEW_ASH);
    expect(next.ash?.length).toBeGreaterThan(0);
    // 火山灰予報 (速報) の種類のコード 22 は、噴火警戒レベルのコードと重なるが段にしない
    expect(next.volcanoes[0]?.level).toBeUndefined();
  });

  test("推定噴煙流向報: 噴煙の高さと流向", () => {
    const v = volcano(RYUKO);
    expect(v.code).toBe("VFVO60");
    expect(v.title).toBe("桜島 推定噴煙流向報");
    expect(v.plume).toEqual({
      height: "火口上1800m",
      seaLevel: "海抜9400FT",
      direction: "南東",
    });
  });
});

describe("一覧", () => {
  test("いつも出る種別は、火山と種別ごとにいちばん新しい報だけ", () => {
    const teiji = volcano(TEIJI);
    const older = {
      ...teiji,
      id: "older",
      reportedAt: "2021-05-17T08:00:00+09:00",
    };
    const sokuho = volcano(SOKUHO);
    const ryuko = volcano(RYUKO);
    expect(
      collapseRoutineVolcanoes([teiji, ryuko, older, sokuho]).map((v) => v.id),
    ).toEqual([teiji.id, ryuko.id, sokuho.id]);
  });

  test("保存: いつも出る種別は数に入れず、2 日の分から火山と種別ごとに 1 つ足す", () => {
    const { store } = memoryStore("2021-05-17T12:00:00.000Z");
    store.ingest(incoming(TEIJI));
    store.ingest(incoming(KAISETSU));
    const list = store.volcanoes(1);
    expect(list.map((v) => v.code).sort()).toEqual(["VFVO51", "VFVO53"]);
  });
});

describe("通知", () => {
  test("解説情報・観測報・降灰予報 (定時)・推定噴煙流向報は知らせない", () => {
    for (const f of [KAISETSU, KANSOKU, TEIJI, RYUKO]) {
      const v = volcano(f);
      expect(noticeOf(event(v), soon(v))).toBeNull();
    }
  });

  test("降灰予報 (速報) は、やや多量までなら知らせない", () => {
    const v = volcano(SOKUHO);
    expect(noticeOf(event(v), soon(v))).toBeNull();
  });

  test("降灰予報 (速報) の多量の降灰は、住んでいる地域か現在地に当たるときだけ知らせる", () => {
    const base = volcano(SOKUHO);
    const v: Volcano = {
      ...base,
      ash: [
        {
          name: "多量の降灰",
          code: "73",
          cities: ["鹿児島県鹿児島市"],
          cityCodes: ["4620100"],
        },
        ...(base.ash ?? []),
      ],
    };
    const n = noticeOf(event(v), soon(v));
    if (!n) throw new Error("通知が無い");
    expect(n.title).toBe("桜島 降灰予報（速報）");
    expect(n.tag).toBe("volcano:ash:506:2021-05-14T12:31:00+09:00");
    expect(n.urgency).toBe("normal");
    expect(matches(n, KAGOSHIMA)).toBe(true);
    // 全国でも、ほかの所の降灰は知らせない
    expect(matches(n, { ...DEFAULT_PREFS, home: homeAt("1310100") })).toBe(
      false,
    );
    expect(matches(n, { ...KAGOSHIMA, volcano: "off" })).toBe(false);
    // 現在地 (開いている画面) が当たれば知らせる
    expect(matches(n, DEFAULT_PREFS, homeAt("4620100"))).toBe(true);
  });
});
