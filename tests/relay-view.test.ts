import { expect, test } from "bun:test";

import { receiveGapText } from "#lib/format.ts";
import { frameCaption } from "#lib/map/cameras.ts";
import type { SourceStatus } from "#lib/model.ts";
import {
  relayIdOf,
  relayInTrouble,
  relayNote,
  relayStateText,
} from "#lib/relay-view.ts";
import type { RelayStatus } from "#lib/relay.ts";

// 時刻は日本の時刻で出る (2026-11-28T01:05:00Z は 11/28 10:05)
const at = (hm: string) => `2026-11-28T${hm}:00.000Z`;

test("中継の源の様子の一言 (受信の状態の行)", () => {
  expect(relayStateText({ id: "jmatile", state: "idle" })).toBe(
    "まだ読んでいません",
  );
  expect(
    relayStateText({ id: "jmatile", state: "ok", lastOkAt: at("01:00") }),
  ).toBe("取得できています・11/28 10:00:00");
  expect(
    relayStateText({
      id: "jmatile",
      state: "failing",
      since: at("01:05"),
      lastOkAt: at("01:00"),
      staleAt: at("01:06"),
    }),
  ).toBe("取れません (11/28 10:05 から)・古いものを出しています");
  expect(
    relayStateText({
      id: "gsi",
      state: "blocked",
      since: at("01:05"),
      retryAt: at("01:12"),
    }),
  ).toBe("混んでいるので控えています (11/28 10:12:00 まで)");
});

test("地図の注は、取れていない源だけに、いつまでに取ったものかを書く", () => {
  const ok: RelayStatus = { id: "jmatile", state: "ok", lastOkAt: at("01:00") };
  expect(relayInTrouble(ok)).toBe(false);
  expect(relayNote(ok)).toBeUndefined();
  expect(relayNote({ id: "jmatile", state: "idle" })).toBeUndefined();
  expect(
    relayNote({
      id: "jmatile",
      state: "failing",
      since: at("01:05"),
      lastOkAt: at("01:00"),
    }),
  ).toBe(
    "気象庁から新しい雨雲などの図を取れていません (11/28 10:05 から)。出しているのは 11/28 10:00 までに取ったものです",
  );
  expect(
    relayNote({
      id: "gsi-vector",
      state: "blocked",
      since: at("01:05"),
    }),
  ).toBe(
    "混んでいるため、国土地理院から新しい地図の下地を取れていません (11/28 10:05 から)。出せるものがありません",
  );
});

test("層のタイルの URL から中継の源を引く", () => {
  expect(
    relayIdOf("https://s.example/relay/jmatile/nowc/a/{z}/{x}/{y}.png"),
  ).toBe("jmatile");
  expect(
    relayIdOf(
      "pmtiles://https://s.example/relay/gsi-vector/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles",
    ),
  ).toBe("gsi-vector");
  expect(relayIdOf("https://www.j-shis.bosai.go.jp/map/wms")).toBeUndefined();
  expect(relayIdOf("/relay/unknown/a.png")).toBeUndefined();
});

const src = (o: Partial<SourceStatus> & Pick<SourceStatus, "id">) =>
  ({
    state: "connected",
    since: at("00:00"),
    ...o,
  }) as SourceStatus;

test("一覧の先頭の、受けられていない情報源の 1 行", () => {
  const now = Date.parse(at("01:10"));
  expect(
    receiveGapText(
      [
        src({ id: "jma" }),
        src({ id: "p2p" }),
        src({ id: "cwa", state: "off" }),
      ],
      now,
    ),
  ).toBeUndefined();
  expect(
    receiveGapText(
      [
        src({ id: "jma", state: "retrying", lastSeenAt: at("01:04") }),
        src({ id: "p2p" }),
        // 地図だけの源は一覧に出さない
        src({ id: "trem", state: "retrying" }),
        // 起こしてすぐの「接続中」は数えない
        src({
          id: "wolfx",
          state: "connecting",
          since: "2026-11-28T01:09:30.000Z",
        }),
        src({ id: "usgs", state: "connecting", since: at("01:00") }),
      ],
      now,
    ),
  ).toBe(
    "気象庁 防災情報 XML (11/28 10:04 から)・USGS (米国地質調査所) (11/28 10:00 から)",
  );
});

test("火山カメラの説明: 気象庁から新しいページを取れていなければ、いまの様子ではないことがあると書く", () => {
  const frame = {
    url: "/relay/volcam/camera/315_820081B0/20261128100000.jpg",
    takenAt: at("01:00"),
  };
  const now = Date.parse(at("01:05"));
  expect(frameCaption(frame, now)).toBe("11/28 10:00 の画像");
  expect(frameCaption(frame, now, { fetchedAt: Date.parse(at("01:02")) })).toBe(
    "11/28 10:00 の画像。気象庁から新しい画像を取れていないため、いまの様子ではないことがあります (11/28 10:02 に取ったページから)",
  );
  expect(frameCaption(frame, now, {})).toBe(
    "11/28 10:00 の画像。気象庁から新しい画像を取れていないため、いまの様子ではないことがあります",
  );
});
