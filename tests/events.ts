/** 通知の判定のテストで使うイベントの組み立て (push.test.ts・alert.test.ts) */
import type { Eew, Quake, SonaeEvent, Tsunami } from "#lib/model.ts";
import { DEFAULT_PREFS, type PushPrefs } from "#lib/push.ts";

export const NOW = Date.parse("2026-11-14T00:10:00Z");

export function quake(over: Partial<Quake> = {}): SonaeEvent {
  const q: Quake = {
    id: "20261114090000",
    eventId: "20261114090000",
    status: "normal",
    originTime: "2026-11-14T09:05:00+09:00",
    hypocenter: { name: "千葉県北西部" },
    magnitude: 5.1,
    maxInt: "4",
    areas: [
      { code: "340", name: "千葉県北西部", int: "4" },
      { code: "350", name: "東京都２３区", int: "3" },
    ],
    stations: [],
    comments: [],
    foreign: false,
    cancelled: false,
    provisional: false,
    sources: ["jma"],
    reports: [],
    updatedAt: "2026-11-14T00:06:00Z",
    ...over,
  };
  return { seq: 1, type: "quake", data: q };
}

export function eew(over: Partial<Eew> = {}): SonaeEvent {
  const e: Eew = {
    eventId: "20261114090800",
    serial: 1,
    issuedAt: "2026-11-14T00:09:30Z",
    kind: "forecast",
    final: false,
    cancelled: false,
    status: "normal",
    assumed: false,
    hypocenter: { name: "茨城県南部" },
    magnitude: 4.8,
    warnAreas: [],
    sources: ["wolfx"],
    updatedAt: "2026-11-14T00:09:30Z",
    ...over,
  };
  return { seq: 2, type: "eew", data: e };
}

export function tsunami(over: Partial<Tsunami> = {}): SonaeEvent {
  const t: Tsunami = {
    id: "20261114085500",
    eventIds: ["20261114085500"],
    status: "normal",
    issuedAt: "2026-11-14T00:00:00Z",
    areas: [
      { name: "岩手県", grade: "watch", kindName: "津波注意報" },
      { name: "宮城県", grade: "forecast", kindName: "津波予報" },
    ],
    observations: [],
    cancelled: false,
    ended: false,
    provisional: false,
    sources: ["jma"],
    updatedAt: "2026-11-14T00:00:00Z",
    ...over,
  };
  return { seq: 3, type: "tsunami", data: t };
}

export const prefs = (over: Partial<PushPrefs> = {}): PushPrefs => ({
  ...DEFAULT_PREFS,
  ...over,
});
