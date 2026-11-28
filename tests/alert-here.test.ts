import { describe, expect, test } from "bun:test";

import {
  groupAlerts,
  parseAlertSettings,
  planAlert,
  planAlerts,
  planEntry,
} from "#lib/alert.ts";
import { type AreaFeature, createHereFinder, featureAt } from "#lib/home.ts";
import type { WeatherWarning } from "#lib/model.ts";
import { ADVISORY_QUOTA, noticeOf, type Sent } from "#lib/notify.ts";
import { HERE, isFixed, readoutOf, readoutOfAll } from "#lib/readout.ts";

import {
  NOW,
  prefs,
  quake,
  warningEvent as ev,
  weatherEvent,
} from "./events.ts";
import {
  homeAt,
  toSpecialRain,
  weatherInfo,
  weatherWarning,
} from "./helpers.ts";

const RAIN = "15_17_01_251222_VPWW55.xml";

/** 島根県の大雨 (松江市・出雲市にレベル３大雨警報、奥出雲町はレベル２大雨注意報) */
const AT = Date.parse("2024-11-02T11:30:00+09:00");
const shimane = weatherWarning(RAIN, "VPWW55");
/** 大雨警報を大雨特別警報に書き換えた作り物 (奥出雲町は注意報のまま) */
const special = weatherWarning(RAIN, "VPWW55", toSpecialRain);

const matsue = homeAt("3220100");
const izumo = homeAt("3220300");
const okuizumo = homeAt("3234300");
const chiyoda = homeAt("1310100");

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

  test("重いほうを鳴らす。住んでいる地域の注意報は音なしで並べる", () => {
    for (const weather of ["nearby", "everywhere"] as const) {
      const p = prefs({ home: okuizumo, weather });
      const g = groupAlerts(planAlerts(ev(shimane), AT, p, new Map(), matsue));
      expect(g.ring?.title).toBe("現在地の島根県松江市にレベル3大雨警報");
      expect(g.also.map((n) => [n.level, n.here ?? false])).toEqual([
        [2, false],
      ]);
    }
  });

  test("現在地の注意報も知らせる (住んでいる地域と同じ段。1 日 1 回は現在地で別に数える)", () => {
    for (const weather of ["nearby", "everywhere"] as const) {
      const sent = new Map<string, Sent>();
      const plans = planAlerts(
        ev(shimane),
        AT,
        prefs({ weather }),
        sent,
        okuizumo,
      );
      expect(plans.map((p) => [p.notice.level, p.renotify])).toEqual([
        [2, true],
      ]);
      expect(sent.get(ADVISORY_QUOTA.here)?.digest).toBe("2024-11-02");
      expect(sent.has(ADVISORY_QUOTA.home)).toBe(false);
    }
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

  test("気象でない報も、「住んでいる地域と現在地」の判定には現在地を使う (通知は 1 つのまま)", () => {
    const kashiwa = homeAt("1221700");
    const p = prefs({ quake: "nearby", home: chiyoda });
    // 千代田区 (住んでいる地域。東京都２３区) は揺れておらず当たらない。現在地の柏市 (千葉県北西部、震度 4) で当たる
    const q = quake({
      areas: [{ code: "341", name: "千葉県北西部", int: "4" }],
    });
    expect(planAlerts(q, NOW, p, new Map(), null)).toEqual([]);
    const plans = planAlerts(q, NOW, p, new Map(), kashiwa);
    expect(plans.map((x) => x.notice.tag)).toEqual(["quake:20261114090000"]);
    expect(plans[0]?.notice.here).toBeUndefined();
  });

  test("記録的短時間大雨情報は、住んでいる地域が対象なら現在地を足さない", () => {
    const rain = weatherInfo("18_03_01_190412_VPOA50.xml", "VPOA50");
    const e = weatherEvent(rain);
    const at = Date.parse(rain.reportedAt) + 60_000;
    // 札幌市と江別市は同じ一次細分区域 (石狩地方)
    const sapporo = homeAt("0110000");
    const ebetsu = homeAt("0121700");
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

  test("線状降水帯 (気象防災速報) も、現在地の一次細分区域に出たら知らせる", () => {
    const lines = weatherInfo("82_01_01_260324_VPBS50.xml", "VPBS50");
    const e = weatherEvent(lines);
    const at = Date.parse(lines.reportedAt) + 60_000;
    // 船橋市は千葉県北西部。住んでいる地域 (千代田区) には出ていない
    const hereOnly = planAlerts(
      e,
      at,
      prefs({ home: homeAt("1310100") }),
      new Map(),
      homeAt("1220400"),
    );
    expect(hereOnly.map((p) => p.notice.title)).toEqual([
      "気象防災速報 (線状降水帯発生) 現在地の千葉県船橋市",
    ]);
    const n = hereOnly[0]?.notice;
    expect(n ? readoutOf(n).slice(0, 2) : []).toEqual([
      "気象防災速報です。",
      HERE,
    ]);
  });

  test("線状降水帯の直前の予測と発生は、題の情報タグで見分けられる", () => {
    const lines = weatherInfo("82_01_01_260324_VPBS50.xml", "VPBS50");
    const soon = {
      ...lines,
      id: `${lines.id}-soon`,
      kindName: "線状降水帯直前",
    };
    const at = Date.parse(lines.reportedAt) + 60_000;
    const titles = [lines, soon].map(
      (i) =>
        planAlerts(
          weatherEvent(i),
          at,
          prefs({ home: homeAt("1220400") }),
          new Map(),
        )[0]?.notice.title,
    );
    expect(titles[0]).toContain("(線状降水帯発生)");
    expect(titles[1]).toContain("(線状降水帯直前)");
  });

  test("原報から 1 時間より後に出た取消も、取消を受けた時刻で古さを見て知らせる", () => {
    const lines = weatherInfo("82_01_01_260324_VPBS50.xml", "VPBS50");
    const at = Date.parse(lines.reportedAt) + 62 * 60_000;
    const cancelled = {
      ...lines,
      cancelled: true,
      updatedAt: new Date(at - 30_000).toISOString(),
    };
    expect(noticeOf(weatherEvent(cancelled), at)).not.toBeNull();
    // 取消でない報は、原報の時刻で古さを見る (1 時間より古ければ知らせない)
    expect(
      noticeOf(weatherEvent({ ...lines, updatedAt: cancelled.updatedAt }), at),
    ).toBeNull();
  });

  test("前のスイッチ「現在地の気象も知らせる」は読まない (現在地はいつも使う)", () => {
    expect("here" in parseAlertSettings('{"here":false}')).toBe(false);
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
    const g = groupAlerts(planEntry([ev(shimane)], prefs(), sent, izumo));
    expect(g.ring?.title).toBe("現在地の島根県出雲市にレベル3大雨警報");
    expect(g.ring?.here).toBe(true);
    // 境目で行き来しても、戻ってきても鳴らし直さない
    expect(planEntry([ev(shimane)], prefs(), sent, izumo)).toEqual([]);
    // 入った後に同じ中身の報が届いても鳴らさない
    expect(planAlerts(ev(shimane), AT, prefs(), sent, izumo)).toEqual([]);
  });

  test("報が古くても、出ている警報は知らせる", () => {
    const old = { ...shimane, reportedAt: "2024-11-01T00:00:00+09:00" };
    const plans = planEntry([ev(old)], prefs(), new Map(), matsue);
    expect(plans.map((p) => p.notice.title)).toEqual([
      "現在地の島根県松江市にレベル3大雨警報",
    ]);
  });

  test("段は住んでいる地域と同じ。注意報は現在地の 1 日 1 回に数える", () => {
    for (const weather of ["nearby", "everywhere"] as const) {
      const sent = new Map<string, Sent>();
      const p = prefs({ weather });
      expect(
        planEntry([ev(shimane)], p, sent, okuizumo, AT).map(
          (x) => x.notice.level,
        ),
      ).toEqual([2]);
      // 同じ日にもう現在地の注意報を知らせていれば、知らせない
      const counted = new Map<string, Sent>([
        [ADVISORY_QUOTA.here, { level: 0, digest: "2024-11-02" }],
      ]);
      expect(planEntry([ev(shimane)], p, counted, okuizumo, AT)).toEqual([]);
    }
    expect(
      planEntry([ev(shimane)], prefs({ weather: "off" }), new Map(), matsue),
    ).toEqual([]);
  });

  test("住んでいる地域と同じ市町村等なら足さない。警報の出ていない市町村等は何も無い", () => {
    expect(
      planEntry([ev(shimane)], prefs({ home: matsue }), new Map(), matsue),
    ).toEqual([]);
    expect(planEntry([ev(shimane)], prefs(), new Map(), chiyoda)).toEqual([]);
  });

  test("出た市町村等の解除は、出ていた通知を鳴らさずに置き換える", () => {
    const sent = new Map<string, Sent>();
    planAlerts(ev(shimane), AT, prefs(), sent, matsue);
    // 出雲市へ移り (そこの警報を知らせた)、その後に松江市の警報が解除された
    expect(planEntry([ev(shimane)], prefs(), sent, izumo)).toHaveLength(1);
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
