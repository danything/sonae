import { describe, expect, test } from "bun:test";

import type { AreaIntensity, Quake, QuakeReport } from "#lib/model.ts";
import { LINK_WINDOW_MS, sameQuakeByTime } from "#lib/server/merge.ts";

const ORIGIN = "2026-11-13T12:00:30+09:00";
const at = (deltaMs: number) =>
  new Date(Date.parse(ORIGIN) + deltaMs).toISOString();
const area = (name: string): AreaIntensity => ({ name, int: "3" });

const quake = (areas: AreaIntensity[] = [area("石川県能登")]): Quake =>
  ({ id: "q", originTime: ORIGIN, areas }) as unknown as Quake;
const report = (
  r: Partial<QuakeReport> & Pick<QuakeReport, "areas">,
): QuakeReport => r as QuakeReport;

describe("番号が合わないときの結び付け (閾値は自前の値で、ここで固定する)", () => {
  test("時刻の差の上限は 90 秒", () => {
    expect(LINK_WINDOW_MS).toBe(90_000);
  });

  test("時刻の差が 90 秒以内なら結び、超えたら結ばない (前後どちらも)", () => {
    const q = quake();
    const areas = [area("石川県能登")];
    for (const d of [0, 89_000, 90_000, -90_000]) {
      expect(sameQuakeByTime(q, report({ originTime: at(d), areas }))).toBe(
        true,
      );
    }
    for (const d of [90_001, -90_001, 5 * 60_000]) {
      expect(sameQuakeByTime(q, report({ originTime: at(d), areas }))).toBe(
        false,
      );
    }
  });

  test("震度速報は発生の時刻が無いので TargetDateTime (分まで) で比べる", () => {
    // 12:00:30 に発生、検知の時刻は分に切り捨てて 12:00:00 (30 秒前に見える)
    const r = report({
      targetTime: "2026-11-13T12:00:00+09:00",
      areas: [area("石川県能登")],
    });
    expect(sameQuakeByTime(quake(), r)).toBe(true);
    // 発生の時刻があれば、そちらを使う
    expect(
      sameQuakeByTime(quake(), { ...r, originTime: at(10 * 60_000) }),
    ).toBe(false);
  });

  test("震度の地域が 1 つでも重なれば結び、重ならなければ結ばない", () => {
    const q = quake([area("石川県能登"), area("富山県東部")]);
    expect(
      sameQuakeByTime(
        q,
        report({
          originTime: ORIGIN,
          areas: [area("富山県東部"), area("新潟県上越")],
        }),
      ),
    ).toBe(true);
    expect(
      sameQuakeByTime(
        q,
        report({ originTime: ORIGIN, areas: [area("福島県浜通り")] }),
      ),
    ).toBe(false);
  });

  test("どちらかに地域が無ければ、時刻だけで結ぶ", () => {
    expect(
      sameQuakeByTime(
        quake([]),
        report({ originTime: ORIGIN, areas: [area("x")] }),
      ),
    ).toBe(true);
    expect(
      sameQuakeByTime(quake(), report({ originTime: ORIGIN, areas: [] })),
    ).toBe(true);
    expect(
      sameQuakeByTime(quake(), report({ originTime: at(91_000), areas: [] })),
    ).toBe(false);
  });

  test("時刻が分からなければ結ばない", () => {
    expect(sameQuakeByTime(quake(), report({ areas: [] }))).toBe(false);
    expect(
      sameQuakeByTime(
        { ...quake(), originTime: undefined },
        report({ originTime: ORIGIN, areas: [] }),
      ),
    ).toBe(false);
  });
});
