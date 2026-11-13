import { describe, expect, test } from "bun:test";

import { volcanoMarks } from "#lib/map/style.ts";
import {
  latestPerVolcano,
  type SonaeEvent,
  type Volcano,
  volcanoLevel,
  volcanoTop,
} from "#lib/model.ts";
import { matches, noticeOf } from "#lib/notify.ts";
import { DEFAULT_PREFS, normalizePrefs } from "#lib/push.ts";
import {
  parseJmaXml,
  readVolcanoCoordinate,
  WANTED_CODES,
} from "#lib/server/sources/jma-xml.ts";
import type { Incoming } from "#lib/server/sources/types.ts";

import { codeOf, fixture, memoryStore } from "./helpers.ts";

const ASAMA = "45_01_01_200522_VFVO50.xml"; // 浅間山 レベル 1 → 3 引上げ
const HAKONE = "45_02_01_200522_VFVO50.xml"; // 箱根山 レベル 1 → 5 引上げ
const KUSATSU = "45_03_01_200731_VFVO50.xml"; // 草津白根山 レベル 2 → 1 引下げ (警報解除)
const ONTAKE = "67_01_01_140927_VFVO56.xml"; // 御嶽山 噴火速報
const ONTAKE_FIX = "67_01_03_140927_VFVO56.xml"; // 同じ噴火速報の訂正
const ONTAKE_CANCEL = "67_01_04_140927_VFVO56.xml"; // 同じ噴火速報の取消

function volcano(file: string): Omit<Volcano, "updatedAt" | "cancelled"> {
  const items = parseJmaXml(fixture(`jma/${file}`), codeOf(file));
  expect(items).toHaveLength(1);
  const item = items[0];
  if (item?.type !== "volcano") throw new Error("火山ではありません");
  return item.volcano;
}
const incoming = (file: string): Incoming => {
  const body = fixture(`jma/${file}`);
  return {
    source: "jma",
    key: file,
    code: codeOf(file),
    body,
    items: parseJmaXml(body, codeOf(file)),
  };
};
const event = (v: Volcano, at = v.reportedAt): SonaeEvent => ({
  seq: 1,
  type: "volcano",
  data: { ...v, reportedAt: at },
});
const full = (file: string, over: Partial<Volcano> = {}): Volcano => ({
  ...volcano(file),
  cancelled: false,
  updatedAt: "2026-11-14T00:00:00Z",
  ...over,
});

describe("電文を読む", () => {
  test("取る種別に噴火警報・予報と噴火速報が入っている", () => {
    expect(WANTED_CODES.has("VFVO50")).toBe(true);
    expect(WANTED_CODES.has("VFVO56")).toBe(true);
    // 降灰予報・解説情報などはまだ取らない
    expect(WANTED_CODES.has("VFVO53")).toBe(false);
  });

  test("火山の位置は度分 (36 度 24.38 分) で、度に直す", () => {
    expect(readVolcanoCoordinate("+3624.38+13831.38+2568/")).toEqual({
      lat: 36.406,
      lon: 138.523,
    });
    expect(readVolcanoCoordinate("+36.4+138.5/")).toEqual({
      lat: 36.4,
      lon: 138.5,
    });
    expect(readVolcanoCoordinate("")).toBeUndefined();
  });

  test("噴火警報・予報: 火山・レベル・対象の市町村・本文", () => {
    const v = volcano(ASAMA);
    expect(v.code).toBe("VFVO50");
    expect(v.eventId).toBe("306");
    expect(v.title).toBe("浅間山 噴火警報（火口周辺）");
    expect(v.volcanoes).toEqual([
      {
        code: "306",
        name: "浅間山",
        lat: 36.406,
        lon: 138.523,
        kind: "レベル３（入山規制）",
        kindCode: "13",
        condition: "引上げ",
        lastKind: "レベル１（活火山であることに留意）",
        level: 3,
      },
    ]);
    expect(v.warning).toEqual({
      name: "火口周辺警報",
      code: "02",
      condition: "発表",
    });
    expect(v.cities).toContain("長野県軽井沢町");
    expect(v.headline).toContain("噴火警戒レベル３");
    expect(v.activity).toContain("火映");
    expect(v.prevention).toContain("大きな噴石");
  });

  test("レベル 5 の噴火警報と、警報の解除", () => {
    expect(volcanoTop(full(HAKONE))).toBe(5);
    expect(full(HAKONE).warning?.code).toBe("01");
    const k = volcano(KUSATSU);
    expect(k.volcanoes[0]?.level).toBe(1);
    expect(k.volcanoes[0]?.condition).toBe("引下げ");
    expect(k.warning?.code).toBe("04");
  });

  test("噴火速報: 噴火の時刻があり、位置とレベルは無い", () => {
    const v = volcano(ONTAKE);
    expect(v.code).toBe("VFVO56");
    expect(v.eventId).toBe("20140927120000_312");
    expect(v.eventTime).toBe("2014-09-27T11:53:00+09:00");
    expect(v.volcanoes[0]).toMatchObject({
      code: "312",
      name: "御嶽山",
      kind: "噴火",
    });
    expect(v.volcanoes[0]?.lat).toBeUndefined();
    expect(v.volcanoes[0]?.level).toBeUndefined();
    expect(v.cities).toContain("長野県王滝村");
  });

  test("警戒の段: レベルの無い火山・海底火山も同じ色の段に読み替える", () => {
    expect(volcanoLevel("15")).toBe(5);
    expect(volcanoLevel("25")).toBe(5); // 居住地域厳重警戒
    expect(volcanoLevel("24")).toBe(4); // 山麓厳重警戒
    expect(volcanoLevel("36")).toBe(3); // 周辺海域警戒
    expect(volcanoLevel("52")).toBeUndefined(); // 噴火 (噴火速報)
  });
});

describe("保存", () => {
  test("報ごとに 1 行。訂正は前の報を置き換え、取消は印を付ける", () => {
    const { store } = memoryStore();
    const one = (file: string): Volcano => {
      const [e] = store.ingest(incoming(file));
      if (e?.type !== "volcano") throw new Error("火山ではありません");
      return e.data;
    };
    const { id } = one(ONTAKE);
    const fixed = one(ONTAKE_FIX);
    expect(fixed.id).toBe(id);
    expect(fixed.headline).toContain("発生したもよう");
    const cancelled = one(ONTAKE_CANCEL);
    expect(cancelled.id).toBe(id);
    expect(cancelled.cancelled).toBe(true);
    expect(store.volcanoes()).toHaveLength(1);
    expect(store.volcano(id)?.cancelled).toBe(true);
    // 同じ電文をもう一度受けても何もしない
    expect(store.ingest(incoming(ONTAKE_CANCEL))).toEqual([]);
  });

  test("火山ごとのいまの噴火警報・予報は、いちばん新しい報 (噴火速報は入らない)", () => {
    const { store } = memoryStore();
    store.ingest(incoming(ASAMA));
    store.ingest(incoming(HAKONE));
    store.ingest(incoming(ONTAKE));
    const levels = store.volcanoLevels();
    expect(levels.map((v) => v.eventId).sort()).toEqual(["306", "315"]);
  });

  test("取り消された報は飛ばして、その前の報を採る", () => {
    const older = full(ASAMA, { id: "a", reportedAt: "2020-05-21T00:00:00Z" });
    const newer = full(ASAMA, {
      id: "b",
      reportedAt: "2020-05-22T00:00:00Z",
      cancelled: true,
    });
    expect(latestPerVolcano([newer, older]).map((v) => v.id)).toEqual(["a"]);
  });
});

describe("通知", () => {
  const at = (v: Volcano) => Date.parse(v.eventTime ?? v.reportedAt) + 60_000;

  test("既定: 噴火速報とレベル 4・5 は知らせ、レベル 3 は知らせない", () => {
    const flash = full(ONTAKE);
    const n = noticeOf(event(flash), at(flash));
    if (!n) throw new Error("通知が無い");
    expect(n.title).toBe("噴火速報 御嶽山");
    expect(n.urgency).toBe("high");
    expect(n.url).toBe(`/?k=volcano&v=${encodeURIComponent(flash.id)}`);
    expect(matches(n, DEFAULT_PREFS)).toBe(true);

    const hakone = full(HAKONE);
    const n5 = noticeOf(event(hakone), at(hakone));
    if (!n5) throw new Error("通知が無い");
    expect(n5.level).toBe(5);
    expect(n5.sticky).toBe(true);
    expect(matches(n5, DEFAULT_PREFS)).toBe(true);

    const asama = full(ASAMA);
    const n3 = noticeOf(event(asama), at(asama));
    if (!n3) throw new Error("通知が無い");
    expect(matches(n3, DEFAULT_PREFS)).toBe(false);
    expect(matches(n3, { ...DEFAULT_PREFS, volcano: "all" })).toBe(true);
    expect(matches(n5, { ...DEFAULT_PREFS, volcano: "off" })).toBe(false);
  });

  test("警報の解除と取消は、前に知らせた所にだけ送る (closing)", () => {
    const k = full(KUSATSU);
    expect(noticeOf(event(k), at(k))?.closing).toBe(true);
    const c = full(ONTAKE, { cancelled: true });
    const n = noticeOf(event(c), at(c));
    expect(n?.closing).toBe(true);
    expect(n?.title).toContain("取消");
  });

  test("6 時間より古い報は知らせない", () => {
    const flash = full(ONTAKE);
    expect(noticeOf(event(flash), at(flash) + 6 * 60 * 60_000 + 1)).toBeNull();
  });

  test("条件の読み直し: 知らない値は既定に戻す", () => {
    expect(normalizePrefs({ volcano: "all" }).volcano).toBe("all");
    expect(normalizePrefs({ volcano: "loud" }).volcano).toBe("warning");
  });
});

describe("地図の印", () => {
  const points: Record<string, [number, number, string?]> = {
    "312": [137.48, 35.893, "御嶽山"],
  };

  test("レベル 2 以上の火山と、選んだ報の火山。位置が電文に無ければ表から引く", () => {
    const asama = full(ASAMA);
    const kusatsu = full(KUSATSU);
    const flash = full(ONTAKE);
    const marks = volcanoMarks([asama, kusatsu], flash, points);
    expect(marks.map((m) => [m.code, m.level, m.selected])).toEqual([
      ["306", 3, false],
      ["312", undefined, true],
    ]);
    expect(marks[1]?.at).toEqual([137.48, 35.893]);
  });

  test("位置が分からない火山は置かない", () => {
    expect(volcanoMarks([], full(ONTAKE), {})).toEqual([]);
  });
});
