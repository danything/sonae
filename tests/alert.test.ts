import { describe, expect, test } from "bun:test";

import {
  alertFor,
  audioModeOf,
  autoplayAllowed,
  mutedText,
  notifyOn,
  pageNotification,
  parseAlertPrefs,
  parseAlertSettings,
  planAlert,
  withAudioMode,
} from "#lib/alert.ts";
import { chimeWav } from "#lib/chime.ts";
import { payloadOf, type Sent } from "#lib/notify.ts";
import { DEFAULT_PREFS, isShown, quiet, toNotification } from "#lib/push.ts";
import { digestOf, noticeOf, plan } from "#lib/server/notify.ts";

import { eew, NOW, prefs, quake, tsunami } from "./events.ts";

describe("開いているときの音と読み上げの設定", () => {
  test("既定は音も読み上げもオフ。読めない値もオフ", () => {
    expect(parseAlertSettings(null)).toEqual({ sound: false, speech: false });
    expect(parseAlertSettings("{")).toEqual({ sound: false, speech: false });
    expect(parseAlertSettings('{"sound":"yes","speech":false}')).toEqual({
      sound: false,
      speech: false,
    });
    // 声は端末に持たない (この家で 1 つ。サーバー)。前に覚えた voice は読まない
    expect(
      parseAlertSettings('{"sound":true,"speech":true,"voice":52}'),
    ).toEqual({ sound: true, speech: true });
  });

  test("音と読み上げは 1 つの選択。前の形の 2 つのスイッチを読み替える", () => {
    const mode = (raw: string) => audioModeOf(parseAlertSettings(raw));
    expect(mode('{"sound":true,"speech":true}')).toBe("speech");
    expect(mode('{"sound":true,"speech":false}')).toBe("chime");
    expect(mode('{"sound":false,"speech":false}')).toBe("off");
    // 前は読み上げだけ (音はオフ) にもできた。「読み上げも」(通知音も鳴らす) に読み替える
    expect(parseAlertSettings('{"sound":false,"speech":true}')).toEqual({
      sound: true,
      speech: true,
    });
    // 選んだら音と読み上げをそろえる (OS の通知のスイッチはそのまま)
    const s = { sound: false, speech: false, notify: false };
    expect(withAudioMode(s, "speech")).toEqual({
      sound: true,
      speech: true,
      notify: false,
    });
    expect(withAudioMode(s, "chime")).toEqual({
      sound: true,
      speech: false,
      notify: false,
    });
    expect(withAudioMode({ sound: true, speech: true }, "off")).toEqual({
      sound: false,
      speech: false,
    });
  });

  test("条件は Web Push と同じ既定。読めない項目は既定に戻す", () => {
    expect(parseAlertPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parseAlertPrefs("not json")).toEqual(DEFAULT_PREFS);
    expect(parseAlertPrefs('{"tsunami":"nearby","eew":"loud"}')).toEqual({
      ...DEFAULT_PREFS,
      tsunami: "nearby",
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
    expect(alertFor(eew(), NOW, prefs({ eew: "off" }), sent)).toBeNull();
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
    const p = prefs();
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

  test("鳴らさない続報も、通知を置き換えるために返す", () => {
    const sent = new Map<string, Sent>();
    const p = prefs();
    expect(planAlert(quake(), NOW, p, sent)?.renotify).toBe(true);
    expect(planAlert(quake(), NOW, p, sent)).toBeNull(); // 同じ中身
    const next = planAlert(quake({ magnitude: 5.3 }), NOW, p, sent);
    expect(next?.renotify).toBe(false);
    expect(next?.notice.tag).toBe("quake:20261114090000");
  });

  test("控えは、最後に書いたものがいちばん新しい所に並ぶ (古いものから捨てるため)", () => {
    const sent = new Map<string, Sent>();
    const p = prefs();
    planAlert(quake(), NOW, p, sent);
    planAlert(quake({ id: "20261114091000" }), NOW, p, sent);
    // 前の地震の続報で書き直したら、そちらが後ろへ
    planAlert(quake({ magnitude: 5.3 }), NOW, p, sent);
    expect([...sent.keys()]).toEqual([
      "quake:20261114091000",
      "quake:20261114090000",
    ]);
  });
});

describe("開いているときの OS の通知", () => {
  test("許可があり、スイッチを切っていなければ出す (既定はオン)", () => {
    const off = { sound: false, speech: false };
    expect(notifyOn(off, "granted")).toBe(true);
    expect(notifyOn({ ...off, notify: true }, "granted")).toBe(true);
    expect(notifyOn({ ...off, notify: false }, "granted")).toBe(false);
    // 許可が無ければ、オンでも出さない (許可は「通知」の窓の操作でだけ聞く)
    expect(notifyOn({ ...off, notify: true }, "default")).toBe(false);
    expect(notifyOn(off, "denied")).toBe(false);
    expect(notifyOn(off, "unsupported")).toBe(false);
  });

  test("スイッチの値を覚える。読めない値は既定のまま", () => {
    expect(parseAlertSettings('{"notify":false}')).toEqual({
      sound: false,
      speech: false,
      notify: false,
    });
    expect(parseAlertSettings('{"notify":"no"}')).toEqual({
      sound: false,
      speech: false,
    });
  });

  test("中身・tag・押したときの URL・残すかは Web Push と同じ", () => {
    const n = alertFor(
      tsunami({
        areas: [{ name: "岩手県", grade: "warning", kindName: "津波警報" }],
      }),
      NOW,
      prefs(),
      new Map(),
    );
    if (!n) throw new Error("鳴らすはず");
    const page = pageNotification(n, true, false);
    const push = toNotification(
      JSON.parse(JSON.stringify(payloadOf(n, true))) as unknown,
    );
    expect(page).toEqual(push);
    expect(page.options.requireInteraction).toBe(true);
    // チャイムを鳴らしたときだけ、OS の通知音を止める
    expect(pageNotification(n, true, true).options.silent).toBe(true);
    // 画面が先に出したら、後から届いた Web Push は鳴らさずに置き換える
    const one = {
      tag: page.options.tag,
      title: page.title,
      body: page.options.body,
    };
    expect(isShown(push, [one])).toBe(true);
    expect(quiet(push).options).toMatchObject({
      renotify: false,
      silent: true,
      tag: page.options.tag,
    });
    // 中身が変わった (重さが上がった) 続報は鳴らす
    expect(isShown(push, [{ ...one, body: "前の本文" }])).toBe(false);
    expect(isShown(push, [])).toBe(false);
  });
});

describe("音が止まっている間の帯", () => {
  test("何が止まっていて、通知は出るかを言う", () => {
    expect(mutedText({ sound: true, speech: true }, false)).toEqual({
      head: "音と読み上げが止まっています",
      body: "押すと、警報を音と読み上げで知らせます",
    });
    expect(mutedText({ sound: false, speech: true }, true)).toEqual({
      head: "読み上げが止まっています",
      body: "通知は出ます。読み上げも聞くなら押してください",
    });
    expect(mutedText({ sound: true, speech: false }, true).body).toBe(
      "通知は出ます。音も聞くなら押してください",
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

describe("操作の前でも音を出せるか", () => {
  const ctx = (state: string) =>
    class {
      state = state;
      close() {
        return Promise.resolve();
      }
    };

  test("getAutoplayPolicy があればそれで決める (AudioContext は作らない)", () => {
    let made = false;
    const Ctx = class {
      state = "running";
      constructor() {
        made = true;
      }
      close() {
        return Promise.resolve();
      }
    };
    expect(autoplayAllowed({ getAutoplayPolicy: () => "allowed" }, Ctx)).toBe(
      true,
    );
    expect(
      autoplayAllowed({ getAutoplayPolicy: () => "allowed-muted" }, Ctx),
    ).toBe(false);
    expect(
      autoplayAllowed({ getAutoplayPolicy: () => "disallowed" }, Ctx),
    ).toBe(false);
    expect(made).toBe(false);
  });

  test("無ければ、作った AudioContext が動いているかで見る", () => {
    expect(autoplayAllowed({}, ctx("running"))).toBe(true);
    expect(autoplayAllowed({}, ctx("suspended"))).toBe(false);
  });

  test("分からないときは出せないとみなす", () => {
    expect(autoplayAllowed(undefined, undefined)).toBe(false);
    const Throws = class {
      state = "running";
      constructor() {
        throw new Error("no");
      }
      close() {
        return Promise.resolve();
      }
    };
    expect(autoplayAllowed({}, Throws)).toBe(false);
    expect(
      autoplayAllowed(
        {
          getAutoplayPolicy: () => {
            throw new Error("no");
          },
        },
        ctx("running"),
      ),
    ).toBe(false);
  });
});
