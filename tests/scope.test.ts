/** 通知の範囲 (全国 / 住んでいる地域と現在地 / 知らせない) のうち、津波と画面の文と表 (docs/design.md の 2.4) */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  groupAlerts,
  planAlerts,
  planEntry,
  presentEvents,
} from "#lib/alert.ts";
import { type Cities, homeOf } from "#lib/home.ts";
import type { Sent } from "#lib/notify.ts";
import {
  homeNote,
  matches,
  noticeFor,
  noticeOf,
  scopeText,
} from "#lib/notify.ts";
import { type Home, SCOPE_KINDS, SCOPES } from "#lib/push.ts";

import { NOW, prefs, tsunami } from "./events.ts";

const cities = JSON.parse(
  readFileSync(new URL("../static/areas/cities.json", import.meta.url), "utf8"),
) as Cities;
const quakeNames = new Map<string, string>();
const at = (code: string): Home => {
  const h = homeOf(code, cities, quakeNames);
  if (!h) throw new Error(`市町村等 ${code} が表にありません`);
  return h;
};

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

describe("画面の文", () => {
  test("どの種類と範囲にも、何を知らせるかの 1 文がある", () => {
    for (const k of SCOPE_KINDS)
      for (const s of SCOPES) expect(scopeText(k, s)).toMatch(/。$/);
    expect(scopeText("quake", "everywhere")).toBe(
      "最大震度4以上の地震と、住んでいる地域か現在地で震度3以上の地震を知らせます。",
    );
    // 気象の特別警報は「知らせない」でも知らせる
    expect(scopeText("weather", "off")).toBe(
      "どこに出た特別警報だけを知らせます。",
    );
  });

  test("住んでいる地域の文は、照らすものと、選んでいないときの扱いを言う", () => {
    expect(homeNote(null)).toContain("地図の現在地を出している間だけ");
    expect(homeNote(at("1210000"))).toContain(
      "津波は「東京湾内湾」の予報区で見ます",
    );
    expect(homeNote(at("1221700"))).toContain("海に面していないので");
  });
});
