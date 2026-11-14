import { describe, expect, test } from "bun:test";

import type { Advisory, Volcano } from "#lib/model.ts";
import { noticeOf } from "#lib/notify.ts";
import {
  clean,
  FIXED_TEXTS,
  isFixed,
  listOf,
  OPENINGS,
  readoutOf,
} from "#lib/readout.ts";

import { eew, NOW, quake, tsunami } from "./events.ts";

const read = (e: Parameters<typeof noticeOf>[0]) => {
  const n = noticeOf(e, NOW);
  if (!n) throw new Error("通知になりません");
  return readoutOf(n);
};

describe("読み上げの原稿", () => {
  test("緊急地震速報 (警報) は決まった文を 2 度読み、地域と震源を続ける。予想震度は読まない", () => {
    const parts = read(
      eew({
        kind: "warning",
        hypocenter: { name: "日向灘" },
        magnitude: 7.1,
        warnAreas: ["宮崎県南部平野部", "鹿児島県大隅"],
      }),
    );
    expect(parts).toEqual([
      OPENINGS.eewWarning,
      OPENINGS.eewWarning,
      "強い揺れに警戒が必要な地域は、宮崎県南部平野部、鹿児島県大隅です。",
      "震源は日向灘です。",
    ]);
    expect(parts.join("")).not.toMatch(/震度|マグニチュード/);
  });

  test("緊急地震速報 (予報) は震源と M。仮定震源はそう言う", () => {
    expect(read(eew({ assumed: true }))).toEqual([
      OPENINGS.eewForecast,
      "震源は茨城県南部、規模はマグニチュード4.8と推定されています。",
      "震源と規模は仮のものです。",
    ]);
  });

  test("震源・震度の情報は、時刻・震源・深さ・M・最大震度・地域の順。津波の文は気象庁の文のまま", () => {
    const parts = read(
      quake({
        hypocenter: { name: "千葉県北西部", depthKm: 60 },
        comments: [
          "この地震による津波の心配はありません。",
          "＊印は気象庁以外の震度観測点についての情報です。",
        ],
      }),
    );
    expect(parts).toEqual([
      OPENINGS.quakeInfo,
      "9時5分ごろ、千葉県北西部を震源とする地震がありました。",
      "震源の深さは約60キロメートル、地震の規模を示すマグニチュードは5.1と推定されています。",
      "最大震度4を観測しました。",
      "震度4を観測したのは、千葉県北西部です。",
      "震度3を観測したのは、東京都23区です。",
      "この地震による津波の心配はありません。",
    ]);
  });

  test("震度速報は震源を言わず、最大震度と地域", () => {
    const parts = read(
      quake({
        hypocenter: undefined,
        magnitude: undefined,
        maxInt: "5-",
        areas: [
          { name: "宮崎県南部平野部", int: "5-" },
          { name: "宮崎県北部平野部", int: "4" },
          { name: "大分県南部", int: "3" },
        ],
      }),
    );
    expect(parts).toEqual([
      OPENINGS.quakeScale,
      "9時5分ごろ、最大震度5弱を観測する地震がありました。",
      "震度5弱を観測したのは、宮崎県南部平野部です。",
      "震度4を観測したのは、宮崎県北部平野部です。",
    ]);
  });

  test("震度 5 弱以上未入電は、まだ震度が入っていないと言う", () => {
    const parts = read(
      quake({
        maxInt: "5-?",
        areas: [{ name: "石川県能登", int: "5-?" }],
      }),
    );
    expect(parts).toContain(
      "震度5弱以上とみられ、まだ震度が入っていない地域は、石川県能登です。",
    );
  });

  test("津波は大津波警報・津波警報の地域を先に全部読み、気象庁の見出し、注意報の地域の順", () => {
    const watch = Array.from({ length: 12 }, (_, i) => ({
      name: `地域${i + 1}`,
      grade: "watch" as const,
      kindName: "津波注意報",
    }));
    const parts = read(
      tsunami({
        headline:
          "東日本大震災クラスの津波が来襲します。\n大津波警報・津波警報を発表しました。",
        areas: [
          { name: "岩手県", grade: "major", kindName: "大津波警報" },
          { name: "宮城県", grade: "major", kindName: "大津波警報" },
          { name: "青森県太平洋沿岸", grade: "warning", kindName: "津波警報" },
          ...watch,
        ],
      }),
    );
    expect(parts.slice(0, 5)).toEqual([
      OPENINGS.tsunamiMajor,
      "大津波警報が出ている地域は、岩手県、宮城県です。",
      "津波警報が出ている地域は、青森県太平洋沿岸です。",
      "東日本大震災クラスの津波が来襲します。",
      "大津波警報・津波警報を発表しました。",
    ]);
    expect(parts[5]).toBe(
      `津波注意報が出ている地域は、${watch
        .slice(0, 10)
        .map((a) => a.name)
        .join("、")}など、12の地域です。`,
    );
  });

  test("南海トラフ地震臨時情報は、決まった文・名前と種類・気象庁の見出し", () => {
    const a: Advisory = {
      id: "a1",
      code: "VYSE50",
      eventId: "x",
      title: "南海トラフ地震臨時情報",
      serialName: "巨大地震注意",
      status: "normal",
      infoType: "発表",
      reportedAt: "2026-11-14T00:05:00Z",
      headline:
        "南海トラフ地震の想定震源域では、大規模地震の発生可能性が平常時と比べて相対的に高まっていると考えられます。",
      text: "",
      cancelled: false,
      updatedAt: "2026-11-14T00:05:00Z",
    };
    expect(read({ seq: 9, type: "advisory", data: a })).toEqual([
      OPENINGS.nankai,
      "南海トラフ地震臨時情報、巨大地震注意が発表されました。",
      a.headline,
    ]);
  });

  test("噴火速報は決まった文と気象庁の見出し (記号は読まない)", () => {
    const v: Volcano = {
      id: "VFVO56-1",
      code: "VFVO56",
      eventId: "20261114090000_306",
      status: "normal",
      infoType: "発表",
      reportedAt: "2026-11-14T00:05:00Z",
      eventTime: "2026-11-14T00:04:00Z",
      title: "噴火速報",
      headline: "＜浅間山で噴火が発生＞",
      volcanoes: [{ code: "306", name: "浅間山", kind: "噴火" }],
      cities: [],
      cancelled: false,
      updatedAt: "2026-11-14T00:05:00Z",
    };
    expect(read({ seq: 9, type: "volcano", data: v })).toEqual([
      OPENINGS.eruption,
      "浅間山で噴火が発生",
    ]);
  });

  test("取消・解除は読まない", () => {
    const n = noticeOf(tsunami({ ended: true }), NOW);
    expect(n && readoutOf(n)).toEqual([]);
  });

  test("決まった文は冒頭の文と試しの文で、どれも 1 つの区切り", () => {
    for (const t of FIXED_TEXTS) expect(isFixed(t)).toBe(true);
    expect(isFixed("震源は日向灘です。")).toBe(false);
  });

  test("字の整え: 全角の数字を半角に、括弧と記号は読ませない。多い地域は数で言う", () => {
    expect(clean("東京都２３区（島しょ部を除く）")).toBe(
      "東京都23区、島しょ部を除く",
    );
    expect(listOf(["a", "b", "a"])).toBe("a、b");
    expect(listOf(Array.from({ length: 11 }, (_, i) => `x${i}`))).toMatch(
      /x9など、11の地域$/,
    );
  });
});
