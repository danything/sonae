import { describe, expect, test } from "bun:test";

import { alertFor } from "#lib/alert.ts";
import { byPrefecture, type Cities, cityAt, homeOf } from "#lib/home.ts";
import type { SonaeEvent, WeatherInfo, WeatherWarning } from "#lib/model.ts";
import { matches, noticeFor, noticeOf } from "#lib/notify.ts";
import { DEFAULT_PREFS, type Home, type PushPrefs } from "#lib/push.ts";
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
    expect(n?.url).toBe("/?k=weather&w=office-320000");
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

  test("特別警報は、住んでいる地域でなくても知らせる (切れる)", () => {
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
    // 切ってあれば知らせない
    expect(notice(special, prefs({ weatherSpecial: false }))).toBeNull();
  });

  test("住んでいる地域が特別警報なら、地域の通知で言う", () => {
    const n = notice(special, prefs({ home: home() }));
    expect(n?.tag).toBe("warning:3220100:VPWW55");
    expect(n?.title).toBe("島根県松江市にレベル5大雨特別警報");
    expect(n?.sticky).toBe(true);
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
