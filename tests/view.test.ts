import { describe, expect, test } from "bun:test";

import { monthGrid, monthLabel, stepMonth } from "#lib/calendar.ts";
import {
  dayKey,
  dayLabel,
  groupByDay,
  legacyRedirect,
  matches,
  readView,
  selectHref,
  viewHref,
} from "#lib/view.ts";

const p = (s: string) => new URLSearchParams(s);
const legacy = (path: string) =>
  legacyRedirect(new URL(path, "https://s.example"));

describe("URL の query (readView)", () => {
  test("何も無ければ地震の一覧で、何も選んでいない", () => {
    expect(readView(p(""))).toEqual({
      kind: "quake",
      selected: null,
      training: false,
      about: false,
    });
  });

  test("選んだものの種類が一覧の種類になる (k が無いとき)", () => {
    const v = readView(p("t=abc"));
    expect(v.kind).toBe("tsunami");
    expect(v.selected).toEqual({ kind: "tsunami", id: "abc" });
  });

  test("知らない k は捨てる", () => {
    expect(readView(p("k=nope")).kind).toBe("quake");
  });

  test("訓練と出典の窓", () => {
    const v = readView(p("k=eew&training=1&about=1"));
    expect(v.kind).toBe("eew");
    expect(v.training).toBe(true);
    expect(v.about).toBe(true);
  });
});

describe("リンク (viewHref・selectHref)", () => {
  test("選ぶものは 1 つだけ。ほかの選んだものは外す", () => {
    expect(selectHref(p("t=x&training=1"), "quake", "a/b")).toBe(
      "/?training=1&q=a%2Fb",
    );
  });

  test("既定の k=quake は書かず、空なら /", () => {
    expect(viewHref(p("q=1"), { k: "quake", q: null })).toBe("/");
  });

  test("ほかの鍵は残す", () => {
    expect(viewHref(p("k=eew&training=1&e=9"), { e: null })).toBe(
      "/?k=eew&training=1",
    );
  });
});

describe("前の画面の URL (legacyRedirect)", () => {
  test.each([
    ["/quakes/20261113084300", "/?q=20261113084300"],
    ["/quakes/a%2Fb", "/?q=a%2Fb"],
    ["/tsunami/t-1", "/?k=tsunami&t=t-1"],
    ["/tsunami", "/?k=tsunami"],
    ["/tsunami/", "/?k=tsunami"],
    ["/eew", "/?k=eew"],
    ["/eew?training=1", "/?k=eew&training=1"],
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
