import { describe, expect, test } from "bun:test";

import { parseAlertSettings } from "#lib/alert.ts";
import { Backoff } from "#lib/backoff.ts";
import {
  CONNECTION_TAG,
  connectionNotification,
  isStale,
  OUTAGE_COOLDOWN_MS,
  OUTAGE_NOTIFY_MS,
  OutageWatch,
  STALE_MS,
} from "#lib/connection.ts";
import { CONNECTION, FIXED_TEXTS, isFixed } from "#lib/readout.ts";
import { PING_MS } from "#lib/server/sse.ts";

const S = 1000;

describe("画面への配信の張り直し", () => {
  test("何も届かない長さは、サーバーが状況を送る間隔の 2 回分より長い", () => {
    expect(STALE_MS).toBeGreaterThan(2 * PING_MS);
    expect(isStale(0, STALE_MS)).toBe(false);
    expect(isStale(0, STALE_MS + 1)).toBe(true);
  });

  test("間隔は倍々に増えて上限で止まり、戻すと最初から", () => {
    const b = new Backoff(1_000, 30_000, () => 1);
    expect([
      b.next(),
      b.next(),
      b.next(),
      b.next(),
      b.next(),
      b.next(),
    ]).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(b.next()).toBe(30_000);
    b.reset();
    expect(b.next()).toBe(1_000);
    // 揺らぎ (full jitter) は上限の中
    const r = new Backoff(1_000, 30_000, () => 0.25);
    expect(r.next()).toBe(250);
  });
});

describe("受信が切れたことを知らせるか", () => {
  test("短い切れ目では知らせず、30 秒続いたら 1 度だけ、戻ったら 1 度だけ", () => {
    const w = new OutageWatch(0);
    expect(w.update(true, 1 * S)).toBeNull(); // 最初につながった
    expect(w.update(false, 10 * S)).toBeNull();
    expect(w.update(true, 15 * S)).toBeNull(); // 5 秒で戻った (知らせていないので、戻ったとも言わない)
    expect(w.update(false, 20 * S)).toBeNull();
    expect(w.update(false, 20 * S + OUTAGE_NOTIFY_MS - 1)).toBeNull();
    expect(w.update(false, 20 * S + OUTAGE_NOTIFY_MS)).toBe("down");
    expect(w.update(false, 120 * S)).toBeNull(); // 切れたままでも繰り返さない
    expect(w.update(true, 130 * S)).toBe("back");
    expect(w.update(true, 135 * S)).toBeNull();
  });

  test("開いてから一度もつながらなくても知らせる", () => {
    const w = new OutageWatch(0);
    expect(w.update(false, 5 * S)).toBeNull();
    expect(w.update(false, OUTAGE_NOTIFY_MS)).toBe("down");
  });

  test("切れたり戻ったりしても、前の「切れました」から間を空ける", () => {
    const w = new OutageWatch(0);
    expect(w.update(false, OUTAGE_NOTIFY_MS)).toBe("down");
    const t = OUTAGE_NOTIFY_MS;
    expect(w.update(true, t + 10 * S)).toBe("back");
    // すぐまた長く切れても、間を空けるまでは言わない (戻ったとも言わない)
    expect(w.update(false, t + 20 * S)).toBeNull();
    expect(w.update(false, t + 20 * S + OUTAGE_NOTIFY_MS)).toBeNull();
    expect(w.update(true, t + 100 * S)).toBeNull();
    // 間を空けた後なら、また言う。切れたままで間が明けたときも言う
    expect(w.update(false, t + 200 * S)).toBeNull();
    expect(w.update(false, t + OUTAGE_COOLDOWN_MS - 1)).toBeNull();
    expect(w.update(false, t + OUTAGE_COOLDOWN_MS)).toBe("down");
  });

  test("通知は 1 つの tag で置き換え、戻ったときは鳴らさない", () => {
    const down = connectionNotification("down", false);
    expect(down.title).toBe("受信が切れました");
    expect(down.options).toMatchObject({
      tag: CONNECTION_TAG,
      body: CONNECTION.down,
      renotify: true,
      silent: false,
      data: { url: "/" },
    });
    // チャイムが鳴ったときは音なし。silent と renotify は一緒に付けない
    expect(connectionNotification("down", true).options).toMatchObject({
      renotify: false,
      silent: true,
    });
    expect(connectionNotification("back", false).options).toMatchObject({
      tag: CONNECTION_TAG,
      body: CONNECTION.back,
      renotify: false,
      silent: true,
    });
  });

  test("読む文は合成しておく決まった文", () => {
    for (const t of Object.values(CONNECTION)) {
      expect(FIXED_TEXTS).toContain(t);
      expect(isFixed(t)).toBe(true);
    }
  });

  test("スイッチの値を覚える (既定は知らせる)", () => {
    expect(parseAlertSettings("{}").outage).toBeUndefined();
    expect(parseAlertSettings('{"outage":false}').outage).toBe(false);
    expect(parseAlertSettings('{"outage":"no"}').outage).toBeUndefined();
  });
});
