import { describe, expect, test } from "bun:test";

import {
  collapseNotes,
  isFarNote,
  type SonaeEvent,
  type WeatherInfo,
} from "#lib/model.ts";
import { noticeOf } from "#lib/notify.ts";
import { WEATHER_CODES } from "#lib/server/sources/jma-weather.ts";
import { jmaWeatherSource } from "#lib/server/sources/jma.ts";

import {
  fixture,
  homeAt,
  memoryStore,
  sourceContext,
  weatherInfo,
} from "./helpers.ts";

/** 気象解説情報・潮位の解説・天候情報・早期天候情報 (docs/design.md の 2.8) */
const FUKEN = "85_01_01_250630_VPFJ51.xml"; // 東京都気象解説情報 (台風第 13 号)
const CHIHO = "84_01_01_260129_VPCJ51.xml"; // 関東甲信地方気象解説情報 (強い冬型・大雪)
const ZENPAN = "83_01_01_250630_VPZJ51.xml"; // 全般気象解説情報 (線状降水帯半日前予測)
const FUKUSHINDO = "89_01_01_250630_VMCJ55.xml"; // 胆振・日高地方気象解説情報 (副振動)
const OSHIO = "87_01_01_250630_VMCJ53.xml"; // 全般気象解説情報 (大潮)
const TENKO = "29_01_01_140129_VPZI50.xml"; // 全般天候情報 (高温と少雨)
const TENKO_CHIHO = "30_01_01_100915_VPCI50.xml"; // 地方天候情報 (梅雨明け)
const SOUKI = "72_01_01_190327_VPAW51.xml"; // 早期天候情報 (高温、東北地方)

const code = (file: string) => /_([A-Z]{4}\d{2})\.xml$/.exec(file)?.[1] ?? "";
const info = (file: string) => weatherInfo(file, code(file));
const titles = (w: WeatherInfo) => (w.sections ?? []).map((s) => s.title);

describe("電文を読む", () => {
  test("取る種別: 新しい形式の解説情報と天候の情報。前の形式は取らない", () => {
    for (const c of [
      "VPZJ51",
      "VPCJ51",
      "VPFJ51",
      "VMCJ53",
      "VMCJ54",
      "VMCJ55",
      "VPZI50",
      "VPCI50",
      "VPAW51",
    ])
      expect(WEATHER_CODES.has(c)).toBe(true);
    for (const c of [
      "VPZJ50",
      "VPCJ50",
      "VPFJ50",
      "VMCJ50",
      "VMCJ52",
      "VPHW51",
    ])
      expect(WEATHER_CODES.has(c)).toBe(false);
  });

  test("府県気象解説情報: 情報タグ・地域・本文の節 (予想と実況は地域ごとの値)", () => {
    const w = info(FUKEN);
    expect(w.kind).toBe("commentary");
    expect(w.series).toBe("commentary-JPTK230120");
    expect(w.kindName).toBe("台風 大雨 落雷 突風 強風 高波");
    expect(w.areas.map((a) => a.name)).toEqual([
      "東京地方",
      "伊豆諸島北部",
      "伊豆諸島南部",
    ]);
    expect(titles(w)).toContain("気象概況");
    expect(titles(w)).toContain("防災事項");
    expect(titles(w).at(-1)).toBe("補足事項");
    const rain = w.sections?.find(
      (s) => s.title === "予想される１時間降水量（いずれも多い所）",
    );
    expect(rain?.lines).toContain("　伊豆諸島北部　５０ミリ");
    const obs = w.sections?.find((s) => s.title.startsWith("降水量"));
    expect(obs?.lines).toContain("　三宅島　５２．０ミリ　※観測史上１位");
  });

  test("地方・全般の気象解説情報", () => {
    expect(titles(info(CHIHO))).toEqual(["気象概況", "防災事項", "補足事項"]);
    const z = info(ZENPAN);
    expect(z.kindName).toBe("線状降水帯予測");
    expect(
      z.sections?.find((s) => s.title === "線状降水帯発生予測")?.lines,
    ).toContain("　（四国地方）高知県　１４日未明から１４日夜遅くにかけて");
  });

  test("潮位の気象解説情報: 地点の観測の文と、満潮・干潮の時刻", () => {
    const w = info(FUKUSHINDO);
    expect(w.kind).toBe("tide");
    expect(w.kindName).toBe("副振動");
    expect(
      w.sections?.find((s) => s.title === "副振動の実況")?.lines,
    ).toContain(
      "　苫小牧東（港湾局）　１９日１２時２０分ごろ　約８０センチ　約６０分",
    );
    expect(
      w.sections?.find((s) => s.title === "次の満潮・干潮時刻")?.lines,
    ).toContain(
      "　苫小牧東（港湾局）　満潮時刻　１９日１７時０２分、干潮時刻　１９日２３時４０分",
    );
    expect(info(OSHIO).kindName).toBe("大潮");
  });

  test("天候情報: 本文の文の種類を見出しにし、地点の値を並べる。地域は対象の地域", () => {
    const w = info(TENKO);
    expect(w.kind).toBe("climate");
    expect(w.areas).toEqual([{ code: "010000", name: "全国" }]);
    expect(titles(w).slice(0, 3)).toEqual(["概況", "今後の見通し", "防災事項"]);
    expect(
      w.sections?.find((s) => s.title === "天候の状況（速報値）")?.lines,
    ).toContain(
      "　東京　平均気温 9.2度、平均気温平年差 +1.6度、降水量 19.5ミリ、総降水量平年比 23％",
    );
    expect(info(TENKO_CHIHO).sections?.[0]?.lines[0]).toContain("梅雨前線");
  });

  test("早期天候情報: 条件の文と本文", () => {
    const w = info(SOUKI);
    expect(w.kind).toBe("earlyClimate");
    expect(w.kindName).toBe(
      "１２月１０日頃からの約５日間、かなりの高温の確率30％以上",
    );
    expect(w.validUntil).toBe("2017-12-09T14:30:00+09:00");
    expect(titles(w)).toEqual(["かなりの高温", "早期天候情報"]);
  });
});

describe("一覧と保存", () => {
  test("一連の情報ごとにいちばん新しい報だけ (天候情報は報ごとに別の一連の情報)", () => {
    const a = info(FUKEN);
    const older = {
      ...a,
      id: "older",
      reportedAt: "2023-09-07T11:00:00+09:00",
    };
    const tenko = info(TENKO);
    expect(collapseNotes([a, tenko, older]).map((x) => x.id)).toEqual([
      a.id,
      tenko.id,
    ]);
  });

  test("保存: 解説の情報は新しい 100 件に数えず、3 日の分から足す", () => {
    const { store } = memoryStore("2023-09-08T00:00:00.000Z");
    const one = (file: string) =>
      store.ingest({
        source: "jma-weather",
        key: file,
        code: code(file),
        body: fixture(`jma/${file}`),
        items: [{ type: "weather", info: info(file) }],
      });
    one(FUKEN);
    one("18_03_01_190412_VPOA50.xml");
    const list = store.weatherInfos(1);
    expect(list.map((x) => x.kind).sort()).toEqual(["commentary", "rain"]);
  });
});

describe("「すべて」で隠すほかの府県の解説", () => {
  test("電文の地域 (府県予報区・細分区域等) を、住んでいる地域の一次細分区域・府県予報区と突き合わせる", () => {
    const tokyo = homeAt("1310100"); // 千代田区 (東京地方)
    const tomakomai = homeAt("0121300"); // 苫小牧市 (胆振地方)
    expect(isFarNote(info(FUKEN), tokyo)).toBe(false);
    expect(isFarNote(info(FUKEN), tomakomai)).toBe(true);
    expect(isFarNote(info(FUKUSHINDO), tomakomai)).toBe(false);
    expect(isFarNote(info(FUKUSHINDO), tokyo)).toBe(true);
    // 住んでいる地域を選んでいなければ府県の解説は全部隠し、全般・地方は隠さない
    expect(isFarNote(info(FUKEN), null)).toBe(true);
    expect(isFarNote(info(CHIHO), null)).toBe(false);
    expect(isFarNote(info(OSHIO), null)).toBe(false);
  });
});

describe("通知", () => {
  test("解説の情報は知らせない", () => {
    for (const f of [FUKEN, CHIHO, ZENPAN, FUKUSHINDO, OSHIO, TENKO, SOUKI]) {
      const w = info(f);
      const e: SonaeEvent = { seq: 1, type: "weather", data: w };
      expect(noticeOf(e, Date.parse(w.reportedAt) + 60_000)).toBeNull();
    }
  });
});

describe("フィード", () => {
  test("随時のフィードに加えて、その他のフィード (other.xml) から潮位の解説情報を取る", async () => {
    const { ctx, got } = sourceContext();
    const urls: string[] = [];
    const feed = (entries: string[]) =>
      `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries
        .map(
          (u) =>
            `<entry><title>t</title><id>${u}</id><updated>2026-11-21T00:00:00Z</updated><link type="application/xml" href="${u}"/></entry>`,
        )
        .join("")}</feed>`;
    const tide =
      "https://example.invalid/data/20230919042300_0_VMCJ55_015000.xml";
    const umi =
      "https://example.invalid/data/20230919042300_0_VPCU51_015000.xml";
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("other.xml") || url.endsWith("other_l.xml"))
        return new Response(feed([tide, umi]));
      if (url.endsWith(".xml") && url.includes("/feed/"))
        return new Response(feed([]));
      if (url === tide) return new Response(fixture(`jma/${FUKUSHINDO}`));
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const ac = new AbortController();
    const src = jmaWeatherSource(ctx, {
      fetch: fakeFetch,
      log: () => {},
      sleep: async () => {
        ac.abort();
      },
    });
    await src.run(ac.signal);
    const names = urls
      .filter((u) => u.includes("/feed/"))
      .map((u) => u.split("/").pop());
    expect(names).toEqual([
      "extra_l.xml",
      "extra.xml",
      "other_l.xml",
      "other.xml",
    ]);
    // 取る種別 (VMCJ55) だけを取り、海上警報 (VPCU51) は取らない
    expect(urls).toContain(tide);
    expect(urls).not.toContain(umi);
    expect(got.map((m) => m.code)).toEqual(["VMCJ55"]);
  });

  test("その他のフィードが取れなくても、情報源はつながったままで、次の間隔まで取り直さない", async () => {
    const { ctx } = sourceContext();
    const urls: string[] = [];
    const empty = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`;
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/other")) return new Response("", { status: 503 });
      return new Response(empty);
    }) as typeof fetch;
    const ac = new AbortController();
    let rounds = 0;
    const src = jmaWeatherSource(ctx, {
      fetch: fakeFetch,
      log: () => {},
      sleep: async () => {
        expect(src.status().state).toBe("connected");
        if (++rounds >= 2) ac.abort();
      },
    });
    await src.run(ac.signal);
    // 1 回目に失敗した other_l.xml は、2 回目 (60 秒後) には取りに行かない (5 分ごと)
    expect(urls.filter((u) => u.includes("/other")).length).toBe(1);
    expect(urls.filter((u) => u.endsWith("extra.xml")).length).toBe(2);
  });
});
