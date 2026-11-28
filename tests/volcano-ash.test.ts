import { describe, expect, test } from "bun:test";

import {
  ashBounds,
  ashDefaultWindow,
  ashDrawn,
  ashExplain,
  ashFeatures,
  ashLegend,
  ashStripeImage,
  ashStyle,
  ashWindowTitle,
} from "#lib/map/ash.ts";
import { HIDDEN_UNDER_HAZARD, overlayVisibility } from "#lib/map/style.ts";
import type { AshWindow, Volcano } from "#lib/model.ts";
import { parseJmaXml, readAshPolygon } from "#lib/server/sources/jma-xml.ts";

import { codeOf, fixture, jmaIncoming, memoryStore } from "./helpers.ts";

const TEIJI = "66_01_01_210517_VFVO53.xml"; // 桜島 降灰予報 (定時)
const SOKUHO = "66_01_02_210514_VFVO54.xml"; // 桜島 降灰予報 (速報)
const SHOSAI = "66_01_03_210514_VFVO55.xml"; // 桜島 降灰予報 (詳細)
const KAZANBAI = "66_02_02_261118_VFVO54.xml"; // 霧島山 (新燃岳) 火山灰予報 (速報)

function ashOf(file: string): AshWindow[] {
  const [item] = parseJmaXml(fixture(`jma/${file}`), codeOf(file));
  if (item?.type !== "volcano") throw new Error("火山ではありません");
  return item.ash ?? [];
}

describe("電文の範囲を読む", () => {
  test("多角形は [経度, 緯度] の並びで、閉じていなければ閉じる。点が 3 つ未満は捨てる", () => {
    expect(
      readAshPolygon("+31.59+130.64/+31.58+130.66/+31.57+130.64/"),
    ).toEqual([
      [130.64, 31.59],
      [130.66, 31.58],
      [130.64, 31.57],
      [130.64, 31.59],
    ]);
    expect(readAshPolygon("+31.59+130.64/+31.58+130.66/")).toEqual([]);
    expect(readAshPolygon(undefined)).toEqual([]);
  });

  test("定時: 3 時間ごとの 6 つの区切り。降灰 (70) と小さな噴石の落下 (75)", () => {
    const w = ashOf(TEIJI);
    expect(w).toHaveLength(6);
    expect(w[0]?.label).toBe("３時間後");
    expect(w[0]?.start).toBe("2021-05-17T15:00:00+09:00");
    expect(w[0]?.end).toBe("2021-05-17T18:00:00+09:00");
    expect(w[0]?.areas.map((a) => a.code)).toEqual(["70", "75"]);
    const lapilli = w[0]?.areas[1];
    expect(lapilli?.name).toBe("小さな噴石の落下");
    expect(lapilli?.size).toBe("1 cm");
    expect(lapilli?.distance).toBe("5 km");
    expect(lapilli?.direction).toBe("東");
    const ring = lapilli?.polygons[0] ?? [];
    expect(ring[0]).toEqual(ring.at(-1));
    expect(ring[0]).toEqual([130.66, 31.5988]);
  });

  test("速報と詳細: 降灰の量ごとの範囲。詳細は噴火から 1〜6 時間後まで", () => {
    const s = ashOf(SOKUHO);
    expect(s).toHaveLength(1);
    expect(s[0]?.areas.map((a) => [a.code, a.name])).toEqual([
      ["72", "やや多量の降灰"],
      ["71", "少量の降灰"],
      ["75", "小さな噴石の落下"],
    ]);
    expect(s[0]?.areas[0]?.direction).toBe("西（鹿児島市街方向）");
    const d = ashOf(SHOSAI);
    expect(d.map((w) => w.label)).toEqual([
      "１時間後",
      "２時間後",
      "３時間後",
      "４時間後",
      "５時間後",
      "６時間後",
    ]);
  });

  test("火山灰予報 (名前が変わる予定の新しい形の電文): 深さごとの範囲 (31〜37) と小さな噴石 (40)", () => {
    const w = ashOf(KAZANBAI);
    expect(w).toHaveLength(1);
    expect(w[0]?.areas.map((a) => a.code)).toEqual([
      "37",
      "36",
      "35",
      "34",
      "33",
      "32",
      "31",
      "40",
    ]);
    expect(w[0]?.areas[0]?.size).toBe("300.0 mm");
  });

  test("降灰予報でない火山の報には範囲を付けない", () => {
    const [item] = parseJmaXml(
      fixture("jma/45_01_01_200522_VFVO50.xml"),
      "VFVO50",
    );
    expect(item?.type === "volcano" && item.ash).toBeFalsy();
  });
});

describe("保存", () => {
  test("報の id ごとに範囲を置き、一覧の報には持たせない", () => {
    const { store } = memoryStore("2021-05-14T04:00:00Z");
    const [e] = store.ingest(jmaIncoming(SOKUHO));
    const v = e?.data as Volcano;
    expect(JSON.stringify(v)).not.toContain("polygons");
    const ash = store.volcanoAsh(v.id);
    expect(ash?.code).toBe("VFVO54");
    expect(ash?.windows[0]?.areas).toHaveLength(3);
    expect(store.volcanoAsh("VFVO54-506-0")).toBeUndefined();
  });

  test("定時は火山ごとにいちばん新しい報だけを残す", () => {
    const { store } = memoryStore("2021-05-17T05:00:00Z");
    const body = fixture(`jma/${TEIJI}`);
    const later = body
      .replaceAll("2021-05-17T14:00:00+09:00", "2021-05-17T17:00:00+09:00")
      .replace(
        /<DateTime>[^<]+<\/DateTime>/,
        "<DateTime>2021-05-17T08:00:00Z</DateTime>",
      );
    const [a] = store.ingest(jmaIncoming(TEIJI));
    const [b] = store.ingest({
      ...jmaIncoming(TEIJI),
      key: "later",
      body: later,
      items: parseJmaXml(later, "VFVO53"),
    });
    const first = (a?.data as Volcano | undefined)?.id ?? "";
    const second = (b?.data as Volcano | undefined)?.id ?? "";
    expect(first).not.toBe(second);
    expect(store.volcanoAsh(first)).toBeUndefined();
    expect(store.volcanoAsh(second)?.windows).toHaveLength(6);
    // 古い報があとから届いても、新しい報の範囲だけを残す
    const early = body
      .replaceAll("2021-05-17T14:00:00+09:00", "2021-05-17T11:00:00+09:00")
      .replace(
        /<DateTime>[^<]+<\/DateTime>/,
        "<DateTime>2021-05-17T02:00:00Z</DateTime>",
      );
    const [c] = store.ingest({
      ...jmaIncoming(TEIJI),
      key: "early",
      body: early,
      items: parseJmaXml(early, "VFVO53"),
    });
    const third = (c?.data as Volcano | undefined)?.id ?? "";
    expect(third).not.toBe(second);
    expect(store.volcanoAsh(third)).toBeUndefined();
    expect(store.volcanoAsh(second)?.windows).toHaveLength(6);
  });

  test("古い範囲は原文と同じ 30 日で捨てる", () => {
    const { store, advance } = memoryStore("2021-05-14T04:00:00Z");
    const [e] = store.ingest(jmaIncoming(SOKUHO));
    const id = (e?.data as Volcano | undefined)?.id ?? "";
    advance(31 * 86400_000);
    store.prune();
    expect(store.volcanoAsh(id)).toBeUndefined();
  });
});

describe("地図", () => {
  test("描くのは取り消されていない降灰予報だけ", () => {
    const v = { code: "VFVO53", cancelled: false } as Volcano;
    expect(ashDrawn(v)).toBe(true);
    expect(ashDrawn({ ...v, cancelled: true })).toBe(false);
    expect(ashDrawn({ ...v, code: "VFVO50" })).toBe(false);
    expect(ashDrawn(null)).toBe(false);
  });

  test("色は気象庁の降灰予報の地図のまま。火山灰予報の深さは降灰量階級の境で当てる", () => {
    expect(ashStyle({ code: "71", name: "少量の降灰" }).fill).toBe("#b0b0b4");
    expect(ashStyle({ code: "72", name: "やや多量の降灰" }).fill).toBe(
      "#faf500",
    );
    expect(ashStyle({ code: "73", name: "多量の降灰" }).fill).toBe("#ff2800");
    expect(ashStyle({ code: "75", name: "小さな噴石の落下" }).stripe).toBe(
      true,
    );
    expect(ashStyle({ code: "31", name: "" }).fill).toBe("#b0b0b4");
    expect(ashStyle({ code: "32", name: "" }).fill).toBe("#faf500");
    expect(ashStyle({ code: "37", name: "" }).fill).toBe("#ff2800");
    expect(ashStyle({ code: "40", name: "小さな噴石の落下" }).stripe).toBe(
      true,
    );
    // 深いものほど上に重ねる
    expect(ashStyle({ code: "37", name: "" }).order).toBeGreaterThan(
      ashStyle({ code: "33", name: "" }).order,
    );
  });

  test("選んだ区切りの範囲を 1 つの種類ごとに 1 つの面にする", () => {
    const fc = ashFeatures(ashOf(SHOSAI), 0) as {
      features: { geometry: { type: string }; properties: { fill: string } }[];
    };
    expect(fc.features.map((f) => f.properties.fill)).toEqual([
      "#faf500",
      "#b0b0b4",
    ]);
    expect(fc.features[0]?.geometry.type).toBe("Polygon");
    expect(
      (ashFeatures(ashOf(SHOSAI), 99) as { features: unknown[] }).features,
    ).toEqual([]);
  });

  test("凡例は重い順で、同じ見た目の種類は 1 行にまとめる", () => {
    const l = ashLegend(ashOf(KAZANBAI)[0]);
    expect(l.map((r) => r.name)).toEqual([
      "小さな噴石の落下",
      "30cm以上の火山灰・10cm以上の火山灰・3cm以上の火山灰・1cm以上の火山灰・1mm以上の火山灰",
      "0.1mm以上の火山灰",
      "0.1mm未満の火山灰",
    ]);
  });

  test("初めに見せるのは、まだ終わっていない区切りのいちばん早いもの", () => {
    const w = ashOf(TEIJI);
    expect(ashDefaultWindow(w, Date.parse("2021-05-17T16:00:00+09:00"))).toBe(
      0,
    );
    expect(ashDefaultWindow(w, Date.parse("2021-05-17T22:00:00+09:00"))).toBe(
      2,
    );
    expect(ashDefaultWindow(w, Date.parse("2021-05-19T00:00:00+09:00"))).toBe(
      5,
    );
  });

  test("いつの予想か: 定時は区切りの初めと終わり、詳細は終わり、速報は噴火から 1 時間", () => {
    expect(ashWindowTitle("VFVO53", ashOf(TEIJI)[0])).toBe("17日15時〜18時");
    expect(ashWindowTitle("VFVO55", ashOf(SHOSAI)[0])).toBe("14日14時まで");
    expect(ashWindowTitle("VFVO54", ashOf(SOKUHO)[0])).toBe(
      "噴火から 1 時間以内",
    );
    expect(ashExplain("VFVO53", undefined)).toContain(
      "いま降っている所ではありません",
    );
    expect(ashExplain("VFVO55", "2021-05-14T12:31:00+09:00")).toContain(
      "14日12時31分頃の噴火から",
    );
  });

  test("範囲が収まる [西, 南, 東, 北]", () => {
    const b = ashBounds(ashOf(SOKUHO));
    expect(b?.[0]).toBeLessThan(130.65);
    expect(b?.[2]).toBeGreaterThan(130.66);
    expect(ashBounds([])).toBeUndefined();
  });

  test("ハザードマップを重ねている間は範囲の塗りを隠し、縁は残す", () => {
    expect(HIDDEN_UNDER_HAZARD).toContain("ash-fill");
    const v = overlayVisibility("flood", Number.POSITIVE_INFINITY, true);
    expect(v["ash-fill"]).toBe(false);
    expect(v["ash-line"]).toBeUndefined();
  });

  test("噴石の縞の画像は白地に赤", () => {
    const img = ashStripeImage(10);
    expect(img.data).toHaveLength(400);
    expect(Array.from(img.data.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(img.data.subarray(20, 24))).toEqual([255, 255, 255, 255]);
  });
});
