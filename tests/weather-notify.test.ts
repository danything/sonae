import { describe, expect, test } from "bun:test";

import {
  alertFor,
  loadQuota,
  planAlert,
  planAlerts,
  quotaJson,
} from "#lib/alert.ts";
import { jstDate } from "#lib/format.ts";
import {
  areaLevel,
  isNotifiedBosai,
  type SonaeEvent,
  type WarningCode,
  type WeatherWarning,
} from "#lib/model.ts";
import {
  ADVISORY_QUOTA,
  isAdvisoryOnly,
  matches,
  noticeFor,
  noticeOf,
  type Sent,
} from "#lib/notify.ts";
import { type Home, normalizePrefs, type PushPrefs } from "#lib/push.ts";
import {
  clean,
  OPENINGS,
  readoutCandidates,
  readoutOf,
  sentences,
} from "#lib/readout.ts";
import { openDb } from "#lib/server/db.ts";
import {
  planSends,
  type SentLog,
  sentLog,
  undoJob,
} from "#lib/server/notify.ts";

import { prefs, warningEvent as ev, weatherEvent } from "./events.ts";
import {
  homeAt,
  toSpecialRain,
  weatherInfo,
  weatherWarning,
} from "./helpers.ts";

const RAIN = "15_17_01_251222_VPWW55.xml";

/** 島根県の大雨 (松江市にレベル３大雨警報、隠岐の島町はレベル２大雨注意報の解除) */
const SHIMANE_AT = Date.parse("2024-11-02T11:30:00+09:00");
const shimane = weatherWarning(RAIN, "VPWW55");
/** 同じ電文の大雨警報を大雨特別警報に書き換えた作り物 (特別警報のサンプル電文が無いため) */
const special = weatherWarning(RAIN, "VPWW55", toSpecialRain);

/** 住んでいる地域 (既定は松江市)。市町村等の表から引き、`patch` で上書きする */
const home = (patch: Partial<Home> = {}): Home => ({
  ...homeAt(patch.code ?? "3220100"),
  ...patch,
});

/** 松江市に注意報だけが出ている作り物 (種別のコードを替えると別の tag になる) */
function advisory(
  code: WarningCode = "VPWW55",
  name = "レベル２大雨注意報",
  reportedAt = shimane.reportedAt,
): WeatherWarning {
  return {
    ...shimane,
    code,
    reportedAt,
    released: [],
    areas: [
      {
        code: "3220100",
        name: "松江市",
        kinds: [{ code: "10", name, level: 2, status: "発表" }],
      },
    ],
  };
}

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

  test("住んでいる地域の注意報は、「全国」でも「住んでいる地域と現在地」でも知らせる", () => {
    const n = notice(advisory(), prefs({ home: home() }));
    expect(n?.level).toBe(2);
    expect(n && isAdvisoryOnly(n)).toBe(true);
    expect(n && matches(n, prefs({ home: home() }))).toBe(true);
    expect(
      n && matches(n, prefs({ home: home(), weather: "everywhere" })),
    ).toBe(true);
    expect(n && matches(n, prefs({ home: home(), weather: "off" }))).toBe(
      false,
    );
    // ほかの市町村の注意報は知らせない (全国の注意報は出さない)
    const far = home({ code: "3220200" });
    expect(
      notice(advisory(), prefs({ home: far, weather: "everywhere" })),
    ).toBeNull();
  });

  test("注意報だけの通知は日本時間の 1 日 1 回まで。警報に上がったものと続報は数えない (開いている画面)", () => {
    const p = prefs({ home: home() });
    const sent = new Map<string, Sent>();
    const plan = (w: WeatherWarning, now: number) =>
      planAlert(ev(w), now, p, sent);
    // 1 回目は鳴らす
    expect(plan(advisory(), SHIMANE_AT)?.renotify).toBe(true);
    expect(sent.get(ADVISORY_QUOTA.home)?.digest).toBe("2024-11-02");
    // 同じ注意報の続報 (見出しが変わった) は鳴らさずに置き換える (数えない)
    const again = plan(
      { ...advisory(), headline: "続報の見出し" },
      SHIMANE_AT + 60_000,
    );
    expect(again?.renotify).toBe(false);
    // 同じ日の別の注意報は知らせない (一覧と地図に出るだけ)
    expect(
      plan(advisory("VPWW57", "レベル２高潮注意報"), SHIMANE_AT + 3_600_000),
    ).toBeNull();
    // 警報に上がったものは数に入れず、いつもどおり鳴らす
    expect(plan(shimane, SHIMANE_AT + 7_200_000)?.renotify).toBe(true);
    // 日本時間で日付が変わったら、また 1 回鳴らす (2024-11-03 00:00 JST)
    const tomorrow = Date.parse("2024-11-03T00:00:00+09:00");
    expect(
      plan(advisory("VPWW59", "波浪注意報", "2024-11-02T15:00:00Z"), tomorrow)
        ?.renotify,
    ).toBe(true);
    expect(sent.get(ADVISORY_QUOTA.home)?.digest).toBe("2024-11-03");
  });

  test("数えた日は localStorage の値で持ち越し、住んでいる地域と現在地は別に数える", () => {
    const sent = new Map<string, Sent>();
    loadQuota(JSON.stringify({ [ADVISORY_QUOTA.home]: "2024-11-02" }), sent);
    const p = prefs({ home: home() });
    expect(planAlert(ev(advisory()), SHIMANE_AT, p, sent)).toBeNull();
    // 現在地 (住んでいる地域と別の市町村等) の注意報は、別に 1 回鳴らす
    const here = home({ code: "3220100", name: "島根県松江市" });
    const away = prefs({
      home: home({ code: "1310100", name: "東京都千代田区", office: "130000" }),
    });
    const plans = planAlerts(ev(advisory()), SHIMANE_AT, away, sent, here);
    expect(plans.map((x) => [x.notice.here, x.renotify])).toEqual([
      [true, true],
    ]);
    expect(JSON.parse(quotaJson(sent))).toEqual({
      [ADVISORY_QUOTA.home]: "2024-11-02",
      [ADVISORY_QUOTA.here]: "2024-11-02",
    });
    // 壊れた値は読まない
    const empty = new Map<string, Sent>();
    loadQuota("{", empty);
    loadQuota(JSON.stringify({ [ADVISORY_QUOTA.home]: "きのう" }), empty);
    expect(empty.size).toBe(0);
  });

  test("サーバー: 送り先ごとに 1 日 1 回。Webhook には注意報の鳴らさない続報を送らない。送れなかったら数えた日も戻す", () => {
    const db = openDb(":memory:");
    db.query(
      "INSERT INTO push_subscriptions (endpoint, subject, p256dh, auth, prefs, label, created_at, updated_at) VALUES ('e1', 's', 'k', 'a', '{}', '', 0, 0)",
    ).run();
    const log = sentLog(db, "push_log");
    const target = { prefs: prefs({ home: home() }) };
    const send = (w: WeatherWarning, now: number, replaceable = true) => {
      const base = noticeOf(ev(w), now);
      if (!base) throw new Error("通知の元が無い");
      return planSends(db, log, base, [target], () => "e1", now, replaceable);
    };
    const [first] = send(advisory(), SHIMANE_AT);
    expect(first?.renotify).toBe(true);
    expect(first?.quota?.day).toBe("2024-11-02");
    expect(log.get("e1", ADVISORY_QUOTA.home)?.digest).toBe("2024-11-02");
    // 送れなかったら控えも数えた日も戻し、次の注意報を 1 回目として送る
    if (first) undoJob(log, "e1", first);
    expect(log.get("e1", ADVISORY_QUOTA.home)).toBeUndefined();
    expect(send(advisory(), SHIMANE_AT)[0]?.renotify).toBe(true);
    // 同じ日の別の注意報は送らない
    expect(
      send(advisory("VPWW57", "レベル２高潮注意報"), SHIMANE_AT + 60_000),
    ).toEqual([]);
    // 前に送った注意報の続報: Web Push は鳴らさずに置き換え、Webhook は送らない
    const update = { ...advisory(), headline: "続報の見出し" };
    expect(send(update, SHIMANE_AT + 120_000, false)).toEqual([]);
    expect(send(update, SHIMANE_AT + 120_000)[0]?.renotify).toBe(false);
    // 警報は数えずに送る
    expect(send(shimane, SHIMANE_AT + 180_000, false)[0]?.renotify).toBe(true);
  });

  test("注意報の数を使い切った日も、解除・記録的短時間大雨情報・竜巻注意情報・特別警報は知らせる", () => {
    const db = openDb(":memory:");
    db.query(
      "INSERT INTO push_subscriptions (endpoint, subject, p256dh, auth, prefs, label, created_at, updated_at) VALUES ('e1', 's', 'k', 'a', '{}', '', 0, 0)",
    ).run();
    const log = sentLog(db, "push_log");
    /** その日の注意報の数を使い切ってから送る */
    const send = (e: SonaeEvent, h: Home, now: number) => {
      log.mark(
        "e1",
        ADVISORY_QUOTA.home,
        { level: 0, digest: jstDate(now) },
        now,
      );
      const base = noticeOf(e, now);
      if (!base) throw new Error("通知の元が無い");
      const target = { prefs: prefs({ home: h }) };
      return planSends(db, log, base, [target], () => "e1", now);
    };
    // 使い切った日の注意報は送らない
    expect(send(ev(advisory()), home(), SHIMANE_AT)).toEqual([]);
    // 松江市の大雨警報を知らせた後に解除された
    expect(send(ev(shimane), home(), SHIMANE_AT)[0]?.renotify).toBe(true);
    const matsue = shimane.areas.find((a) => a.code === "3220100");
    if (!matsue) throw new Error("松江市が無い");
    const released: WeatherWarning = {
      ...shimane,
      areas: shimane.areas.filter((a) => a.code !== matsue.code),
      released: [matsue],
    };
    const [end] = send(ev(released), home(), SHIMANE_AT + 60_000);
    expect(end?.notice.closing).toBe(true);
    expect(end?.renotify).toBe(false);
    // どこかの特別警報
    const [sp] = send(ev(special), home({ code: "1310100" }), SHIMANE_AT);
    expect(sp?.notice.level).toBe(5);
    expect(sp?.renotify).toBe(true);
    // 記録的短時間大雨情報 (札幌市)・竜巻注意情報 (さいたま市)
    const rain = weatherInfo("18_03_01_190412_VPOA50.xml", "VPOA50");
    const [r] = send(
      weatherEvent(rain),
      homeAt("0110000"),
      Date.parse(rain.reportedAt) + 60_000,
    );
    expect(r?.renotify).toBe(true);
    const tornado = weatherInfo("19_08_03_250630_VPHW50.xml", "VPHW50");
    const [t] = send(
      weatherEvent(tornado),
      homeAt("1110000"),
      Date.parse("2015-07-17T09:30:00+09:00"),
    );
    expect(t?.renotify).toBe(true);
  });

  test("解除の後に同じ市町村・同じ種別でまた出たら、前と同じ段でも鳴らす (画面とサーバー)", () => {
    const p = prefs({ home: home() });
    /** 松江市の大雨の警報・注意報の解除 */
    const lifted: WeatherWarning = {
      ...advisory(),
      areas: [],
      released: [
        {
          code: "3220100",
          name: "松江市",
          kinds: [
            {
              code: "10",
              name: "レベル２大雨注意報",
              level: 2,
              status: "解除",
            },
          ],
        },
      ],
    };
    const tomorrow = Date.parse("2024-11-03T09:00:00+09:00");
    const again = advisory(
      "VPWW55",
      "レベル２大雨注意報",
      "2024-11-03T00:00:00Z",
    );
    // 画面
    const sent = new Map<string, Sent>();
    expect(planAlert(ev(advisory()), SHIMANE_AT, p, sent)?.renotify).toBe(true);
    expect(planAlert(ev(lifted), SHIMANE_AT + 60_000, p, sent)?.renotify).toBe(
      false,
    );
    expect(planAlert(ev(again), tomorrow, p, sent)?.renotify).toBe(true);
    // 警報も同じ (同じ日の 2 回目の大雨警報)
    const warned = new Map<string, Sent>();
    expect(planAlert(ev(shimane), SHIMANE_AT, p, warned)?.renotify).toBe(true);
    planAlert(ev(lifted), SHIMANE_AT + 60_000, p, warned);
    const second = { ...shimane, headline: "2 回目の大雨警報" };
    expect(
      planAlert(ev(second), SHIMANE_AT + 120_000, p, warned)?.renotify,
    ).toBe(true);
    // サーバー
    const db = openDb(":memory:");
    db.query(
      "INSERT INTO push_subscriptions (endpoint, subject, p256dh, auth, prefs, label, created_at, updated_at) VALUES ('e1', 's', 'k', 'a', '{}', '', 0, 0)",
    ).run();
    const log = sentLog(db, "push_log");
    const send = (w: WeatherWarning, now: number) => {
      const base = noticeOf(ev(w), now);
      if (!base) throw new Error("通知の元が無い");
      return planSends(db, log, base, [{ prefs: p }], () => "e1", now);
    };
    expect(send(advisory(), SHIMANE_AT)[0]?.renotify).toBe(true);
    expect(send(lifted, SHIMANE_AT + 60_000)[0]?.renotify).toBe(false);
    expect(log.get("e1", "warning:3220100:VPWW55")?.level).toBe(0);
    expect(send(again, tomorrow)[0]?.renotify).toBe(true);
    // 解除ではない続報では、重さは大きいほうを残す (下がって戻っただけでは鳴らし直さない)
    const raised = { ...shimane, reportedAt: again.reportedAt };
    expect(send(raised, tomorrow + 60_000)[0]?.renotify).toBe(true);
    expect(send(again, tomorrow + 120_000)[0]?.renotify).toBe(false);
    expect(log.get("e1", "warning:3220100:VPWW55")?.level).toBe(3);
    expect(send(raised, tomorrow + 180_000)[0]?.renotify).toBe(false);
  });

  test("住んでいる地域の解除は、前に知らせた購読にだけ送る (閉じる通知)", () => {
    const oki = home({ code: "3252800" });
    const n = notice(shimane, prefs({ home: oki }));
    expect(n?.closing).toBe(true);
    expect(n?.level).toBe(0);
    expect(n?.title).toBe("島根県隠岐の島町の大雨の警報・注意報の解除");
    expect(n && matches(n, prefs({ home: oki }))).toBe(false);
  });

  test("特別警報は、住んでいる地域でなくても知らせる (いつも)", () => {
    const far = home({ code: "1310100" });
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
    const okuizumo = home({ code: "3234300" });
    const n = notice(special, prefs({ home: okuizumo }));
    expect(n?.tag).toBe("warning:3234300:VPWW55");
    expect(n?.level).toBe(5);
    expect(n?.title).toBe("島根県にレベル5大雨特別警報");
    expect(n?.body).toContain("島根県奥出雲町: レベル2大雨注意報");
    expect(n && matches(n, prefs({ home: okuizumo, weather: "off" }))).toBe(
      true,
    );
    // 解除された市町村でも、特別警報を言いながら解除を添える (解除を落とさない)
    const oki = home({ code: "3252800" });
    const m = notice(special, prefs({ home: oki }));
    expect(m?.tag).toBe("warning:3252800:VPWW55");
    expect(m?.body).toContain("大雨の警報・注意報は解除");
    expect(m?.closing).toBe(false);
    // 特別警報が終わったら、住んでいる地域だけの中身に戻る (同じ tag)
    expect(notice(shimane, prefs({ home: okuizumo }))?.tag).toBe(
      "warning:3234300:VPWW55",
    );
  });

  test("「全国」なら、ほかの府県予報区の危険警報 (レベル 4) も府県予報区ごとに知らせる。警報 (レベル 3) は知らせない", () => {
    // 同じ電文の大雨警報を大雨危険警報に書き換えた作り物 (危険警報のサンプル電文が無いため)
    const danger = weatherWarning(RAIN, "VPWW55", (s) =>
      s.replace(
        /<Name>レベル３大雨警報<\/Name>\s*<Code>03<\/Code>/g,
        "<Name>レベル４大雨危険警報</Name><Code>43</Code>",
      ),
    );
    const far = home({ code: "1310100" });
    // 島根県の大雨警報 (レベル 3) は、全国でも東京都千代田区には知らせない
    expect(
      notice(shimane, prefs({ home: far, weather: "everywhere" })),
    ).toBeNull();
    const wide = notice(danger, prefs({ home: far, weather: "everywhere" }));
    expect(wide?.tag).toBe("warning:special:320000:VPWW55");
    expect(wide?.level).toBe(4);
    expect(wide?.title).toBe("島根県にレベル4大雨危険警報");
    expect(
      wide && matches(wide, prefs({ home: far, weather: "everywhere" })),
    ).toBe(true);
    // 「住んでいる地域と現在地」では、ほかの所の危険警報は知らせない (特別警報だけ)
    expect(notice(danger, prefs({ home: far }))).toBeNull();
    // 前の控えの通知 (どこかの特別警報の tag) を「住んでいる地域と現在地」で見ても鳴らさない
    expect(wide && matches(wide, prefs({ home: far }))).toBe(false);
    // 読み上げは、府県予報区と種類、対象の市町村 (特別警報と同じ形)。サーバーが通す文の中にある
    if (!wide) throw new Error("通知が無い");
    const parts = readoutOf(wide);
    expect(parts[0]).toBe(OPENINGS.weatherDanger);
    expect(parts[1]).toBe("島根県に、レベル4大雨危険警報が出ています。");
    expect(parts[2]).toStartWith("対象の市町村は、松江市");
    const all = readoutCandidates(noticeOf(ev(danger), SHIMANE_AT)!);
    for (const p of parts) expect(all).toContain(p);
    // 同じ府県予報区の、危険警報の出ていない市町村に住んでいても、危険警報を先に言う
    const other = danger.areas.find((a) => areaLevel(a) < 4);
    if (!other) throw new Error("危険警報の出ていない市町村が無い");
    const mixed = notice(
      danger,
      prefs({ home: home({ code: other.code }), weather: "everywhere" }),
    );
    if (!mixed) throw new Error("通知が無い");
    expect(readoutOf(mixed).slice(0, 2)).toEqual(parts.slice(0, 2));
    for (const p of readoutOf(mixed)) expect(all).toContain(p);
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
  const rain = weatherInfo("18_03_01_190412_VPOA50.xml", "VPOA50");
  const rainAt = Date.parse(rain.reportedAt) + 60_000;
  const sapporo = homeAt("0110000");

  test("住んでいる地域 (一次細分区域) が対象なら知らせる", () => {
    const base = noticeOf(weatherEvent(rain), rainAt);
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

  test("竜巻注意情報は有効期限を過ぎたら知らせない。洪水予報・熱中症・台風は知らせない (府県気象防災速報の線状降水帯・短時間大雪は知らせる。snow.test.ts)", () => {
    const tornado = weatherInfo("19_08_03_250630_VPHW50.xml", "VPHW50");
    const at = Date.parse("2015-07-17T09:30:00+09:00");
    expect(noticeOf(weatherEvent(tornado), at)).not.toBeNull();
    expect(
      noticeOf(weatherEvent(tornado), Date.parse("2015-07-17T10:31:00+09:00")),
    ).toBeNull();
    for (const [file, code] of [
      ["16_09_01_260312_VXKOii.xml", "VXKO53"], // 指定河川洪水予報
      ["57_03_01_240401_VPFT50.xml", "VPFT50"], // 熱中症警戒アラート
      ["10_04_07_170916_VPTW60.xml", "VPTW60"], // 台風解析・予報情報
    ] as const) {
      const i = weatherInfo(file, code);
      // 古すぎて外れたのではないことを、出てすぐの時刻で確かめる
      expect(
        noticeOf(weatherEvent(i), Date.parse(i.reportedAt) + 60_000),
      ).toBeNull();
    }
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
    const sabo = weatherWarning("15_16_01_241031_VPWW56.xml", "VPWW56");
    const wakkanai = sabo.areas.find((a) => a.name === "稚内市");
    if (!wakkanai) throw new Error("稚内市が無い");
    const at = Date.parse(sabo.reportedAt) + 60_000;
    const base = noticeOf(ev(sabo), at);
    if (!base) throw new Error("通知の元が無い");
    const n = noticeFor(base, prefs({ home: home({ code: wakkanai.code }) }));
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
    if (!other) throw new Error("特別警報の出ていない市町村が無い");
    const mixed = notice(special, prefs({ home: home({ code: other.code }) }));
    if (!mixed) throw new Error("通知が無い");
    expect(mixed.special).toBe(true);
    for (const p of readoutOf(mixed)) expect(all).toContain(p);
    // 地域を選んでいなくても、特別警報は読む
    const anywhere = notice(special, prefs());
    expect(anywhere && readoutOf(anywhere)[0]).toBe(OPENINGS.weatherSpecial);
  });

  test("記録的短時間大雨情報・竜巻注意情報は、決まった文と気象庁の見出しだけ。竜巻は有効期限を足す", () => {
    const rain = weatherInfo("18_03_01_190412_VPOA50.xml", "VPOA50");
    const r = noticeOf(
      weatherEvent(rain),
      Date.parse(rain.reportedAt) + 60_000,
    );
    if (!r) throw new Error("通知が無い");
    expect(readoutOf(r)).toEqual([
      OPENINGS.recordRain,
      ...sentences(clean(rain.headline)),
    ]);
    expect(readoutOf(r).join("")).toContain("札幌市中央区付近で約100ミリ");
    const tornado = weatherInfo("19_08_03_250630_VPHW50.xml", "VPHW50");
    const t = noticeOf(
      weatherEvent(tornado),
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
});

/** 電文の大雨警報を大雨危険警報に書き換える (危険警報のサンプル電文が無いため) */
const toDanger = (s: string) =>
  s.replace(
    /<Name>レベル３大雨警報<\/Name>\s*<Code>03<\/Code>/g,
    "<Name>レベル４大雨危険警報</Name><Code>43</Code>",
  );
/** 電文の時刻を替える */
const reportedAt = (iso: string) => (s: string) =>
  s.replace(
    /<ReportDateTime>[^<]+<\/ReportDateTime>/,
    `<ReportDateTime>${iso}</ReportDateTime>`,
  );
/** サンプル電文の大雨警報 (継続) の Kind */
const WARNING_KIND =
  /<Name>レベル３大雨警報<\/Name>\s*<Code>03<\/Code>\s*<Status>継続<\/Status>/g;
/**
 * 府県予報区から危険警報・特別警報が無くなる電文 (サンプル電文の大雨警報を書き換えた作り物)。
 * R06 に取消は無く、誤って出したものは訂正の報で置き換わる
 */
const ENDINGS: Record<string, (s: string) => string> = {
  解除: (s) =>
    s.replace(
      WARNING_KIND,
      "<Name>レベル３大雨警報</Name><Code>03</Code><Status>解除</Status>",
    ),
  警報から注意報への切り替え: (s) =>
    s.replace(
      WARNING_KIND,
      "<Name>レベル２大雨注意報</Name><Code>10</Code><Status>警報から注意報</Status>",
    ),
  訂正: (s) =>
    s.replace("<InfoType>発表</InfoType>", "<InfoType>訂正</InfoType>"),
};
const lift = ENDINGS["解除"] ?? ((s: string) => s);

describe("府県予報区ごとの通知 (どこかの特別警報・「全国」の危険警報) が終わったとき", () => {
  const TAG = "warning:special:320000:VPWW55";
  /** 東京都千代田区 (島根県の府県予報区の外) */
  const far = home({ code: "1310100" });
  const CASES = [
    {
      name: "「全国」の危険警報",
      issue: toDanger,
      p: prefs({ home: far, weather: "everywhere" }),
    },
    { name: "どこかの特別警報", issue: toSpecialRain, p: prefs({ home: far }) },
    {
      name: "どこかの特別警報 (住んでいる地域を選んでいない)",
      issue: toSpecialRain,
      p: prefs(),
    },
  ];
  const T1 = "2024-11-02T15:00:00+09:00";
  const T2 = "2024-11-02T18:00:00+09:00";
  const T3 = "2024-11-12T09:00:00+09:00";

  /** 画面・Web Push・Webhook のそれぞれで報を受ける */
  function receivers(p: PushPrefs) {
    const sent = new Map<string, Sent>();
    const db = openDb(":memory:");
    db.query(
      "INSERT INTO push_subscriptions (endpoint, subject, p256dh, auth, prefs, label, created_at, updated_at) VALUES ('e1', 's', 'k', 'a', '{}', '', 0, 0)",
    ).run();
    db.query(
      "INSERT INTO webhooks (id, subject, url, prefs, created_at, updated_at) VALUES (1, 's', 'https://example.com/hook', '{}', 0, 0)",
    ).run();
    const push = sentLog(db, "push_log");
    const hook = sentLog(db, "webhook_log");
    return {
      /** 画面・Web Push・Webhook の順に、その tag で送るもの (送らなければ null) */
      receive(w: WeatherWarning) {
        const now = Date.parse(w.reportedAt) + 60_000;
        const base = noticeOf(ev(w), now);
        if (!base) throw new Error("通知の元が無い");
        const page = planAlerts(ev(w), now, p, sent, null).filter(
          (a) => a.notice.tag === TAG,
        );
        const server = (log: SentLog, key: string | number, r: boolean) =>
          planSends(db, log, base, [{ prefs: p }], () => key, now, r).filter(
            (j) => j.notice.tag === TAG,
          );
        const out = [page, server(push, "e1", true), server(hook, 1, false)];
        for (const o of out) expect(o.length).toBeLessThanOrEqual(1);
        return out.map((o) => o[0] ?? null);
      },
      /** 控えの重さ (画面・Web Push・Webhook) */
      levels: () => [
        sent.get(TAG)?.level,
        push.get("e1", TAG)?.level,
        hook.get(1, TAG)?.level,
      ],
    };
  }

  for (const c of CASES)
    for (const [ending, end] of Object.entries(ENDINGS))
      test(`${c.name} → ${ending} → 10 日後に同じ府県予報区・同じ種別でまた出たら鳴らす (画面・Web Push・Webhook)`, () => {
        const r = receivers(c.p);
        const first = weatherWarning(RAIN, "VPWW55", c.issue);
        for (const s of r.receive(first)) expect(s?.renotify).toBe(true);
        // 終わった: 前に知らせた所へ、鳴らさずに終わりを伝える (Webhook にも送る)
        const ended = weatherWarning(RAIN, "VPWW55", (s) =>
          end(reportedAt(T1)(s)),
        );
        for (const s of r.receive(ended)) {
          expect(s?.renotify).toBe(false);
          expect(s?.notice.closing).toBe(true);
          expect(s?.notice.sticky).toBe(false);
          expect(s?.notice.title).toBe(
            c.issue === toDanger
              ? "島根県の大雨の危険警報・特別警報は終わりました"
              : "島根県の大雨の特別警報は終わりました",
          );
        }
        expect(r.levels()).toEqual([0, 0, 0]);
        // 終わった後の続報では、もう送らない (同じ中身)
        const later = weatherWarning(RAIN, "VPWW55", (s) =>
          end(reportedAt(T2)(s)),
        );
        expect(r.receive(later)).toEqual([null, null, null]);
        // 30 日の間にまた出たら、前と同じ段でも鳴らす。同じ報を続けて受けても 1 度だけ
        const again = weatherWarning(RAIN, "VPWW55", (s) =>
          c.issue(reportedAt(T3)(s)),
        );
        for (const s of r.receive(again)) expect(s?.renotify).toBe(true);
        expect(r.receive(again)).toEqual([null, null, null]);
      });

  test("知らせていない送り先には、終わりを送らない", () => {
    // 「住んでいる地域と現在地」では「全国」の危険警報を知らせていないので、終わりも送らない
    const r = receivers(prefs({ home: far }));
    const first = weatherWarning(RAIN, "VPWW55", toDanger);
    expect(r.receive(first)).toEqual([null, null, null]);
    const ended = weatherWarning(RAIN, "VPWW55", (s) =>
      lift(reportedAt(T1)(s)),
    );
    expect(r.receive(ended)).toEqual([null, null, null]);
    expect(r.levels()).toEqual([undefined, undefined, undefined]);
    // 「全国」でも、危険警報の出ていない府県予報区の電文 (警報・注意報だけ) では送らない
    const wide = receivers(prefs({ home: far, weather: "everywhere" }));
    expect(wide.receive(shimane)).toEqual([null, null, null]);
    expect(wide.receive(ended)).toEqual([null, null, null]);
    expect(wide.levels()).toEqual([undefined, undefined, undefined]);
  });

  test("「全国」で特別警報が危険警報に下がっただけでは終わりにせず、また上がっても鳴らし直さない", () => {
    const r = receivers(prefs({ home: far, weather: "everywhere" }));
    for (const s of r.receive(special)) expect(s?.renotify).toBe(true);
    const lowered = weatherWarning(RAIN, "VPWW55", (s) =>
      toDanger(reportedAt(T1)(s)),
    );
    for (const s of r.receive(lowered)) {
      expect(s?.notice.closing).toBe(false);
      expect(s?.renotify).toBe(false);
    }
    expect(r.levels()).toEqual([5, 5, 5]);
    const raised = weatherWarning(RAIN, "VPWW55", (s) =>
      toSpecialRain(reportedAt(T2)(s)),
    );
    for (const s of r.receive(raised)) expect(s?.renotify).toBe(false);
  });

  test("住んでいる地域が同じ府県予報区なら、住んでいる地域の通知だけで終わりを伝える (#210 のまま。二重に送らない)", () => {
    const p = prefs({ home: home() });
    const sent = new Map<string, Sent>();
    const tags = (w: WeatherWarning) =>
      planAlerts(ev(w), Date.parse(w.reportedAt) + 60_000, p, sent, null).map(
        (a) => [a.notice.tag, a.renotify, a.notice.closing],
      );
    expect(tags(special)).toEqual([["warning:3220100:VPWW55", true, false]]);
    const ended = weatherWarning(RAIN, "VPWW55", (s) =>
      lift(reportedAt(T1)(s)),
    );
    expect(tags(ended)).toEqual([["warning:3220100:VPWW55", false, true]]);
    const again = weatherWarning(RAIN, "VPWW55", (s) =>
      toSpecialRain(reportedAt(T3)(s)),
    );
    expect(tags(again)).toEqual([["warning:3220100:VPWW55", true, false]]);
  });
});

test("気象防災速報で知らせるのは、線状降水帯 (発生と直前の予測) と短時間大雪だけ", () => {
  const ok = (kindName: string) => isNotifiedBosai({ kind: "bosai", kindName });
  expect(ok("線状降水帯発生")).toBe(true);
  expect(ok("線状降水帯直前")).toBe(true);
  expect(ok("短時間大雪")).toBe(true);
  expect(ok("記録雨")).toBe(false);
  expect(ok("顕著な大雪")).toBe(false);
});
