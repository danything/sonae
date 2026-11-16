import { describe, expect, test } from "bun:test";

import {
  groupAlerts,
  parseAlertSettings,
  planAlert,
  planAlerts,
  planEntry,
} from "#lib/alert.ts";
import { type AreaFeature, createHereFinder, featureAt } from "#lib/home.ts";
import type { SonaeEvent, WeatherInfo, WeatherWarning } from "#lib/model.ts";
import type { Sent } from "#lib/notify.ts";
import { DEFAULT_PREFS, type Home, type PushPrefs } from "#lib/push.ts";
import { HERE, isFixed, readoutOf, readoutOfAll } from "#lib/readout.ts";
import { parseWeatherXml } from "#lib/server/sources/jma-weather.ts";

import { NOW, quake } from "./events.ts";
import { fixture } from "./helpers.ts";

function warning(patch = (s: string) => s): WeatherWarning {
  const [item] = parseWeatherXml(
    patch(fixture("jma/15_17_01_251222_VPWW55.xml")),
    "VPWW55",
  );
  if (item?.type !== "warning") throw new Error("警報・注意報ではありません");
  return { ...item.warning, updatedAt: "" } as WeatherWarning;
}
const ev = (data: WeatherWarning): SonaeEvent => ({
  seq: 1,
  type: "warning",
  data,
});

/** 島根県の大雨 (松江市・出雲市にレベル３大雨警報、奥出雲町はレベル２大雨注意報) */
const AT = Date.parse("2024-11-02T11:30:00+09:00");
const shimane = warning();
/** 大雨警報を大雨特別警報に書き換えた作り物 (奥出雲町は注意報のまま) */
const special = warning((s) =>
  s.replace(
    /<Name>レベル３大雨警報<\/Name>\s*<Code>03<\/Code>/g,
    "<Name>レベル５大雨特別警報</Name><Code>33</Code>",
  ),
);

const city = (code: string, name: string): Home => ({
  code,
  name,
  quake: null,
  office: "320000",
  ichiji: "320010",
});
const matsue = city("3220100", "島根県松江市");
const izumo = city("3220300", "島根県出雲市");
const okuizumo = city("3234300", "島根県奥出雲町");
const chiyoda: Home = {
  ...city("1310100", "東京都千代田区"),
  office: "130000",
};

const prefs = (patch: Partial<PushPrefs> = {}): PushPrefs => ({
  ...DEFAULT_PREFS,
  ...patch,
});

describe("開いているときは、現在地の気象も知らせる", () => {
  test("住んでいる地域を選んでいなくても、現在地の警報は「現在地の」と付けて知らせる", () => {
    const sent = new Map<string, Sent>();
    const plans = planAlerts(ev(shimane), AT, prefs(), sent, matsue);
    expect(plans).toHaveLength(1);
    const n = plans[0]?.notice;
    expect(n?.tag).toBe("warning:3220100:VPWW55");
    expect(n?.title).toBe("現在地の島根県松江市にレベル3大雨警報");
    expect(n?.here).toBe(true);
    expect(plans[0]?.renotify).toBe(true);
    // 読み上げは、地域の文の前に現在地と言う (地域は電文の名前のまま)
    const parts = n ? readoutOf(n) : [];
    const at = parts.indexOf(HERE);
    expect(at).toBeGreaterThan(0);
    expect(parts[at + 1]).toBe("松江市には、レベル3大雨警報が出ています。");
    // 現在地の文は合成しておく決まった文
    expect(isFixed(HERE)).toBe(true);
    // 同じ中身では鳴らし直さない
    expect(planAlerts(ev(shimane), AT, prefs(), sent, matsue)).toEqual([]);
  });

  test("住んでいる地域は今までどおり (現在地と言わない)", () => {
    const n = planAlert(ev(shimane), AT, prefs({ home: matsue }), new Map());
    expect(n?.notice.title).toBe("島根県松江市にレベル3大雨警報");
    expect(n?.notice.here).toBeUndefined();
    expect(n?.notice ? readoutOf(n.notice) : []).not.toContain(HERE);
  });

  test("現在地が住んでいる地域と同じ市町村なら、住んでいる地域の通知 1 つだけ", () => {
    const plans = planAlerts(
      ev(shimane),
      AT,
      prefs({ home: matsue }),
      new Map(),
      matsue,
    );
    expect(plans.map((p) => p.notice.title)).toEqual([
      "島根県松江市にレベル3大雨警報",
    ]);
  });

  test("住んでいる地域が遠ければ、現在地だけを知らせる", () => {
    const plans = planAlerts(
      ev(shimane),
      AT,
      prefs({ home: chiyoda }),
      new Map(),
      izumo,
    );
    expect(plans.map((p) => p.notice.title)).toEqual([
      "現在地の島根県出雲市にレベル3大雨警報",
    ]);
  });

  test("両方に当たった報は 1 度だけ鳴らす (住んでいる地域を鳴らし、現在地は音なしで並べる)", () => {
    const sent = new Map<string, Sent>();
    const p = prefs({ home: matsue });
    const g = groupAlerts(planAlerts(ev(shimane), AT, p, sent, izumo));
    expect(g.ring?.title).toBe("島根県松江市にレベル3大雨警報");
    expect(g.also.map((n) => n.title)).toEqual([
      "現在地の島根県出雲市にレベル3大雨警報",
    ]);
    expect(g.replace).toEqual([]);
    // 読み上げは 1 つの原稿にまとめ、冒頭の文と見出しを 2 度読まない
    const parts = readoutOfAll([g.ring, ...g.also].filter((n) => n !== null));
    expect(parts.filter((s) => s === "気象の警報です。")).toHaveLength(1);
    expect(parts).toContain("松江市には、レベル3大雨警報が出ています。");
    expect(parts.slice(-2)).toEqual([
      HERE,
      "出雲市には、レベル3大雨警報が出ています。",
    ]);
    expect(new Set(parts).size).toBe(parts.length);
    // 同じ報がもう一度届いても、どちらも鳴らさない
    const again = groupAlerts(planAlerts(ev(shimane), AT, p, sent, izumo));
    expect(again.ring).toBeNull();
    expect(again.also).toEqual([]);
  });

  test("重いほうを鳴らす。住んでいる地域が注意報だけなら、「注意報も」のときだけ並べる", () => {
    const home = prefs({ home: okuizumo });
    const g = groupAlerts(planAlerts(ev(shimane), AT, home, new Map(), matsue));
    expect(g.ring?.title).toBe("現在地の島根県松江市にレベル3大雨警報");
    expect(g.also).toEqual([]);

    const all = prefs({ home: okuizumo, weather: "all" });
    const h = groupAlerts(planAlerts(ev(shimane), AT, all, new Map(), matsue));
    expect(h.ring?.title).toBe("現在地の島根県松江市にレベル3大雨警報");
    expect(h.also.map((n) => n.title)).toEqual([
      "島根県奥出雲町にレベル2大雨注意報",
    ]);
    // 読み上げは住んでいる地域を先に、現在地は後ろで「現在地の情報です。」から読む
    const parts = readoutOfAll([h.ring, ...h.also].filter((n) => n !== null));
    expect(parts[0]).toBe("気象の注意報です。");
    expect(parts.indexOf(HERE)).toBeGreaterThan(
      parts.indexOf("奥出雲町には、レベル2大雨注意報が出ています。"),
    );
    expect(parts[parts.indexOf(HERE) + 1]).toBe(
      "松江市には、レベル3大雨警報が出ています。",
    );
  });

  test("現在地の注意報は「注意報も」のときだけ知らせる (住んでいる地域と同じ条件)", () => {
    expect(planAlerts(ev(shimane), AT, prefs(), new Map(), okuizumo)).toEqual(
      [],
    );
    const plans = planAlerts(
      ev(shimane),
      AT,
      prefs({ weather: "all" }),
      new Map(),
      okuizumo,
    );
    expect(plans.map((p) => p.notice.title)).toEqual([
      "現在地の島根県奥出雲町にレベル2大雨注意報",
    ]);
    const n = plans[0]?.notice;
    expect(n ? readoutOf(n) : []).toContain(HERE);
    // 「知らせない」なら現在地も知らせない
    expect(
      planAlerts(ev(shimane), AT, prefs({ weather: "off" }), new Map(), matsue),
    ).toEqual([]);
  });

  test("どこかの特別警報は 1 度だけ。現在地が同じ府県予報区なら、現在地の状態を添えたほうも音なしで並べる", () => {
    const sent = new Map<string, Sent>();
    const p = prefs({ home: chiyoda });
    const g = groupAlerts(planAlerts(ev(special), AT, p, sent, okuizumo));
    expect(g.ring?.tag).toBe("warning:special:320000:VPWW55");
    expect(g.also.map((n) => n.tag)).toEqual(["warning:3234300:VPWW55"]);
    expect(g.also[0]?.body).toContain(
      "現在地の島根県奥出雲町: レベル2大雨注意報",
    );
    // 見出しは府県予報区の名前になるので、現在地の通知と分かるように添える
    expect(g.also[0]?.title).toBe(
      "島根県にレベル5大雨特別警報 (現在地を含む地域)",
    );
    const parts = readoutOfAll([g.ring, ...g.also].filter((n) => n !== null));
    expect(parts.filter((s) => s === "気象の特別警報です。")).toHaveLength(1);
    expect(parts).toContain(HERE);

    // 現在地がほかの府県予報区なら、特別警報の通知 1 つだけ (同じ tag は控えで 1 度)
    const far = groupAlerts(
      planAlerts(ev(special), AT, prefs(), new Map(), chiyoda),
    );
    expect(far.ring?.tag).toBe("warning:special:320000:VPWW55");
    expect(far.also).toEqual([]);
  });

  test("気象でない報は、現在地で増えない", () => {
    const plans = planAlerts(quake(), NOW, prefs(), new Map(), matsue);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.notice.here).toBeUndefined();
  });

  test("記録的短時間大雨情報は、住んでいる地域が対象なら現在地を足さない", () => {
    const [item] = parseWeatherXml(
      fixture("jma/18_03_01_190412_VPOA50.xml"),
      "VPOA50",
    );
    if (item?.type !== "weather") throw new Error("気象の報ではありません");
    const rain = {
      ...item.info,
      cancelled: false,
      updatedAt: "",
    } as WeatherInfo;
    const e: SonaeEvent = { seq: 1, type: "weather", data: rain };
    const at = Date.parse(rain.reportedAt) + 60_000;
    const sapporo: Home = {
      code: "0110000",
      name: "北海道札幌市",
      quake: null,
      office: "016000",
      ichiji: "016010",
    };
    const ebetsu: Home = { ...sapporo, code: "0121700", name: "北海道江別市" };
    const both = planAlerts(e, at, prefs({ home: sapporo }), new Map(), ebetsu);
    expect(both.map((p) => p.notice.title)).toEqual([
      "記録的短時間大雨情報 北海道札幌市",
    ]);
    const hereOnly = planAlerts(e, at, prefs(), new Map(), ebetsu);
    expect(hereOnly.map((p) => p.notice.title)).toEqual([
      "記録的短時間大雨情報 現在地の北海道江別市",
    ]);
    const n = hereOnly[0]?.notice;
    expect(n ? readoutOf(n).slice(0, 2) : []).toEqual([
      "記録的短時間大雨情報です。",
      HERE,
    ]);
  });

  test("スイッチは既定でオン (覚えていなければ無し)。読めない値は無し", () => {
    expect(parseAlertSettings("{}").here).toBeUndefined();
    expect(parseAlertSettings('{"here":false}').here).toBe(false);
    expect(parseAlertSettings('{"here":"no"}').here).toBeUndefined();
  });
});

describe("現在地が入る市町村等を探し直す", () => {
  const square = (code: string, x: number): AreaFeature => ({
    properties: { code },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [x, 0],
          [x + 1, 0],
          [x + 1, 1],
          [x, 1],
          [x, 0],
        ],
      ],
    },
  });

  test("前の面の中にいる間は面を引き直さず、出たら探し直す。どこにも入らなければ null", () => {
    let looked = 0;
    const areas = [square("A", 0), square("B", 1)];
    // 全部の面を引いたかを数える (前の面の中なら、面の一覧を見ない)
    const counted = new Proxy(areas, {
      get(t, k, r) {
        if (k === "find") looked++;
        return Reflect.get(t, k, r);
      },
    });
    const find = createHereFinder(counted);
    expect(find(0.5, 0.5)).toBe("A");
    expect(looked).toBe(1);
    expect(find(0.6, 0.4)).toBe("A");
    expect(looked).toBe(1);
    expect(find(0.5, 1.5)).toBe("B");
    expect(looked).toBe(2);
    expect(find(0.5, 5)).toBeNull();
    expect(featureAt(0.5, 1.5, areas)?.properties.code).toBe("B");
  });
});

describe("現在地が別の市町村等に替わったとき", () => {
  /** 松江市の大雨警報が解除された報 (ほかの市町村等はそのまま) */
  const matsueArea = shimane.areas.find((a) => a.code === matsue.code);
  if (!matsueArea) throw new Error("松江市がありません");
  const released: WeatherWarning = {
    ...shimane,
    areas: shimane.areas.filter((a) => a.code !== matsue.code),
    released: [matsueArea],
  };

  test("入った市町村等にもう出ている警報を 1 度知らせる (同じ中身は鳴らし直さない)", () => {
    const sent = new Map<string, Sent>();
    const g = groupAlerts(planEntry([shimane], prefs(), sent, izumo));
    expect(g.ring?.title).toBe("現在地の島根県出雲市にレベル3大雨警報");
    expect(g.ring?.here).toBe(true);
    // 境目で行き来しても、戻ってきても鳴らし直さない
    expect(planEntry([shimane], prefs(), sent, izumo)).toEqual([]);
    // 入った後に同じ中身の報が届いても鳴らさない
    expect(planAlerts(ev(shimane), AT, prefs(), sent, izumo)).toEqual([]);
  });

  test("報が古くても、出ている警報は知らせる", () => {
    const old = { ...shimane, reportedAt: "2024-11-01T00:00:00+09:00" };
    const plans = planEntry([old], prefs(), new Map(), matsue);
    expect(plans.map((p) => p.notice.title)).toEqual([
      "現在地の島根県松江市にレベル3大雨警報",
    ]);
  });

  test("段は住んでいる地域と同じ。注意報は「注意報も」のときだけ", () => {
    expect(planEntry([shimane], prefs(), new Map(), okuizumo)).toEqual([]);
    expect(
      planEntry([shimane], prefs({ weather: "all" }), new Map(), okuizumo).map(
        (p) => p.notice.title,
      ),
    ).toEqual(["現在地の島根県奥出雲町にレベル2大雨注意報"]);
    expect(
      planEntry([shimane], prefs({ weather: "off" }), new Map(), matsue),
    ).toEqual([]);
  });

  test("住んでいる地域と同じ市町村等なら足さない。警報の出ていない市町村等は何も無い", () => {
    expect(
      planEntry([shimane], prefs({ home: matsue }), new Map(), matsue),
    ).toEqual([]);
    expect(planEntry([shimane], prefs(), new Map(), chiyoda)).toEqual([]);
  });

  test("出た市町村等の解除は、出ていた通知を鳴らさずに置き換える", () => {
    const sent = new Map<string, Sent>();
    planAlerts(ev(shimane), AT, prefs(), sent, matsue);
    // 出雲市へ移り (そこの警報を知らせた)、その後に松江市の警報が解除された
    expect(planEntry([shimane], prefs(), sent, izumo)).toHaveLength(1);
    const g = groupAlerts(
      planAlerts(ev(released), AT, prefs(), sent, izumo, [matsue]),
    );
    expect(g.ring).toBeNull();
    expect(g.replace.map((n) => n.tag)).toEqual(["warning:3220100:VPWW55"]);
    const n = g.replace[0];
    expect(n?.closing).toBe(true);
    // もういないので「現在地の」と言わない
    expect(n?.title.startsWith("島根県松江市の")).toBe(true);
    expect(n?.here).toBeUndefined();
    // 同じ報がもう一度届いても置き換えない
    expect(
      planAlerts(ev(released), AT, prefs(), sent, izumo, [matsue]),
    ).toEqual([]);
  });

  test("出た市町村等で知らせていないものは足さず、重さが上がっても鳴らさない", () => {
    // 知らせていない (控えが無い) 所は置き換えるものが無い
    expect(
      planAlerts(ev(released), AT, prefs(), new Map(), null, [okuizumo]),
    ).toEqual([]);
    const sent = new Map<string, Sent>();
    planAlerts(ev(shimane), AT, prefs(), sent, matsue);
    const g = groupAlerts(
      planAlerts(ev(special), AT, prefs(), sent, chiyoda, [matsue]),
    );
    // 特別警報の通知は鳴らし、松江市の通知は音なしで置き換えるだけ
    expect(g.ring?.tag).toBe("warning:special:320000:VPWW55");
    expect(g.also).toEqual([]);
    expect(g.replace.map((n) => n.tag)).toEqual(["warning:3220100:VPWW55"]);
  });
});
