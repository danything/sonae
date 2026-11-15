import { describe, expect, test } from "bun:test";

import {
  isGrave,
  openHref,
  type OpenState,
  planOpen,
  targetOf,
} from "#lib/auto-open.ts";
import type { SonaeEvent } from "#lib/model.ts";
import { type Notice, noticeOf } from "#lib/notify.ts";

import { eew, NOW, quake, tsunami } from "./events.ts";

const notice = (e: SonaeEvent): Notice => {
  const n = noticeOf(e, NOW);
  if (!n) throw new Error("通知にならない");
  return n;
};
const idle: OpenState = {
  selected: null,
  auto: false,
  holdingEew: false,
  dialog: false,
};
const quakeTarget = { kind: "quake", id: "q2" } as const;
const eewTarget = { kind: "eew", id: "e1" } as const;

describe("命に関わるもの (isGrave)", () => {
  test("緊急地震速報は予報も警報も。取消は違う", () => {
    expect(isGrave(notice(eew()))).toBe(true);
    expect(isGrave(notice(eew({ kind: "warning" })))).toBe(true);
    expect(isGrave(notice(eew({ cancelled: true })))).toBe(false);
  });
  test("津波は津波警報と大津波警報だけ", () => {
    const grade = (g: "watch" | "warning" | "major") =>
      notice(tsunami({ areas: [{ name: "岩手県", grade: g, kindName: "" }] }));
    expect(isGrave(grade("watch"))).toBe(false);
    expect(isGrave(grade("warning"))).toBe(true);
    expect(isGrave(grade("major"))).toBe(true);
    expect(isGrave(notice(tsunami({ ended: true })))).toBe(false);
  });
  test("地震情報は震度が大きくても違う", () => {
    expect(isGrave(notice(quake({ maxInt: "7" })))).toBe(false);
  });
  test("気象は特別警報 (重さ 5) だけ", () => {
    const base = notice(quake());
    const warning = (level: number): Notice => ({
      ...base,
      level,
      event: { seq: 1, type: "warning" } as unknown as SonaeEvent,
    });
    expect(isGrave(warning(5))).toBe(true);
    expect(isGrave(warning(3))).toBe(false);
  });
});

describe("通知の開く所 (targetOf)", () => {
  test("通知の url から選ぶものを読む", () => {
    expect(targetOf(notice(quake()).url)).toEqual({
      kind: "quake",
      id: "20261114090000",
    });
    expect(targetOf(notice(eew()).url)).toEqual({
      kind: "eew",
      id: "20261114090800",
    });
    expect(targetOf("/?w=office-130000")).toEqual({
      kind: "weather",
      id: "office-130000",
    });
  });
  test("選ぶものが無ければ null", () => {
    expect(targetOf("/")).toBeNull();
  });
});

describe("自動で開くか (planOpen)", () => {
  test("何も選んでいなければ開き、履歴を積む (戻るで一覧へ)", () => {
    expect(planOpen(quakeTarget, false, idle)).toEqual({
      replace: false,
      closeDialog: false,
    });
  });
  test("自動で開いたものを見ている間は、続けて読む報に置き換える (履歴を積み上げない)", () => {
    const s = { ...idle, selected: { kind: "quake", id: "q1" }, auto: true };
    expect(planOpen(quakeTarget, false, s as OpenState)).toEqual({
      replace: true,
      closeDialog: false,
    });
  });
  test("人がほかのものを選んで見ているときは、軽いものでは替えない", () => {
    const s = { ...idle, selected: { kind: "quake", id: "q1" } } as OpenState;
    expect(planOpen(quakeTarget, false, s)).toBeNull();
    // 命に関わるものは替える (戻るで見ていたものへ)
    expect(planOpen(eewTarget, true, s)).toEqual({
      replace: false,
      closeDialog: false,
    });
  });
  test("窓が開いているときは、軽いものでは開かない。命に関わるものは窓を閉じて開く", () => {
    const s = { ...idle, dialog: true };
    expect(planOpen(quakeTarget, false, s)).toBeNull();
    expect(planOpen(eewTarget, true, s)).toEqual({
      replace: false,
      closeDialog: true,
    });
  });
  test("もう開いているものは開き直さない (窓があれば閉じるだけ)", () => {
    const s = { ...idle, selected: eewTarget, auto: true } as OpenState;
    expect(planOpen(eewTarget, true, s)).toBeNull();
    expect(planOpen(eewTarget, true, { ...s, dialog: true })).toEqual({
      replace: true,
      closeDialog: true,
    });
  });
  test("出ている緊急地震速報を見ている間は、ほかの緊急地震速報でなければ替えない", () => {
    const s = {
      ...idle,
      selected: eewTarget,
      auto: true,
      holdingEew: true,
    } as OpenState;
    expect(planOpen(quakeTarget, false, s)).toBeNull();
    expect(planOpen({ kind: "tsunami", id: "t1" }, true, s)).toBeNull();
    expect(planOpen({ kind: "eew", id: "e2" }, true, s)).toEqual({
      replace: true,
      closeDialog: false,
    });
  });
});

describe("開くリンク (openHref)", () => {
  test("訓練・試験を出すかは残し、選ぶものは 1 つにする", () => {
    const p = new URLSearchParams("training=1&q=old");
    expect(openHref(p, eewTarget, false)).toBe("/?training=1&e=e1");
  });
  test("窓を閉じるときは「出典と注意」も外す", () => {
    const p = new URLSearchParams("about=1");
    expect(openHref(p, eewTarget, true)).toBe("/?e=e1");
    expect(openHref(p, eewTarget, false)).toBe("/?about=1&e=e1");
  });
});
