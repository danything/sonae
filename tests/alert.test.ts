import { describe, expect, test } from "bun:test";

import {
  alertFor,
  parseAlertPrefs,
  parseAlertSettings,
  spokenText,
} from "#lib/alert.ts";
import { chimeWav } from "#lib/chime.ts";
import type { Sent } from "#lib/notify.ts";
import { DEFAULT_PREFS } from "#lib/push.ts";
import { digestOf, noticeOf, plan } from "#lib/server/notify.ts";

import { eew, NOW, prefs, quake, tsunami } from "./events.ts";

describe("開いているときの音と読み上げの設定", () => {
  test("既定は音も読み上げもオフ。読めない値もオフ", () => {
    expect(parseAlertSettings(null)).toEqual({ sound: false, speech: false });
    expect(parseAlertSettings("{")).toEqual({ sound: false, speech: false });
    expect(parseAlertSettings('{"sound":"yes","speech":true}')).toEqual({
      sound: false,
      speech: true,
    });
  });

  test("条件は Web Push と同じ既定。読めない項目は既定に戻す", () => {
    expect(parseAlertPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parseAlertPrefs("not json")).toEqual(DEFAULT_PREFS);
    expect(parseAlertPrefs('{"tsunami":"major","eew":"loud"}')).toEqual({
      ...DEFAULT_PREFS,
      tsunami: "major",
    });
  });
});

describe("開いているときに鳴らすか", () => {
  test("初めて条件に合えば鳴らし、同じ中身では鳴らさず、重さが上がったら鳴らし直す", () => {
    const sent = new Map<string, Sent>();
    const p = prefs();
    expect(alertFor(quake({ maxInt: "3" }), NOW, p, sent)).toBeNull();
    expect(alertFor(quake(), NOW, p, sent)?.title).toBe(
      "最大震度4 千葉県北西部",
    );
    expect(alertFor(quake(), NOW, p, sent)).toBeNull();
    // 震源の M が変わっただけの続報は鳴らさない (控えは書き換える)
    expect(alertFor(quake({ magnitude: 5.3 }), NOW, p, sent)).toBeNull();
    expect(alertFor(quake({ maxInt: "5-" }), NOW, p, sent)?.title).toBe(
      "最大震度5弱 千葉県北西部",
    );
    // 取消は鳴らさない
    expect(alertFor(quake({ cancelled: true }), NOW, p, sent)).toBeNull();
  });

  test("訓練・古すぎるもの・条件の外は鳴らさない", () => {
    const sent = new Map<string, Sent>();
    expect(alertFor(eew(), NOW, prefs(), sent)).toBeNull(); // 予報は既定で知らせない
    expect(
      alertFor(
        eew({ kind: "warning", status: "training" }),
        NOW,
        prefs(),
        sent,
      ),
    ).toBeNull();
    expect(
      alertFor(tsunami(), NOW + 7 * 60 * 60_000, prefs(), sent),
    ).toBeNull();
    expect(
      alertFor(tsunami(), NOW, prefs({ tsunami: "off" }), sent),
    ).toBeNull();
    expect(alertFor(tsunami(), NOW, prefs(), sent)?.title).toBe("津波注意報");
  });

  test("Web Push の判定 (plan) と同じ所で鳴らす", () => {
    const events = [
      eew(),
      eew({ serial: 2, magnitude: 5.0 }),
      eew({ serial: 3, kind: "warning", warnAreas: ["茨城県南部"] }),
      eew({
        serial: 4,
        kind: "warning",
        warnAreas: ["茨城県南部", "栃木県南部"],
      }),
      eew({ serial: 5, cancelled: true }),
      quake({ maxInt: "3" }),
      quake(),
      quake({ maxInt: "6-" }),
      tsunami(),
      tsunami({
        areas: [{ name: "岩手県", grade: "warning", kindName: "津波警報" }],
      }),
      tsunami({ ended: true, areas: [] }),
    ];
    const p = prefs({ eew: "all" });
    const sent = new Map<string, Sent>();
    const log = new Map<string, Sent>();
    for (const e of events) {
      const rang = alertFor(e, NOW, p, sent) !== null;
      const n = noticeOf(e, NOW);
      let pushed = false;
      if (n) {
        const r = plan(n, p, log.get(n.tag));
        if (r.send) {
          const prev = log.get(n.tag);
          log.set(n.tag, {
            level: Math.max(prev?.level ?? 0, n.level),
            digest: digestOf(n),
          });
          pushed = r.renotify;
        }
      }
      expect(rang).toBe(pushed);
    }
  });

  test("読み上げは見出しだけで、括弧は読ませない", () => {
    expect(spokenText("緊急地震速報 (警報) 強い揺れに警戒")).toBe(
      "緊急地震速報 警報 強い揺れに警戒",
    );
  });
});

test("鳴らす音は 16 ビット・モノラルの WAV で、1 秒に収まる", () => {
  const wav = chimeWav();
  const v = new DataView(wav.buffer);
  const text = (at: number, len: number) =>
    String.fromCharCode(...wav.slice(at, at + len));
  expect(text(0, 4)).toBe("RIFF");
  expect(text(8, 4)).toBe("WAVE");
  expect(v.getUint16(22, true)).toBe(1);
  expect(v.getUint16(34, true)).toBe(16);
  const rate = v.getUint32(24, true);
  const seconds = v.getUint32(40, true) / 2 / rate;
  expect(seconds).toBeGreaterThan(0.3);
  expect(seconds).toBeLessThan(1);
  expect(v.getUint32(4, true)).toBe(wav.length - 8);
});
