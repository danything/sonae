/**
 * 雪の気象の情報 (docs/design.md の 2.8 の「雪の情報」)。気象防災速報 (短時間大雪。前の「顕著な大雪に関する
 * 気象情報」) と、雪の特別警報・警報・注意報 (R06) の段・色・通知・読み上げ
 */
import { describe, expect, test } from "bun:test";

import { WARNING_COLORS, weatherTitle } from "#lib/format.ts";
import { warningFill } from "#lib/map/style.ts";
import {
  areaLevel,
  cityLevels,
  warningLevel,
  warningTop,
  WEATHER_INFO_LABEL,
  type WeatherWarning,
} from "#lib/model.ts";
import { matches, noticeFor, noticeOf } from "#lib/notify.ts";
import {
  clean,
  OPENINGS,
  readoutCandidates,
  readoutOf,
  sentences,
} from "#lib/readout.ts";
import { parseWeatherXml } from "#lib/server/sources/jma-weather.ts";

import { prefs, warningEvent as ev, weatherEvent } from "./events.ts";
import { fixture, homeAt, weatherInfo, weatherWarning } from "./helpers.ts";

/** 稚内地方気象台の大雪の電文 (稚内市に大雪警報、浜頓別町などに大雪注意報) */
const SNOW = "15_16_06_241226_VPWW60.xml";
/** 同じ気象台の暴風の電文 (稚内市に暴風警報、ほかに強風注意報) */
const WIND = "15_16_04_251222_VPWW58.xml";
/** その他の注意報の電文 (なだれ注意報・着雪注意報を含む) */
const OTHER = "15_16_07_250825_VPWW61.xml";

/** 電文の種類の名前とコードを書き換える (雪の特別警報・暴風雪のサンプル電文が無いため) */
const rename =
  (pairs: [string, string, string, string][]) =>
  (s: string): string =>
    pairs.reduce(
      (x, [name, code, to, toCode]) =>
        x.replace(
          new RegExp(`<Name>${name}</Name>\\s*<Code>${code}</Code>`, "g"),
          `<Name>${to}</Name><Code>${toCode}</Code>`,
        ),
      s,
    );

const snow = weatherWarning(SNOW, "VPWW60");
const snowSpecial = weatherWarning(
  SNOW,
  "VPWW60",
  rename([["大雪警報", "06", "大雪特別警報", "36"]]),
);
/** 暴風警報を暴風雪警報に、強風注意報を風雪注意報に */
const blizzard = weatherWarning(
  WIND,
  "VPWW58",
  rename([
    ["暴風警報", "05", "暴風雪警報", "02"],
    ["強風注意報", "15", "風雪注意報", "13"],
  ]),
);
const blizzardSpecial = weatherWarning(
  WIND,
  "VPWW58",
  rename([
    ["暴風警報", "05", "暴風雪特別警報", "32"],
    ["強風注意報", "15", "風雪注意報", "13"],
  ]),
);
const other = weatherWarning(OTHER, "VPWW61");

const WAKKANAI = "0121400";
const at = (w: WeatherWarning) => Date.parse(w.reportedAt) + 60_000;

const kindsOf = (w: WeatherWarning, city: string) =>
  w.areas.find((a) => a.code === city)?.kinds ?? [];

function notice(w: WeatherWarning, home: string | null) {
  const base = noticeOf(ev(w), at(w));
  if (!base) throw new Error("通知の元が無い");
  return noticeFor(base, prefs(home ? { home: homeAt(home) } : {}));
}

describe("気象防災速報 (短時間大雪)", () => {
  // 解説資料の別表 2: 情報タグ「短時間大雪」は「顕著な大雪に関する気象情報」で、
  // 「従前の顕著な大雪に関する気象情報に対応する」。電文は府県気象防災速報 (VPBS50) だけ
  const i = weatherInfo("82_01_03_241031_VPBS50.xml", "VPBS50");

  test("府県気象防災速報 (VPBS50) の情報タグ「短時間大雪」を、線状降水帯と同じ気象防災速報として取る", () => {
    expect(i.kind).toBe("bosai");
    expect(i.kindName).toBe("短時間大雪");
    expect(i.title).toBe("滋賀県気象防災速報（短時間大雪）");
    expect(weatherTitle(i)).toBe("滋賀県気象防災速報（短時間大雪）");
    expect(WEATHER_INFO_LABEL[i.kind]).toBe("気象防災速報");
    expect(i.headline).toContain("６時間で３７センチの顕著な降雪");
    expect(i.headline).toContain("深刻な交通障害の発生するおそれ");
    // 対象は見出しの情報タグの一次細分区域
    expect(i.areas).toEqual([{ code: "250020", name: "北部" }]);
    // 一連の情報は EventID の前半 (第 1 号の識別)
    expect(i.series).toBe("bosai-JPOD240001");
    expect(i.level).toBeUndefined();
  });

  test("住んでいる地域の一次細分区域に出たら、記録的短時間大雨情報と同じ段・同じ形で知らせる (持ち主の決定、2026-11-28)", () => {
    const lines = weatherInfo("82_01_01_260324_VPBS50.xml", "VPBS50");
    const cases: [typeof i, string, string][] = [
      [i, "2520300", "気象防災速報 (短時間大雪) 滋賀県長浜市"], // 滋賀県北部
      [lines, "1220400", "気象防災速報 (線状降水帯発生) 千葉県船橋市"], // 千葉県北西部
    ];
    for (const [x, home, title] of cases) {
      const base = noticeOf(weatherEvent(x), Date.parse(x.reportedAt) + 60_000);
      if (!base) throw new Error("通知の元が無い");
      const n = noticeFor(base, prefs({ home: homeAt(home) }));
      expect(n?.title).toBe(title);
      expect(n?.level).toBe(3);
      expect(n?.urgency).toBe("high");
      // 本文は気象庁の見出しのまま
      expect(n?.body).toBe(x.headline.replace(/\s+/g, " ").trim());
      // 読み上げは決まった文と、気象庁の見出しの文を変えずに
      if (!n) continue;
      const parts = readoutOf(n);
      expect(parts[0]).toBe(OPENINGS.bosai);
      expect(parts.slice(1).join("")).toBe(
        sentences(clean(x.headline)).join(""),
      );
    }
  });

  test("住んでいる地域でなければ知らせない。記録雨は取らないので知らせない", () => {
    const base = noticeOf(weatherEvent(i), Date.parse(i.reportedAt) + 60_000);
    if (!base) throw new Error("通知の元が無い");
    expect(noticeFor(base, prefs({ home: homeAt("1220400") }))).toBeNull();
    expect(noticeFor(base, prefs({}))).toBeNull();
  });

  test("前の形式の府県気象情報 (VPFJ50。「顕著な大雪に関する〇〇県気象情報」) は取らない", () => {
    expect(
      parseWeatherXml(fixture("jma/85_01_01_250630_VPFJ51.xml"), "VPFJ50"),
    ).toEqual([{ type: "other", code: "VPFJ50" }]);
  });
});

describe("雪の警報・注意報 (R06)", () => {
  test("段は種類のコード (別表 3) から。新しい形でも雪の名前に警戒レベルは付かない", () => {
    expect(warningLevel("36")).toBe(5); // 大雪特別警報
    expect(warningLevel("32")).toBe(5); // 暴風雪特別警報
    expect(warningLevel("06")).toBe(3); // 大雪警報
    expect(warningLevel("02")).toBe(3); // 暴風雪警報
    expect(warningLevel("12")).toBe(2); // 大雪注意報
    expect(warningLevel("13")).toBe(2); // 風雪注意報
    expect(warningLevel("22")).toBe(2); // なだれ注意報
    expect(warningLevel("26")).toBe(2); // 着雪注意報
    expect(kindsOf(snow, WAKKANAI)).toEqual([
      { code: "06", name: "大雪警報", level: 3, status: "発表" },
    ]);
    expect(kindsOf(snow, "0151200").map((k) => [k.name, k.level])).toEqual([
      ["大雪注意報", 2],
    ]);
    expect(warningTop(snow)).toBe(3);
    expect(warningTop(snowSpecial)).toBe(5);
    expect(kindsOf(blizzard, WAKKANAI).map((k) => [k.name, k.level])).toEqual([
      ["暴風雪警報", 3],
    ]);
    expect(
      blizzard.areas
        .flatMap((a) => a.kinds)
        .some((k) => k.name === "風雪注意報" && k.level === 2),
    ).toBe(true);
    expect(warningTop(blizzardSpecial)).toBe(5);
    const others = new Map(
      other.areas.flatMap((a) => a.kinds).map((k) => [k.name, k.level]),
    );
    expect(others.get("なだれ注意報")).toBe(2);
    expect(others.get("着雪注意報")).toBe(2);
  });

  test("地図と一覧の色は段の色 (特別警報 12,0,12・警報 255,40,0・注意報 242,231,0)", () => {
    const levels = cityLevels([snowSpecial]);
    expect(levels.get(WAKKANAI)).toBe(5);
    expect(levels.get("0151200")).toBe(2);
    const expr = warningFill(levels) as unknown[];
    expect(expr).toContain(WARNING_COLORS[5]?.bg);
    expect(expr).toContain(WARNING_COLORS[2]?.bg);
    expect(WARNING_COLORS[5]?.bg).toBe("rgb(12 0 12)");
    expect(cityLevels([blizzard]).get(WAKKANAI)).toBe(3);
    expect(WARNING_COLORS[3]?.bg).toBe("rgb(255 40 0)");
  });

  test("住んでいる地域の大雪警報・暴風雪警報は警報の段で知らせ、読み上げは電文の名前のまま", () => {
    for (const [w, name] of [
      [snow, "大雪警報"],
      [blizzard, "暴風雪警報"],
    ] as const) {
      const n = notice(w, WAKKANAI);
      expect(n?.level).toBe(3);
      expect(n?.title).toEndWith(`稚内市に${name}`);
      expect(n && matches(n, prefs({ home: homeAt(WAKKANAI) }))).toBe(true);
      if (!n) throw new Error("通知が無い");
      const parts = readoutOf(n);
      expect(parts.slice(0, 2)).toEqual([
        OPENINGS.weatherWarning,
        `稚内市には、${name}が出ています。`,
      ]);
      expect(parts.slice(2)).toEqual(sentences(clean(w.headline)));
      const all = readoutCandidates(noticeOf(ev(w), at(w))!);
      for (const p of parts) expect(all).toContain(p);
    }
  });

  test("大雪特別警報・暴風雪特別警報は、住んでいる地域でなくても特別警報の段で知らせる", () => {
    for (const [w, name] of [
      [snowSpecial, "大雪特別警報"],
      [blizzardSpecial, "暴風雪特別警報"],
    ] as const) {
      const far = "1310100"; // 東京都千代田区
      const n = notice(w, far);
      expect(n?.tag).toBe(`warning:special:011000:${w.code}`);
      expect(n?.level).toBe(5);
      expect(n?.title).toBe(`宗谷地方に${name}`);
      expect(n?.urgency).toBe("high");
      expect(n?.sticky).toBe(true);
      expect(n && matches(n, prefs({ home: homeAt(far) }))).toBe(true);
      // 地域を選んでいなくても
      expect(notice(w, null)?.level).toBe(5);
      if (!n) throw new Error("通知が無い");
      const parts = readoutOf(n);
      expect(parts.slice(0, 2)).toEqual([
        OPENINGS.weatherSpecial,
        `宗谷地方に、${name}が出ています。`,
      ]);
    }
  });

  test("風雪注意報・なだれ注意報・着雪注意報は注意報の段 (住んでいる地域だけ。全国では知らせない)", () => {
    const fusetsu = blizzard.areas.find(
      (a) => areaLevel(a) === 2 && a.kinds.some((k) => k.name === "風雪注意報"),
    );
    if (!fusetsu) throw new Error("風雪注意報だけの市町村が無い");
    const n = notice(blizzard, fusetsu.code);
    expect(n?.level).toBe(2);
    expect(n?.title).toContain("風雪注意報");
    // 住んでいる地域でなければ知らせない
    expect(notice(blizzard, "1310100")).toBeNull();
    for (const name of ["なだれ注意報", "着雪注意報"]) {
      const city = other.areas.find((a) =>
        a.kinds.some((k) => k.name === name),
      );
      if (!city) throw new Error(`${name}の市町村が無い`);
      const m = notice(other, city.code);
      expect(m?.level).toBe(2);
      expect(m?.body).toContain(name);
    }
  });
});
