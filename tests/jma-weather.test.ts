import { describe, expect, test } from "bun:test";

import {
  floodLevel,
  liftedOffice,
  warningLevel,
  warningTop,
  type WeatherInfo,
  type WeatherWarning,
} from "#lib/model.ts";
import {
  parseWeatherXml,
  WEATHER_CODES,
} from "#lib/server/sources/jma-weather.ts";
import type { FeedEntry } from "#lib/server/sources/jma-xml.ts";
import { latestSnapshots } from "#lib/server/sources/jma.ts";

import { fixture, memoryStore } from "./helpers.ts";

/** サンプルのファイル名の VXKOii は、フィードでは VXKO50〜89 の 1 つ */
const parse = (file: string, code: string) =>
  parseWeatherXml(fixture(`jma/${file}`), code);

function warning(file: string, code: string) {
  const [item] = parse(file, code);
  if (item?.type !== "warning") throw new Error("警報・注意報ではありません");
  return item.warning;
}
function info(file: string, code: string) {
  const [item] = parse(file, code);
  if (item?.type !== "weather") throw new Error("気象の報ではありません");
  return item.info;
}

describe("段", () => {
  test("警報・注意報の種類のコード (R06 の別表 3)", () => {
    expect(warningLevel("33")).toBe(5); // レベル５大雨特別警報
    expect(warningLevel("35")).toBe(5); // 暴風特別警報
    expect(warningLevel("49")).toBe(4); // レベル４土砂災害危険警報
    expect(warningLevel("03")).toBe(3); // レベル３大雨警報
    expect(warningLevel("05")).toBe(3); // 暴風警報
    expect(warningLevel("10")).toBe(2); // レベル２大雨注意報
    expect(warningLevel("27")).toBe(2); // その他の注意報
    expect(warningLevel("00")).toBe(0); // 解除
    expect(warningLevel(undefined)).toBe(0);
  });
  test("指定河川洪水予報の種類のコード (解説資料の表 2)", () => {
    expect(floodLevel("53")).toBe(5);
    expect(floodLevel("41")).toBe(4);
    expect(floodLevel("30")).toBe(3);
    expect(floodLevel("22")).toBe(2);
    expect(floodLevel("10")).toBe(0);
  });
});

describe("気象警報・注意報 (R06)", () => {
  test("大雨 (VPWW55): 府県予報区ごとの状態。解除された市町村等は別に持つ", () => {
    const w = warning("15_17_01_251222_VPWW55.xml", "VPWW55");
    expect(w.id).toBe("VPWW55-320000");
    expect(w.office).toEqual({ code: "320000", name: "島根県" });
    expect(w.status).toBe("normal");
    expect(w.infoType).toBe("発表");
    expect(w.title).toBe("島根県大雨警報・注意報");
    expect(w.areas).toHaveLength(15);
    expect(w.areas[0]).toEqual({
      code: "3220100",
      name: "松江市",
      kinds: [
        { code: "03", name: "レベル３大雨警報", level: 3, status: "継続" },
      ],
    });
    expect(w.released).toEqual([
      {
        code: "3252800",
        name: "隠岐の島町",
        kinds: [
          { code: "10", name: "レベル２大雨注意報", level: 2, status: "解除" },
        ],
      },
    ]);
    // 解除の市町村等は、出ている市町村等に入れない
    expect(w.areas.some((a) => a.code === "3252800")).toBe(false);
    expect(warningTop(w)).toBe(3);
  });

  test("土砂災害 (VPWW56): レベル４土砂災害危険警報 (土砂災害警戒情報にあたる)", () => {
    const w = warning("15_16_01_241031_VPWW56.xml", "VPWW56");
    expect(w.id).toBe("VPWW56-011000");
    expect(w.areas[0]?.kinds[0]).toEqual({
      code: "49",
      name: "レベル４土砂災害危険警報",
      level: 4,
      status: "発表",
    });
    expect(warningTop(w)).toBe(4);
  });

  test("その他の注意報 (VPWW61): 雷・融雪・濃霧などの注意報で、どれも注意報の段", () => {
    const w = warning("15_16_07_250825_VPWW61.xml", "VPWW61");
    const names = new Set(w.areas.flatMap((a) => a.kinds.map((k) => k.name)));
    expect(names.has("雷注意報")).toBe(true);
    expect(names.has("融雪注意報")).toBe(true);
    expect(w.areas.every((a) => a.kinds.every((k) => k.level === 2))).toBe(
      true,
    );
  });

  test("暴風 (VPWW58): 暴風警報は警報の段", () => {
    const w = warning("15_16_04_251222_VPWW58.xml", "VPWW58");
    expect(w.areas[0]?.kinds[0]?.name).toBe("暴風警報");
    expect(warningTop(w)).toBe(3);
  });
});

describe("気象の報", () => {
  test("記録的短時間大雨情報 (VPOA50): 一次細分区域と見出しの文", () => {
    const r = info("18_03_01_190412_VPOA50.xml", "VPOA50");
    expect(r.kind).toBe("rain");
    expect(r.series).toBe("rain-JPSP201903281834");
    expect(r.headline).toContain("札幌市中央区付近で約１００ミリ");
    expect(r.areas).toEqual([
      { code: "016010", name: "石狩地方" },
      { code: "016030", name: "後志地方" },
    ]);
  });

  test("府県気象防災速報 (VPBS50): 線状降水帯は取り、記録雨は記録的短時間大雨情報と二重なので取らない", () => {
    const r = info("82_01_01_260324_VPBS50.xml", "VPBS50");
    expect(r.kind).toBe("bosai");
    expect(r.kindName).toBe("線状降水帯発生");
    expect(r.title).toBe("千葉県気象防災速報（線状降水帯発生）");
    expect(parse("82_01_02_250630_VPBS50.xml", "VPBS50")).toEqual([
      { type: "other", code: "VPBS50" },
    ]);
  });

  test("竜巻注意情報 (VPHW50): 有効期限と、市町村等まで並んだ地域", () => {
    const r = info("19_08_03_250630_VPHW50.xml", "VPHW50");
    expect(r.kind).toBe("tornado");
    expect(r.series).toBe("tornado-110000");
    expect(r.validUntil).toBe("2015-07-17T10:30:00+09:00");
    expect(r.areas[0]).toEqual({ code: "110000", name: "埼玉県" });
    expect(r.areas.some((a) => a.code.length === 7)).toBe(true);
  });

  test("指定河川洪水予報 (VXKO): 段と河川。解除は 0", () => {
    const r = info("16_09_01_260312_VXKOii.xml", "VXKO53");
    expect(r.kind).toBe("flood");
    expect(r.level).toBe(3);
    expect(r.kindName).toBe("レベル３氾濫警報");
    expect(r.series).toBe("flood-890904000300");
    expect(r.areas.map((a) => a.name)).toContain("佐賀県");
    expect(info("16_14_01_251222_VXKOii.xml", "VXKO53").level).toBe(0);
  });

  test("指定河川洪水予報 (VXKO): 観測所ごとの実況と予想の水位と基準の水位。基準観測所が先で、欠測は値が無い", () => {
    const r = info("16_14_01_251222_VXKOii.xml", "VXKO53");
    // 電文の順は置戸・北見・上川沿。主文で名前の出る基準観測所 (上川沿) を先に
    expect(r.stations?.map((s) => [s.name, s.base])).toEqual([
      ["上川沿", true],
      ["置戸", false],
      ["北見", false],
    ]);
    const s = r.stations?.[0];
    expect(s?.code).toBe("81011100010000016");
    expect(s?.location).toBe("北見市");
    expect(s?.levels).toHaveLength(7);
    expect(s?.levels[0]).toEqual({
      time: "2025-11-02T14:50:00+09:00",
      label: "現況",
      m: 6.19,
    });
    expect(s?.levels[6]).toEqual({
      time: "2025-11-02T20:50:00+09:00",
      label: "６時間後",
      m: 5.72,
    });
    expect(s?.criteria).toEqual([
      { name: "レベル１水防団待機水位", m: 5.3 },
      { name: "レベル２氾濫注意水位", m: 6.2 },
      { name: "レベル３避難判断水位", m: 7.4 },
      { name: "レベル４氾濫危険水位", m: 7.6 },
      { name: "レベル４計画高水位等", m: 9.3 },
    ]);

    const ushizu = info("16_09_01_260312_VXKOii.xml", "VXKO53").stations;
    expect(ushizu?.map((x) => x.name)).toEqual(["妙見橋"]);
    expect(ushizu?.[0]?.levels[0]?.m).toBe(3.74);
    expect(ushizu?.[0]?.levels[6]).toEqual({
      time: ushizu?.[0]?.levels[6]?.time ?? "",
      label: "６時間後",
    });
    // 洪水予報でない報には持たない
    expect(
      info("57_03_01_240401_VPFT50.xml", "VPFT50").stations,
    ).toBeUndefined();
  });

  test("熱中症警戒アラート (VPFT50): 本文だけで地域のコードは無い", () => {
    const r = info("57_03_01_240401_VPFT50.xml", "VPFT50");
    expect(r.kind).toBe("heat");
    expect(r.title).toBe("埼玉県熱中症警戒アラート");
    expect(r.text).toStartWith("埼玉県では、今日（１１日）は");
    expect(r.areas).toEqual([]);
  });

  test("台風解析・予報情報 (VPTW60): 実況の中心と強さ。消滅は呼称の備考", () => {
    const r = info("10_04_07_170916_VPTW60.xml", "VPTW60");
    expect(r.kind).toBe("typhoon");
    expect(r.series).toBe("typhoon-TC1725");
    expect(r.typhoon).toMatchObject({
      number: "1718",
      name: "TALIM",
      className: "台風(TY)",
      areaClass: "大型",
      intensityClass: "強い",
      lat: 29.2,
      lon: 127.1,
      pressureHpa: 965,
      maxWindMs: 35,
      maxGustMs: 50,
    });
    const end = info("10_04_08_170918_VPTW60.xml", "VPTW60");
    expect(end.typhoon?.remark).toBe("台風消滅（温帯低気圧化）");
  });

  test("取る種別。経過措置の電文 (VPWW53・VXWW50) と竜巻の目撃情報付き (VPHW51) は取らない", () => {
    for (const c of [
      "VPWW55",
      "VPWW61",
      "VPOA50",
      "VXKO50",
      "VXKO89",
      "VPTW65",
    ])
      expect(WEATHER_CODES.has(c)).toBe(true);
    for (const c of [
      "VPWW53",
      "VPWW54",
      "VXWW50",
      "VPHW51",
      "VPNO50",
      "VPWS50",
    ])
      expect(WEATHER_CODES.has(c)).toBe(false);
  });
});

describe("フィード", () => {
  const entry = (code: string, name: string): FeedEntry => ({
    id: name,
    url: `https://example.invalid/data/${name}`,
    updated: "",
    title: "",
    code,
  });
  test("状態をまるごと持つ種別は、府県予報区ごとにいちばん新しいものだけ", () => {
    const entries = [
      entry("VPWW55", "20261114133106_0_VPWW55_471000.xml"),
      entry("VPWW55", "20261114120000_0_VPWW55_471000.xml"),
      entry("VPWW55", "20261114120000_0_VPWW55_320000.xml"),
      entry("VPHW50", "20261114120000_0_VPHW50_110000.xml"),
      entry("VPHW50", "20261114110000_0_VPHW50_110000.xml"),
    ];
    const kept = latestSnapshots(entries, new Set(["VPWW55"])).map((e) => e.id);
    expect(kept).toEqual([
      "20261114133106_0_VPWW55_471000.xml",
      "20261114120000_0_VPWW55_320000.xml",
      "20261114120000_0_VPHW50_110000.xml",
      "20261114110000_0_VPHW50_110000.xml",
    ]);
  });
});

describe("保存", () => {
  const incoming = (file: string, code: string, key = file) => ({
    source: "jma-weather" as const,
    key,
    code,
    body: fixture(`jma/${file}`),
    items: parse(file, code),
  });

  test("警報・注意報は府県予報区と種別ごとに置き換え、古い報は捨てる", () => {
    const { store } = memoryStore();
    const first = store.ingest(
      incoming("15_17_01_251222_VPWW55.xml", "VPWW55"),
    );
    expect(first).toHaveLength(1);
    expect(first[0]?.type).toBe("warning");
    // 同じ報を別の鍵で受けても (時刻が同じ発表)、イベントを出さない
    expect(
      store.ingest(incoming("15_17_01_251222_VPWW55.xml", "VPWW55", "again")),
    ).toEqual([]);
    // 古い報 (長期フィードで後から読んだもの) は捨てる
    const [item] = parse("15_17_01_251222_VPWW55.xml", "VPWW55");
    if (item?.type !== "warning") throw new Error("警報ではありません");
    const old = {
      ...item,
      warning: { ...item.warning, reportedAt: "2024-11-02T10:00:00+09:00" },
    };
    expect(
      store.ingest({
        source: "jma-weather",
        key: "old",
        code: "VPWW55",
        items: [old],
      }),
    ).toEqual([]);
    const now: WeatherWarning[] = store.warnings();
    expect(now.map((w) => w.id)).toEqual(["VPWW55-320000"]);
    expect(now[0]?.reportedAt).toBe("2024-11-02T11:19:00+09:00");
  });

  test("報ごとの情報は 1 行ずつ。取消は一連の情報のいちばん新しい報に印を付ける", () => {
    const { store } = memoryStore();
    store.ingest(incoming("18_03_01_190412_VPOA50.xml", "VPOA50"));
    const [item] = parse("18_03_01_190412_VPOA50.xml", "VPOA50");
    if (item?.type !== "weather") throw new Error("気象の報ではありません");
    const cancel = {
      ...item,
      info: {
        ...item.info,
        id: "x",
        infoType: "取消" as const,
        reportedAt: "2019-03-28T20:10:00+09:00",
      },
    };
    const out = store.ingest({
      source: "jma-weather",
      key: "cancel",
      code: "VPOA50",
      items: [cancel],
    });
    expect(out[0]?.type).toBe("weather");
    const list: WeatherInfo[] = store.weatherInfos();
    expect(list).toHaveLength(1);
    expect(list[0]?.cancelled).toBe(true);
    expect(list[0]?.id).toBe(item.info.id);
  });
});

describe("全部解除された府県予報区", () => {
  const office = { code: "320000", name: "島根県" };
  const row = (
    reportedAt: string,
    areas: WeatherWarning["areas"],
    status: WeatherWarning["status"] = "normal",
  ) => ({ office, status, reportedAt, areas });
  const area = warning("15_17_01_251222_VPWW55.xml", "VPWW55").areas[0]!;

  test("どの種別にも出ている市町村等が無ければ、いちばん新しい報の時刻で解除されたとみなす", () => {
    expect(
      liftedOffice([
        row("2024-11-02T10:00:00+09:00", []),
        row("2024-11-02T11:19:00+09:00", []),
      ]),
    ).toEqual({ office, reportedAt: "2024-11-02T11:19:00+09:00" });
  });

  test("まだ出ている種別があれば、解除されていない", () => {
    expect(
      liftedOffice([
        row("2024-11-02T11:19:00+09:00", []),
        row("2024-11-02T10:00:00+09:00", [area]),
      ]),
    ).toBeNull();
  });

  test("報を受けていない (訓練・試験だけも) なら分からないので、解除されたとは言わない", () => {
    expect(liftedOffice([])).toBeNull();
    expect(
      liftedOffice([row("2024-11-02T11:19:00+09:00", [], "training")]),
    ).toBeNull();
  });

  test("保存した報から引く: 解除の報で出ている市町村等が無くなった府県予報区は、解除されたと分かる", () => {
    const { store } = memoryStore();
    const [item] = parse("15_17_01_251222_VPWW55.xml", "VPWW55");
    if (item?.type !== "warning") throw new Error("警報ではありません");
    store.ingest({
      source: "jma-weather",
      key: "issued",
      code: "VPWW55",
      items: [item],
    });
    const code = item.warning.office.code;
    expect(liftedOffice(store.officeWarnings(code))).toBeNull();
    const lifted = {
      ...item,
      warning: {
        ...item.warning,
        reportedAt: "2024-11-03T09:00:00+09:00",
        areas: [],
        released: item.warning.areas,
      },
    };
    store.ingest({
      source: "jma-weather",
      key: "lifted",
      code: "VPWW55",
      items: [lifted],
    });
    expect(liftedOffice(store.officeWarnings(code))).toEqual({
      office: item.warning.office,
      reportedAt: "2024-11-03T09:00:00+09:00",
    });
    // 受けていない府県予報区は分からない
    expect(liftedOffice(store.officeWarnings("999999"))).toBeNull();
  });
});
