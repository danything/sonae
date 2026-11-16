import { describe, expect, test } from "bun:test";

import { monthGrid, monthLabel, stepMonth } from "#lib/calendar.ts";
import { isTsunamiWarning, type TsunamiGrade } from "#lib/model.ts";
import { showTraining } from "#lib/server/site.ts";
import {
  dayKey,
  dayLabel,
  groupByDay,
  legacyRedirect,
  matches,
  newestFirst,
  pickOnly,
  readOnly,
  readView,
  selectHref,
  viewHref,
} from "#lib/view.ts";

const p = (s: string) => new URLSearchParams(s);
const legacy = (path: string) =>
  legacyRedirect(new URL(path, "https://s.example"));

describe("URL の query (readView)", () => {
  test("何も無ければ何も選んでいない", () => {
    expect(readView(p(""))).toEqual({
      selected: null,
      about: false,
    });
  });

  test("選んだもの", () => {
    const v = readView(p("t=abc"));
    expect(v.selected).toEqual({ kind: "tsunami", id: "abc" });
  });

  test("出典の窓 (前の一覧の種類 k と訓練・試験の印 training は読まない)", () => {
    const v = readView(p("k=eew&training=1&about=1"));
    expect(v).not.toHaveProperty("kind");
    expect(v).not.toHaveProperty("training");
    expect(v.about).toBe(true);
  });
});

describe("緊急地震速報の訓練・試験を一覧に出すか (SONAE_TRAINING)", () => {
  test("既定は出さない。on のときだけ出す", () => {
    expect(showTraining({})).toBe(false);
    expect(showTraining({ SONAE_TRAINING: "" })).toBe(false);
    expect(showTraining({ SONAE_TRAINING: "1" })).toBe(false);
    expect(showTraining({ SONAE_TRAINING: "off" })).toBe(false);
    expect(showTraining({ SONAE_TRAINING: "on" })).toBe(true);
    expect(showTraining({ SONAE_TRAINING: " on " })).toBe(true);
  });
});

describe("リンク (viewHref・selectHref)", () => {
  test("選ぶものは 1 つだけ。ほかの選んだものは外す", () => {
    expect(selectHref(p("t=x&about=1"), "quake", "a/b")).toBe(
      "/?about=1&q=a%2Fb",
    );
  });

  test("前の一覧の種類 k は外し、空なら /", () => {
    expect(viewHref(p("k=tsunami&q=1"), { q: null })).toBe("/");
    expect(selectHref(p("k=quake"), "weather", "office-1")).toBe(
      "/?w=office-1",
    );
  });

  test("ほかの鍵は残す", () => {
    expect(viewHref(p("about=1&e=9"), { e: null })).toBe("/?about=1");
  });

  test("前の訓練・試験の印 training は外す (環境変数 SONAE_TRAINING に移した)", () => {
    expect(viewHref(p("training=1&e=9"), { e: null })).toBe("/");
    expect(selectHref(p("training=1"), "eew", "e1")).toBe("/?e=e1");
  });
});

describe("一覧で出す 1 つの種類 (readOnly・pickOnly)", () => {
  test("既定は全部 (null)。知らない種類と壊れた値も全部", () => {
    expect(readOnly(null)).toBeNull();
    expect(readOnly("{壊れた")).toBeNull();
    expect(readOnly("nope")).toBeNull();
    // 前の形 (隠す種類の配列) は読まない
    expect(readOnly('["foreign"]')).toBeNull();
    expect(readOnly("weather")).toBe("weather");
  });

  test("全部のときに押すとその種類だけ、もう一度押すと全部、別のを押すと切り替え", () => {
    expect(pickOnly(null, "quake")).toBe("quake");
    expect(pickOnly("quake", "quake")).toBeNull();
    expect(pickOnly("quake", "weather")).toBe("weather");
  });

  test("「すべて」を押すといつも全部", () => {
    expect(pickOnly("weather", null)).toBeNull();
    expect(pickOnly(null, null)).toBeNull();
  });
});

describe("前の画面の URL (legacyRedirect)", () => {
  test.each([
    ["/quakes/20261113084300", "/?q=20261113084300"],
    ["/quakes/a%2Fb", "/?q=a%2Fb"],
    ["/tsunami/t-1", "/?t=t-1"],
    ["/tsunami", "/"],
    ["/tsunami/", "/"],
    ["/eew", "/"],
    ["/eew?training=1", "/"],
    ["/map", "/"],
    ["/map?quake=q1", "/?q=q1"],
    ["/about", "/?about=1"],
  ])("%s → %s", (from, to) => {
    expect(legacy(from)).toBe(to);
  });

  test.each(["/", "/api/stream", "/health", "/auth/login", "/quakes"])(
    "%s は読み替えない",
    (path) => {
      expect(legacy(path)).toBeNull();
    },
  );
});

describe("日ごとに束ねる", () => {
  test("日付は日本時間で数える (UTC の 15 時は次の日)", () => {
    expect(dayKey("2026-11-13T14:59:00Z")).toBe("2026-11-13");
    expect(dayKey("2026-11-13T15:00:00Z")).toBe("2026-11-14");
    expect(dayKey(undefined)).toBe("");
  });

  test("見出しは「11 月 13 日 (金)」", () => {
    expect(dayLabel("2026-11-13")).toBe("11 月 13 日 (金)");
    expect(dayLabel("")).toBe("日時の不明なもの");
  });

  test("並びはそのまま、続く同じ日を 1 つに", () => {
    const items = [
      "2026-11-14T01:00:00Z",
      "2026-11-13T20:00:00Z",
      "2026-11-13T10:00:00Z",
    ];
    expect(groupByDay(items, (x) => x)).toEqual([
      { day: "2026-11-14", items: items.slice(0, 2) },
      { day: "2026-11-13", items: items.slice(2) },
    ]);
  });
});

test("1 本の一覧: 種類をまたいで新しい順。同じ時刻は元の順、読めない時刻は後ろ", () => {
  const items = [
    { k: "quake", at: "2026-11-14T01:00:00Z" },
    { k: "weather", at: "2026-11-14T03:00:00Z" },
    { k: "info", at: undefined },
    { k: "eew", at: "2026-11-14T01:00:00Z" },
    { k: "volcano", at: "2026-11-14T02:00:00+09:00" },
  ];
  expect(newestFirst(items, (x) => x.at).map((x) => x.k)).toEqual([
    "weather",
    "quake",
    "eew",
    "volcano",
    "info",
  ]);
});

test("一覧の先頭に出す津波は、大津波警報と津波警報だけ", () => {
  const t = (...grades: TsunamiGrade[]) => ({
    areas: grades.map((grade) => ({ name: "x", grade, kindName: "" })),
  });
  expect(isTsunamiWarning(t("watch", "major"))).toBe(true);
  expect(isTsunamiWarning(t("warning"))).toBe(true);
  expect(isTsunamiWarning(t("watch", "forecast"))).toBe(false);
  expect(isTsunamiWarning(t())).toBe(false);
});

test("絞り込みは、空白で区切った言葉がどれも入っていれば当たり", () => {
  expect(matches("", "石川県能登地方")).toBe(true);
  expect(matches("能登", "石川県能登地方")).toBe(true);
  expect(matches("石川 能登", "石川県能登地方", undefined)).toBe(true);
  expect(matches("宮城", "石川県能登地方")).toBe(false);
});

describe("カレンダー", () => {
  test("2026 年 11 月は日曜に始まり 5 週", () => {
    const weeks = monthGrid("2026-11");
    expect(weeks).toHaveLength(5);
    expect(weeks[0]?.[0]).toBe("2026-11-01");
    expect(weeks.at(-1)?.filter(Boolean).at(-1)).toBe("2026-11-30");
    expect(monthLabel("2026-11")).toBe("2026 年 11 月");
  });

  test("行き来は並んだ月の中だけ", () => {
    const months = ["2026-08", "2026-10", "2026-11"];
    expect(stepMonth(months, "2026-11", -1)).toBe("2026-10");
    expect(stepMonth(months, "2026-10", -1)).toBe("2026-08");
    expect(stepMonth(months, "2026-11", 1)).toBeNull();
  });
});
