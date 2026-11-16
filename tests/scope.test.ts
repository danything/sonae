/**
 * 通知の範囲 (全国 / 住んでいる地域と現在地 / 知らせない) のうち、津波・地震の震度・緊急地震速報の予報の続報と、
 * 画面の文と市町村等の表 (docs/design.md の 2.4)
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  groupAlerts,
  planAlerts,
  planEntry,
  presentEvents,
} from "#lib/alert.ts";
import type { Intensity, SonaeEvent } from "#lib/model.ts";
import type { Sent } from "#lib/notify.ts";
import {
  homeNote,
  matches,
  noticeFor,
  noticeOf,
  scopeText,
} from "#lib/notify.ts";
import {
  normalizePrefs,
  type PushPrefs,
  quakeMinOf,
  SCOPE_KINDS,
  SCOPES,
  withQuakeMin,
} from "#lib/push.ts";
import { openDb } from "#lib/server/db.ts";
import { planSends, sentLog } from "#lib/server/notify.ts";

import { eew, NOW, prefs, quake, tsunami } from "./events.ts";
import { cities, homeAt as at } from "./helpers.ts";

describe("市町村等の表の津波予報区 (気象庁の市町村対応表から)", () => {
  test("沿岸の市町村等に予報区が付き、海に面していない所は空", () => {
    expect(at("1210000").tsunami).toEqual([
      { code: "312", name: "東京湾内湾" },
    ]); // 千葉市
    expect(at("1221700").tsunami).toEqual([]); // 柏市
    expect(at("1020100").tsunami).toEqual([]); // 前橋市
    // 2 つの予報区に面する市は両方 (北九州市は瀬戸内海沿岸と日本海沿岸)
    expect(at("4010000").tsunami?.map((t) => t.code)).toEqual(["710", "711"]);
  });

  test("表の予報区のコードは、どれも津波予報区の GeoJSON にある", () => {
    const geo = JSON.parse(
      readFileSync(
        new URL("../static/areas/tsunami-areas.geojson", import.meta.url),
        "utf8",
      ),
    ) as { features: { properties: { code: string; name: string } }[] };
    const known = new Map(
      geo.features.map((f) => [f.properties.code, f.properties.name]),
    );
    const used = new Set<string>();
    for (const row of Object.values(cities))
      for (const [code, name] of row[6] ?? []) {
        expect(known.get(code)).toBe(name);
        used.add(code);
      }
    // 66 の予報区のどれにも、市町村等が 1 つ以上ある
    expect(used.size).toBe(66);
  });
});

describe("津波", () => {
  const chiba = at("1210000");
  const kashiwa = at("1221700");
  const watch = (name: string, code: string) =>
    tsunami({
      areas: [{ code, name, grade: "watch", kindName: "津波注意報" }],
    });

  test("住んでいる地域と現在地: その予報区の津波注意報以上だけ", () => {
    const near = prefs({ tsunami: "nearby", home: chiba });
    const here = noticeOf(watch("東京湾内湾", "312"), NOW);
    const far = noticeOf(watch("岩手県", "210"), NOW);
    if (!here || !far) throw new Error("通知が無い");
    const n = noticeFor(here, near);
    expect(n && matches(n, near)).toBe(true);
    const m = noticeFor(far, near);
    expect(m && matches(m, near)).toBe(false);
    // 全国なら遠くても
    expect(matches(far, prefs())).toBe(true);
  });

  test("海に面していない住んでいる地域は、現在地の予報区とどこかの大津波警報だけ", () => {
    const near = prefs({ tsunami: "nearby", home: kashiwa });
    const tokyoBay = noticeOf(watch("東京湾内湾", "312"), NOW);
    if (!tokyoBay) throw new Error("通知が無い");
    const n = noticeFor(tokyoBay, near);
    expect(n && matches(n, near)).toBe(false);
    // 現在地が千葉市 (開いている画面)
    const h = noticeFor(tokyoBay, near, chiba);
    expect(h && matches(h, near, chiba)).toBe(true);
    // 大津波警報は特別警報なので、どこに出ても知らせる
    const major = noticeOf(
      tsunami({
        areas: [
          {
            code: "210",
            name: "岩手県",
            grade: "major",
            kindName: "大津波警報",
          },
        ],
      }),
      NOW,
    );
    if (!major) throw new Error("通知が無い");
    const mj = noticeFor(major, near);
    expect(mj && matches(mj, near)).toBe(true);
    // 「知らせない」でも、大津波警報だけは知らせる (2026-11-16)。津波注意報は知らせない
    const off = prefs({ tsunami: "off", home: kashiwa });
    expect(matches(major, off)).toBe(true);
    expect(matches(tokyoBay, off)).toBe(false);
  });

  test("その予報区の区分が上がったら鳴らし直す (重さはその予報区の区分)", () => {
    const near = prefs({ tsunami: "nearby", home: chiba });
    const both = (grade: "watch" | "warning") =>
      tsunami({
        areas: [
          { code: "210", name: "岩手県", grade: "warning", kindName: "" },
          { code: "312", name: "東京湾内湾", grade, kindName: "" },
        ],
      });
    const a = noticeOf(both("watch"), NOW);
    const b = noticeOf(both("warning"), NOW);
    if (!a || !b) throw new Error("通知が無い");
    expect(noticeFor(a, near)?.level).toBe(2);
    expect(noticeFor(b, near)?.level).toBe(3);
  });

  test("見出しと本文が同じでも、住んでいる地域か現在地の区分が上がれば鳴らし直す", () => {
    // 岩手県が津波警報、東京湾内湾が注意報。見出し (いちばん重い区分) と本文 (その区分の地域) は変わらない
    const t = tsunami({
      areas: [
        { code: "210", name: "岩手県", grade: "warning", kindName: "" },
        { code: "312", name: "東京湾内湾", grade: "watch", kindName: "" },
        { code: "311", name: "千葉県内房", grade: "warning", kindName: "" },
      ],
    });
    const near = prefs({ tsunami: "nearby", home: chiba });
    const sent = new Map<string, Sent>();
    // 住んでいる地域 (千葉市。東京湾内湾の注意報) で 1 度鳴らす
    const first = groupAlerts(planAlerts(t, NOW, near, sent, null)).ring;
    expect(first?.level).toBe(2);
    // 津波警報の千葉県内房 (館山市) に入ったら鳴らし直す
    const tateyama = at("1220500");
    expect(tateyama.tsunami?.map((x) => x.code)).toEqual(["311"]);
    const g = groupAlerts(planEntry([t], near, sent, tateyama));
    expect(g.ring?.tag).toBe(first?.tag);
    expect(g.ring?.level).toBe(3);
  });

  test("前の形の住んでいる地域 (津波予報区が無い) は、どの予報区でも当たるとみなす", () => {
    const { tsunami: _, ...old } = chiba;
    const near = prefs({ tsunami: "nearby", home: old });
    const far = noticeOf(watch("岩手県", "210"), NOW);
    if (!far) throw new Error("通知が無い");
    const n = noticeFor(far, near);
    expect(n && matches(n, near)).toBe(true);
  });

  test("現在地に入ったら、そこの予報区に出ている津波注意報を 1 度知らせる", () => {
    const near = prefs({ tsunami: "nearby", home: kashiwa });
    const t = watch("東京湾内湾", "312");
    if (t.type !== "tsunami") throw new Error("津波ではない");
    const events = presentEvents(
      { warnings: [], tsunamis: [t.data], volcanoes: [] },
      NOW,
    );
    const sent = new Map<string, Sent>();
    const g = groupAlerts(planEntry(events, near, sent, chiba));
    expect(g.ring?.tag).toBe("tsunami:20261114085500");
    // 戻ってきても鳴らし直さない
    expect(planEntry(events, near, sent, chiba)).toEqual([]);
    // 予報区が違えば知らせない
    expect(planEntry(events, near, new Map(), at("1020100"))).toEqual([]);
  });
});

describe("地震の震度", () => {
  // 千葉市と柏市は千葉県北西部、前橋市は群馬県南部
  const chiba = at("1210000");
  const kashiwa = at("1221700");
  const maebashi = at("1020100");
  const q = (maxInt: Intensity, local: Intensity) =>
    noticeOf(
      quake({
        maxInt,
        areas: [
          { code: "341", name: "千葉県北西部", int: local },
          { code: "100", name: "石狩地方北部", int: maxInt },
        ],
      }),
      Date.parse("2026-11-14T09:10:00+09:00"),
    );

  test("既定は前と同じ (全国は最大震度 4 以上と住んでいる地域で震度 3 以上、地域は震度 3 以上)", () => {
    const n4 = q("4", "1");
    const n3 = q("3", "3");
    const n2 = q("2", "2");
    if (!n4 || !n3 || !n2) throw new Error("通知が無い");
    const all = prefs({ home: chiba });
    expect(quakeMinOf(all)).toBe("4");
    expect(matches(n4, all)).toBe(true);
    expect(matches(n3, all)).toBe(true); // 住んでいる地域で震度 3
    expect(matches(n3, prefs({ home: kashiwa }))).toBe(true); // 柏市も千葉県北西部
    expect(matches(n3, prefs({ home: maebashi }))).toBe(false);
    expect(matches(n2, all)).toBe(false);
    const near = prefs({ quake: "nearby", home: chiba });
    expect(quakeMinOf(near)).toBe("3");
    expect(matches(n4, near)).toBe(false); // 千葉県北西部は震度 1
    expect(matches(n3, near)).toBe(true);
  });

  test("選んだ震度は、選んだ範囲に使う。全国でも住んでいる地域は震度 3 から", () => {
    const n5 = q("5-", "1");
    const n4 = q("4", "3");
    if (!n5 || !n4) throw new Error("通知が無い");
    const all = prefs({ home: chiba, quakeMin: "5-" });
    expect(matches(n5, all)).toBe(true);
    expect(matches(n4, all)).toBe(true); // 住んでいる地域で震度 3
    expect(matches(n4, prefs({ home: maebashi, quakeMin: "5-" }))).toBe(false);
    // 住んでいる地域と現在地: そこの震度で見る
    const near = prefs({ quake: "nearby", home: chiba, quakeMin: "4" });
    expect(matches(n4, near)).toBe(false);
    expect(matches(n5, near)).toBe(false);
    const n4here = q("4", "4");
    if (!n4here) throw new Error("通知が無い");
    expect(matches(n4here, near)).toBe(true);
    // 全国で震度 2 にすれば、どこかで震度 2 以上
    const n2 = q("2", "1");
    if (!n2) throw new Error("通知が無い");
    expect(matches(n2, prefs({ quakeMin: "2" }))).toBe(true);
  });

  test("既定のままの震度は、範囲を替えたら替えた先の既定になる。選んだ値は残す", () => {
    const all = prefs();
    expect(withQuakeMin(all, "4")).toEqual(all); // 既定と同じなら持たない
    const nearby = normalizePrefs({
      ...withQuakeMin(all, "4"),
      quake: "nearby",
    });
    expect(quakeMinOf(nearby)).toBe("3");
    const picked = withQuakeMin(all, "5+");
    expect(picked.quakeMin).toBe("5+");
    expect(quakeMinOf(normalizePrefs({ ...picked, quake: "nearby" }))).toBe(
      "5+",
    );
  });
});

describe("緊急地震速報の予報の続報 (住んでいる地域と現在地)", () => {
  // 柏市は千葉県北西部
  const near = prefs({ eew: "nearby", home: at("1221700") });

  /** サーバーの送り先 1 つ。送ると決めたら控える */
  function server(p: PushPrefs) {
    const db = openDb(":memory:");
    db.query(
      "INSERT INTO push_subscriptions (endpoint, subject, p256dh, auth, prefs, label, created_at, updated_at) VALUES ('e1', 's', 'k', 'a', '{}', '', 0, 0)",
    ).run();
    const log = sentLog(db, "push_log");
    return (e: SonaeEvent) => {
      const n = noticeOf(e, NOW);
      if (!n) throw new Error("通知が無い");
      return planSends(db, log, n, [{ prefs: p }], () => "e1", NOW);
    };
  }

  test("地域の無い予報で知らせた後、同じ地震の続報で地域が付いても鳴らし直さない", () => {
    const send = server(near);
    expect(send(eew()).map((j) => j.renotify)).toEqual([true]);
    expect(send(eew({ serial: 2, areas: ["千葉県北西部"] }))).toEqual([]);
    // 住んでいる地域でない地域が付いても同じ
    expect(send(eew({ serial: 3, areas: ["茨城県南部"] }))).toEqual([]);
  });

  test("地域が付いて初めて住んでいる地域が当たったら、初めての通知として鳴らす", () => {
    const send = server(near);
    // 初めの報はほかの地域だけが並び、知らせない
    expect(send(eew({ areas: ["茨城県南部"] }))).toEqual([]);
    expect(
      send(eew({ serial: 2, areas: ["茨城県南部", "千葉県北西部"] })).map(
        (j) => j.renotify,
      ),
    ).toEqual([true]);
  });
});

describe("画面の文", () => {
  test("どの種類と範囲にも、何を知らせるかの 1 文がある", () => {
    for (const k of SCOPE_KINDS)
      for (const s of SCOPES) expect(scopeText(k, s)).toMatch(/。$/);
    expect(scopeText("quake", "everywhere")).toBe(
      "最大震度4以上の地震と、住んでいる地域か現在地で震度3以上の地震を知らせます。",
    );
    expect(scopeText("quake", "everywhere", "2")).toBe(
      "最大震度2以上の地震を知らせます。",
    );
    expect(scopeText("quake", "nearby")).toBe(
      "住んでいる地域か現在地で震度3以上の地震だけを知らせます。",
    );
    expect(scopeText("quake", "nearby", "5-")).toBe(
      "住んでいる地域か現在地で震度5弱以上の地震だけを知らせます。",
    );
    // 特別警報にあたるものは「知らせない」でも知らせる
    expect(scopeText("weather", "off")).toBe(
      "どこに出た特別警報だけを知らせます。",
    );
    expect(scopeText("tsunami", "off")).toContain("大津波警報だけ");
    expect(scopeText("volcano", "off")).toContain(
      "噴火警報 (レベル 4・5) だけ",
    );
    expect(scopeText("eew", "everywhere")).toContain("予報");
    // 気象の注意報は 1 日 1 回まで (全国でも住んでいる地域と現在地でも)
    expect(scopeText("weather", "everywhere")).toContain(
      "注意報だけの通知は 1 日 1 回までです。",
    );
    expect(scopeText("weather", "nearby")).toContain(
      "注意報だけの通知は 1 日 1 回までです。",
    );
    // 予想震度の数字は書かない
    for (const s of SCOPES) expect(scopeText("eew", s)).not.toMatch(/震度/);
  });

  test("住んでいる地域の文は、照らすものと、選んでいないときの扱いを言う", () => {
    expect(homeNote(null)).toContain("地図の現在地を出している間だけ");
    expect(homeNote(at("1210000"))).toContain(
      "津波は「東京湾内湾」の予報区で見ます",
    );
    expect(homeNote(at("1221700"))).toContain("海に面していないので");
  });
});
