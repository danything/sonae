import { describe, expect, test } from "bun:test";

import { alertFor } from "#lib/alert.ts";
import { byPrefecture, type Cities, cityAt, homeOf } from "#lib/home.ts";
import {
  areaLevel,
  type SonaeEvent,
  type WeatherInfo,
  type WeatherWarning,
} from "#lib/model.ts";
import { matches, noticeFor, noticeOf } from "#lib/notify.ts";
import {
  DEFAULT_PREFS,
  type Home,
  normalizePrefs,
  type PushPrefs,
} from "#lib/push.ts";
import {
  clean,
  isFixed,
  OPENINGS,
  readoutCandidates,
  readoutOf,
  sentences,
} from "#lib/readout.ts";
import { parseWeatherXml } from "#lib/server/sources/jma-weather.ts";

import { fixture } from "./helpers.ts";

function warning(file: string, code: string, patch = (s: string) => s) {
  const [item] = parseWeatherXml(patch(fixture(`jma/${file}`)), code);
  if (item?.type !== "warning") throw new Error("警報・注意報ではありません");
  return { ...item.warning, updatedAt: "" } as WeatherWarning;
}
function info(file: string, code: string) {
  const [item] = parseWeatherXml(fixture(`jma/${file}`), code);
  if (item?.type !== "weather") throw new Error("気象の報ではありません");
  return { ...item.info, cancelled: false, updatedAt: "" } as WeatherInfo;
}
const ev = (data: WeatherWarning): SonaeEvent => ({
  seq: 1,
  type: "warning",
  data,
});

/** 島根県の大雨 (松江市にレベル３大雨警報、隠岐の島町はレベル２大雨注意報の解除) */
const SHIMANE_AT = Date.parse("2024-11-02T11:30:00+09:00");
const shimane = warning("15_17_01_251222_VPWW55.xml", "VPWW55");
/** 同じ電文の大雨警報を大雨特別警報に書き換えた作り物 (特別警報のサンプル電文が無いため) */
const special = warning("15_17_01_251222_VPWW55.xml", "VPWW55", (s) =>
  s.replace(
    /<Name>レベル３大雨警報<\/Name>\s*<Code>03<\/Code>/g,
    "<Name>レベル５大雨特別警報</Name><Code>33</Code>",
  ),
);

const home = (patch: Partial<Home> = {}): Home => ({
  code: "3220100",
  name: "島根県松江市",
  quake: { code: "570", name: "島根県東部" },
  office: "320000",
  ichiji: "320010",
  ...patch,
});
const prefs = (patch: Partial<PushPrefs> = {}): PushPrefs => ({
  ...DEFAULT_PREFS,
  ...patch,
});

function notice(w: WeatherWarning, p: PushPrefs, now = SHIMANE_AT) {
  const base = noticeOf(ev(w), now);
  if (!base) throw new Error("通知の元が無い");
  return noticeFor(base, p);
}

describe("気象警報・注意報の通知", () => {
  test("住んでいる地域の警報は知らせる。地域を選んでいなければ知らせない", () => {
    const n = notice(shimane, prefs({ home: home() }));
    expect(n?.tag).toBe("warning:3220100:VPWW55");
    expect(n?.level).toBe(3);
    expect(n?.title).toBe("島根県松江市にレベル3大雨警報");
    expect(n?.url).toBe("/?w=office-320000");
    expect(n && matches(n, prefs({ home: home() }))).toBe(true);
    expect(notice(shimane, prefs())).toBeNull();
  });

  test("注意報は既定では知らせない。「注意報も」なら知らせる", () => {
    const w: WeatherWarning = {
      ...shimane,
      areas: [
        {
          code: "3220100",
          name: "松江市",
          kinds: [
            {
              code: "10",
              name: "レベル２大雨注意報",
              level: 2,
              status: "発表",
            },
          ],
        },
      ],
    };
    const n = notice(w, prefs({ home: home() }));
    expect(n?.level).toBe(2);
    expect(n && matches(n, prefs({ home: home() }))).toBe(false);
    expect(n && matches(n, prefs({ home: home(), weather: "all" }))).toBe(true);
    expect(n && matches(n, prefs({ home: home(), weather: "off" }))).toBe(
      false,
    );
  });

  test("住んでいる地域の解除は、前に知らせた購読にだけ送る (閉じる通知)", () => {
    const oki = home({ code: "3252800", name: "島根県隠岐の島町" });
    const n = notice(shimane, prefs({ home: oki }));
    expect(n?.closing).toBe(true);
    expect(n?.level).toBe(0);
    expect(n?.title).toBe("島根県隠岐の島町の大雨の警報・注意報の解除");
    expect(n && matches(n, prefs({ home: oki }))).toBe(false);
  });

  test("特別警報は、住んでいる地域でなくても知らせる (いつも)", () => {
    const far = home({ code: "1310100", name: "東京都千代田区" });
    const n = notice(special, prefs({ home: far }));
    expect(n?.tag).toBe("warning:special:320000:VPWW55");
    expect(n?.level).toBe(5);
    expect(n?.title).toBe("島根県にレベル5大雨特別警報");
    expect(n?.urgency).toBe("high");
    expect(n?.sticky).toBe(true);
    expect(n && matches(n, prefs({ home: far }))).toBe(true);
    // 地域を選んでいなくても
    expect(notice(special, prefs())?.level).toBe(5);
    // 前のスイッチを切ってあった条件 (保存済みの false) でも知らせる
    const old = normalizePrefs({
      ...prefs({ home: far }),
      weatherSpecial: false,
    });
    const m = notice(special, old);
    expect(m?.level).toBe(5);
    expect(m && matches(m, old)).toBe(true);
  });

  test("同じ府県予報区のほかの市町村に特別警報が出ていたら、住んでいる地域の tag のまま特別警報を言う", () => {
    // 奥出雲町はレベル２大雨注意報、ほかの市町村に大雨特別警報
    const okuizumo = home({ code: "3234300", name: "島根県奥出雲町" });
    const n = notice(special, prefs({ home: okuizumo }));
    expect(n?.tag).toBe("warning:3234300:VPWW55");
    expect(n?.level).toBe(5);
    expect(n?.title).toBe("島根県にレベル5大雨特別警報");
    expect(n?.body).toContain("島根県奥出雲町: レベル2大雨注意報");
    expect(n && matches(n, prefs({ home: okuizumo, weather: "off" }))).toBe(
      true,
    );
    // 解除された市町村でも、特別警報を言いながら解除を添える (解除を落とさない)
    const oki = home({ code: "3252800", name: "島根県隠岐の島町" });
    const m = notice(special, prefs({ home: oki }));
    expect(m?.tag).toBe("warning:3252800:VPWW55");
    expect(m?.body).toContain("大雨の警報・注意報は解除");
    expect(m?.closing).toBe(false);
    // 特別警報が終わったら、住んでいる地域だけの中身に戻る (同じ tag)
    expect(notice(shimane, prefs({ home: okuizumo }))?.tag).toBe(
      "warning:3234300:VPWW55",
    );
  });

  test("住んでいる地域が特別警報なら、地域の通知で言う", () => {
    const n = notice(special, prefs({ home: home() }));
    expect(n?.tag).toBe("warning:3220100:VPWW55");
    expect(n?.title).toBe("島根県松江市にレベル5大雨特別警報");
    expect(n?.sticky).toBe(true);
    // 特別警報はいつも知らせるので、住んでいる地域の気象を「知らせない」にしてあっても知らせる
    expect(n && matches(n, prefs({ home: home(), weather: "off" }))).toBe(true);
  });

  test("6 時間より古い報は知らせない (起動したときの埋め直し)", () => {
    expect(noticeOf(ev(shimane), SHIMANE_AT + 7 * 60 * 60_000)).toBeNull();
  });

  test("開いている画面の音も同じ判定。同じ中身では鳴らし直さない", () => {
    const sent = new Map();
    const p = prefs({ home: home() });
    expect(alertFor(ev(shimane), SHIMANE_AT, p, sent)?.title).toBe(
      "島根県松江市にレベル3大雨警報",
    );
    expect(alertFor(ev(shimane), SHIMANE_AT, p, sent)).toBeNull();
    // 特別警報に上がったら鳴らし直す
    expect(alertFor(ev(special), SHIMANE_AT, p, sent)?.level).toBe(5);
  });
});

describe("記録的短時間大雨情報・竜巻注意情報の通知", () => {
  const rain = info("18_03_01_190412_VPOA50.xml", "VPOA50");
  const rainAt = Date.parse(rain.reportedAt) + 60_000;
  const sapporo: Home = {
    code: "0110000",
    name: "北海道札幌市",
    quake: { code: "101", name: "石狩地方北部" },
    office: "016010",
    ichiji: "016010",
  };
  const ev2 = (data: WeatherInfo): SonaeEvent => ({
    seq: 1,
    type: "weather",
    data,
  });

  test("住んでいる地域 (一次細分区域) が対象なら知らせる", () => {
    const base = noticeOf(ev2(rain), rainAt);
    if (!base) throw new Error("通知の元が無い");
    const n = noticeFor(base, prefs({ home: sapporo }));
    expect(n?.title).toBe("記録的短時間大雨情報 北海道札幌市");
    expect(n?.body).toContain("札幌市中央区付近で約１００ミリ");
    expect(n && matches(n, prefs({ home: sapporo }))).toBe(true);
    expect(n && matches(n, prefs({ home: sapporo, weather: "off" }))).toBe(
      false,
    );
    // ほかの地域は関係ない
    expect(noticeFor(base, prefs({ home: home() }))).toBeNull();
  });

  test("竜巻注意情報は有効期限を過ぎたら知らせない。洪水予報・熱中症・台風は知らせない", () => {
    const tornado = info("19_08_03_250630_VPHW50.xml", "VPHW50");
    const at = Date.parse("2015-07-17T09:30:00+09:00");
    expect(noticeOf(ev2(tornado), at)).not.toBeNull();
    expect(
      noticeOf(ev2(tornado), Date.parse("2015-07-17T10:31:00+09:00")),
    ).toBeNull();
    const flood = info("16_09_01_260312_VXKOii.xml", "VXKO53");
    expect(
      noticeOf(ev2(flood), Date.parse(flood.reportedAt) + 60_000),
    ).toBeNull();
  });
});

describe("住んでいる地域を選ぶ", () => {
  const cities: Cities = {
    "3220100": ["松江市", "島根県松江市", "320000", "320010", "320011", "570"],
    "3220300": ["出雲市", "島根県出雲市", "320000", "320010", "320012", "570"],
    "1310100": [
      "千代田区",
      "東京都千代田区",
      "130000",
      "130010",
      "130011",
      "350",
    ],
  };
  test("市町村等の表から、地震情報／細分区域と府県予報区を引く", () => {
    expect(homeOf("3220100", cities, new Map([["570", "島根県東部"]]))).toEqual(
      {
        code: "3220100",
        name: "島根県松江市",
        quake: { code: "570", name: "島根県東部" },
        office: "320000",
        ichiji: "320010",
      },
    );
    expect(homeOf("9999999", cities, new Map())).toBeNull();
  });
  test("都道府県ごとに束ねる", () => {
    expect(byPrefecture(cities).map((g) => [g.pref, g.cities.length])).toEqual([
      ["東京都", 1],
      ["島根県", 2],
    ]);
  });
  test("位置が入る市町村等 (穴は外す)", () => {
    const features = [
      {
        properties: { code: "1" },
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
              [0, 0],
            ],
            [
              [4, 4],
              [6, 4],
              [6, 6],
              [4, 6],
              [4, 4],
            ],
          ] as [number, number][][],
        },
      },
    ];
    expect(cityAt(2, 2, features)).toBe("1");
    expect(cityAt(5, 5, features)).toBeNull();
    expect(cityAt(20, 20, features)).toBeNull();
  });
});

describe("気象の読み上げ", () => {
  test("住んでいる地域の警報: 決まった文、電文の市町村の名前と種類、気象庁の見出しのまま", () => {
    const n = notice(shimane, prefs({ home: home() }));
    if (!n) throw new Error("通知が無い");
    const parts = readoutOf(n);
    expect(parts[0]).toBe(OPENINGS.weatherWarning);
    expect(parts[1]).toBe("松江市には、レベル3大雨警報が出ています。");
    expect(parts.slice(2)).toEqual(sentences(clean(shimane.headline)));
    // 住んでいる地域の名前 (端末ごとに違う) は読まない。サーバーが通す文の中にある
    expect(parts.join("")).not.toContain("島根県松江市");
    const candidates = readoutCandidates(noticeOf(ev(shimane), SHIMANE_AT)!);
    for (const p of parts) expect(candidates).toContain(p);
  });

  test("土砂災害危険警報 (前の土砂災害警戒情報) は危険警報の決まった文", () => {
    const sabo = warning("15_16_01_241031_VPWW56.xml", "VPWW56");
    const wakkanai = sabo.areas.find((a) => a.name === "稚内市");
    if (!wakkanai) throw new Error("稚内市が無い");
    const at = Date.parse(sabo.reportedAt) + 60_000;
    const base = noticeOf(ev(sabo), at);
    if (!base) throw new Error("通知の元が無い");
    const n = noticeFor(
      base,
      prefs({
        home: home({
          code: wakkanai.code,
          name: "北海道稚内市",
          office: "011000",
          ichiji: "011011",
        }),
      }),
    );
    if (!n) throw new Error("通知が無い");
    const parts = readoutOf(n);
    expect(parts.slice(0, 2)).toEqual([
      OPENINGS.weatherDanger,
      "稚内市には、レベル4土砂災害危険警報が出ています。",
    ]);
    for (const p of parts) expect(readoutCandidates(base)).toContain(p);
  });

  test("特別警報: 府県予報区と種類、対象の市町村。住んでいる地域がそこなら地域の種類も", () => {
    const sp = notice(special, prefs({ home: home({ code: "3220500" }) }));
    if (!sp) throw new Error("通知が無い");
    const parts = readoutOf(sp);
    expect(parts[0]).toBe(OPENINGS.weatherSpecial);
    expect(parts[1]).toBe("島根県に、レベル5大雨特別警報が出ています。");
    expect(parts[2]).toStartWith("対象の市町村は、松江市");
    const all = readoutCandidates(noticeOf(ev(special), SHIMANE_AT)!);
    for (const p of parts) expect(all).toContain(p);
    // 特別警報の出ていない市町村に住んでいても、特別警報と自分の地域の文がどれも通る
    const other = special.areas.find((a) => areaLevel(a) < 5);
    if (other) {
      const mixed = notice(
        special,
        prefs({ home: home({ code: other.code }) }),
      );
      if (!mixed) throw new Error("通知が無い");
      expect(mixed.special).toBe(true);
      for (const p of readoutOf(mixed)) expect(all).toContain(p);
    }
    // 地域を選んでいなくても、特別警報は読む
    const anywhere = notice(special, prefs());
    expect(anywhere && readoutOf(anywhere)[0]).toBe(OPENINGS.weatherSpecial);
  });

  test("記録的短時間大雨情報・竜巻注意情報は、決まった文と気象庁の見出しだけ。竜巻は有効期限を足す", () => {
    const rain = info("18_03_01_190412_VPOA50.xml", "VPOA50");
    const r = noticeOf(
      { seq: 1, type: "weather", data: rain },
      Date.parse(rain.reportedAt) + 60_000,
    );
    if (!r) throw new Error("通知が無い");
    expect(readoutOf(r)).toEqual([
      OPENINGS.recordRain,
      ...sentences(clean(rain.headline)),
    ]);
    expect(readoutOf(r).join("")).toContain("札幌市中央区付近で約100ミリ");
    const tornado = info("19_08_03_250630_VPHW50.xml", "VPHW50");
    const t = noticeOf(
      { seq: 1, type: "weather", data: tornado },
      Date.parse("2015-07-17T09:30:00+09:00"),
    );
    if (!t) throw new Error("通知が無い");
    const parts = readoutOf(t);
    expect(parts[0]).toBe(OPENINGS.tornado);
    expect(parts).toContain(
      "埼玉県南部、北部は、竜巻などの激しい突風が発生しやすい気象状況になっています。",
    );
    expect(parts.at(-1)).toMatch(/^この情報は\d+時\d+分まで有効です。$/);
  });

  test("決まった文は前もって合成する文に入っている", () => {
    for (const k of [
      "weatherSpecial",
      "weatherDanger",
      "weatherWarning",
      "weatherAdvisory",
      "recordRain",
      "tornado",
    ] as const)
      expect(isFixed(OPENINGS[k])).toBe(true);
  });
});
