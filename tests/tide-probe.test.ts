import { expect, test } from "bun:test";

import type {
  Quake,
  Tsunami,
  TsunamiGrade,
  WarningLevel,
  WeatherWarning,
} from "#lib/model.ts";
import { openDb } from "#lib/server/db.ts";
import {
  KEEP_ROWS,
  parseTideTime,
  type ProbeState,
  QUAKE_WINDOW_MS,
  TIDE_TIME_URL,
  TideProbe,
  tideTriggers,
  tsunamiComment,
} from "#lib/server/tide-probe.ts";

import { memoryStore } from "./helpers.ts";

const NOW = Date.parse("2026-11-16T10:30:00Z");

const tsunami = (grade: TsunamiGrade, o: Partial<Tsunami> = {}): Tsunami => ({
  id: "t1",
  eventIds: ["20261116190000"],
  status: "normal",
  issuedAt: "2026-11-16T10:00:00Z",
  areas: [{ name: "岩手県", grade, kindName: "" }],
  observations: [],
  cancelled: false,
  ended: false,
  provisional: false,
  sources: ["jma"],
  updatedAt: "2026-11-16T10:00:00Z",
  ...o,
});

const quake = (o: Partial<Quake> = {}): Quake => ({
  id: "q1",
  status: "normal",
  originTime: "2026-11-16T10:00:00Z",
  areas: [],
  stations: [],
  comments: [],
  foreign: false,
  cancelled: false,
  provisional: false,
  sources: ["jma"],
  reports: [],
  updatedAt: "2026-11-16T10:00:00Z",
  ...o,
});

const warning = (
  code: WeatherWarning["code"],
  level: WarningLevel,
  o: Partial<WeatherWarning> = {},
): WeatherWarning => ({
  id: `${code}-020000`,
  code,
  office: { code: "020000", name: "岩手県" },
  status: "normal",
  infoType: "発表",
  reportedAt: "2026-11-16T10:00:00Z",
  title: "",
  headline: "",
  areas: [
    {
      code: "0320200",
      name: "宮古市",
      kinds: [{ code: "07", name: "波浪警報", level, status: "発表" }],
    },
  ],
  released: [],
  updatedAt: "2026-11-16T10:00:00Z",
  ...o,
});

const state = (o: Partial<ProbeState> = {}): ProbeState => ({
  tsunamis: [],
  quakes: [],
  warnings: [],
  ...o,
});

test("津波: 大津波警報・津波警報・津波注意報で動き、津波予報だけ・終わった・取り消された・訓練では動かない", () => {
  for (const g of ["major", "warning", "watch"] as const)
    expect(tideTriggers(state({ tsunamis: [tsunami(g)] }), NOW)).toEqual([
      "tsunami",
    ]);
  for (const t of [
    tsunami("forecast"),
    tsunami("warning", { ended: true }),
    tsunami("warning", { cancelled: true }),
    tsunami("warning", { status: "training" }),
  ])
    expect(tideTriggers(state({ tsunamis: [t] }), NOW)).toEqual([]);
});

test("地震: 震度 5 弱以上 (未入電も) か、津波に触れたコメントで、発生から 2 時間だけ動く", () => {
  const on = (q: Quake, now = NOW) =>
    tideTriggers(state({ quakes: [q] }), now).includes("quake");
  expect(on(quake({ maxInt: "5-" }))).toBe(true);
  expect(on(quake({ maxInt: "7" }))).toBe(true);
  expect(on(quake({ maxInt: "5-?" }))).toBe(true);
  expect(on(quake({ maxInt: "4" }))).toBe(false);
  expect(
    on(quake({ maxInt: "3", comments: ["津波注意報を発表しています。"] })),
  ).toBe(true);
  expect(
    on(
      quake({
        maxInt: "3",
        comments: ["この地震による津波の心配はありません。"],
      }),
    ),
  ).toBe(false);
  const origin = Date.parse("2026-11-16T10:00:00Z");
  expect(on(quake({ maxInt: "6-" }), origin + QUAKE_WINDOW_MS - 1)).toBe(true);
  expect(on(quake({ maxInt: "6-" }), origin + QUAKE_WINDOW_MS)).toBe(false);
  // 発生の時刻が無い (震度速報だけ) なら更新の時刻から数える
  expect(
    on(
      quake({
        maxInt: "5+",
        originTime: undefined,
        updatedAt: "2026-11-16T09:00:00Z",
      }),
    ),
  ).toBe(true);
  expect(on(quake({ maxInt: "6+", cancelled: true }))).toBe(false);
  expect(on(quake({ maxInt: "6+", status: "test" }))).toBe(false);
});

test("津波に触れたコメント: 心配・影響が無いものは外し、海面変動は入れる", () => {
  expect(tsunamiComment("この地震による津波の心配はありません。")).toBe(false);
  expect(tsunamiComment("この地震による日本への津波の影響はありません。")).toBe(
    false,
  );
  expect(
    tsunamiComment("若干の海面変動が予想されますが、被害の心配はありません。"),
  ).toBe(true);
  expect(tsunamiComment("津波の有無を調査中です。")).toBe(true);
  expect(tsunamiComment("震源の近傍で津波発生の可能性があります。")).toBe(true);
  expect(tsunamiComment("今後の情報に注意してください。")).toBe(false);
});

test("波浪: 波浪警報 (段 3 以上) で動き、注意報・ほかの現象の警報・訓練では動かない", () => {
  const on = (w: WeatherWarning) =>
    tideTriggers(state({ warnings: [w] }), NOW).includes("wave");
  expect(on(warning("VPWW59", 3))).toBe(true);
  expect(on(warning("VPWW59", 5))).toBe(true);
  expect(on(warning("VPWW59", 2))).toBe(false);
  expect(on(warning("VPWW58", 3))).toBe(false);
  expect(on(warning("VPWW59", 3, { status: "training" }))).toBe(false);
  expect(on(warning("VPWW59", 3, { areas: [] }))).toBe(false);
});

test("理由は重なれば全部並べる", () => {
  expect(
    tideTriggers(
      state({
        tsunamis: [tsunami("watch")],
        quakes: [quake({ maxInt: "5-" })],
        warnings: [warning("VPWW59", 3)],
      }),
      NOW,
    ),
  ).toEqual(["tsunami", "quake", "wave"]);
});

test("tide_time.json: 時差の付いた time を読み、ほかは例外", () => {
  expect(parseTideTime('{"time":"2026-11-16T19:14:45+09:00"}')).toBe(
    Date.parse("2026-11-16T10:14:45Z"),
  );
  for (const bad of [
    "<html>",
    "{}",
    '{"time":123}',
    '{"time":"2026-11-16T19:14:45"}',
    '{"time":"x"}',
    "null",
  ])
    expect(() => parseTideTime(bad)).toThrow();
});

/** 応答を順に返す fetch。受けた頭を控える */
function fakeFetch(responses: (() => Response)[]) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: init?.headers as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error("応答がありません");
    return next();
  }) as unknown as typeof fetch;
  return { f, seen };
}

const tide =
  (time: string, modified: string, etag = '"a"') =>
  () =>
    new Response(JSON.stringify({ time }), {
      headers: { "last-modified": modified, etag },
    });

test("動かす理由が無ければ取らない。あれば tide_time.json だけを取り、更新ごとに 1 行を足す", async () => {
  const db = openDb(":memory:");
  let now = Date.parse("2026-11-16T10:28:00Z");
  let s = state();
  const logs: string[] = [];
  const { f, seen } = fakeFetch([
    tide("2026-11-16T19:14:45+09:00", "Mon, 16 Nov 2026 10:27:20 GMT"),
    () => new Response(null, { status: 304 }),
    tide("2026-11-16T19:14:45+09:00", "Mon, 16 Nov 2026 10:27:20 GMT", '"b"'),
    tide("2026-11-16T19:24:45+09:00", "Mon, 16 Nov 2026 10:37:20 GMT", '"c"'),
  ]);
  const probe = new TideProbe(db, {
    state: () => s,
    fetch: f,
    log: (m) => logs.push(m),
    now: () => now,
  });
  const signal = new AbortController().signal;

  expect(await probe.step(signal)).toBeUndefined();
  expect(seen).toHaveLength(0);

  s = state({ tsunamis: [tsunami("warning")] });
  const first = await probe.step(signal);
  expect(seen[0]?.url).toBe(TIDE_TIME_URL);
  expect(seen[0]?.headers["user-agent"]).toContain("sonae");
  expect(first).toEqual({
    fetchedAt: "2026-11-16T10:28:00.000Z",
    dataTime: "2026-11-16T10:14:45.000Z",
    lastModified: "2026-11-16T10:27:20.000Z",
    fetchDelaySec: 795,
    modifiedDelaySec: 755,
    triggers: ["tsunami"],
    afterGap: true,
  });

  // 304 と、中の時刻が同じ 200 は足さない。次の回は控えたヘッダーを付ける
  now += 60_000;
  expect(await probe.step(signal)).toBeUndefined();
  expect(seen[1]?.headers["if-none-match"]).toBe('"a"');
  expect(seen[1]?.headers["if-modified-since"]).toBe(
    "Mon, 16 Nov 2026 10:27:20 GMT",
  );
  now += 60_000;
  expect(await probe.step(signal)).toBeUndefined();

  now = Date.parse("2026-11-16T10:38:00Z");
  s = state({
    tsunamis: [tsunami("warning")],
    warnings: [warning("VPWW59", 3)],
  });
  const second = await probe.step(signal);
  expect(second?.fetchDelaySec).toBe(795);
  expect(second?.afterGap).toBe(true);
  expect(second?.triggers).toEqual(["tsunami", "wave"]);

  const rows = db
    .query<{ data_time: string; triggers: string }, []>(
      "SELECT data_time, triggers FROM tide_latency ORDER BY id",
    )
    .all();
  expect(rows).toEqual([
    { data_time: "2026-11-16T10:14:45.000Z", triggers: "tsunami" },
    { data_time: "2026-11-16T10:24:45.000Z", triggers: "tsunami,wave" },
  ]);
  expect(logs.filter((l) => l.startsWith("tide-latency "))).toEqual([
    "tide-latency data=2026-11-16T10:14:45.000Z fetched=2026-11-16T10:28:00.000Z lastModified=2026-11-16T10:27:20.000Z fetchDelay=795s modifiedDelay=755s triggers=tsunami afterGap=1",
    "tide-latency data=2026-11-16T10:24:45.000Z fetched=2026-11-16T10:38:00.000Z lastModified=2026-11-16T10:37:20.000Z fetchDelay=795s modifiedDelay=755s triggers=tsunami,wave afterGap=1",
  ]);

  // 再起動の後は、DB の最後の行と同じ更新を足さない
  const again = new TideProbe(db, {
    state: () => s,
    fetch: fakeFetch([
      tide("2026-11-16T19:24:45+09:00", "Mon, 16 Nov 2026 10:37:20 GMT"),
    ]).f,
    log: () => {},
    now: () => now,
  });
  expect(await again.step(signal)).toBeUndefined();
});

test("1 分ごとに続けて取れた回は afterGap にならない", async () => {
  const db = openDb(":memory:");
  let now = Date.parse("2026-11-16T10:36:20Z");
  const probe = new TideProbe(db, {
    state: () => state({ tsunamis: [tsunami("watch")] }),
    fetch: fakeFetch([
      tide("2026-11-16T19:14:45+09:00", "Mon, 16 Nov 2026 10:27:20 GMT"),
      tide("2026-11-16T19:24:45+09:00", "Mon, 16 Nov 2026 10:37:20 GMT"),
    ]).f,
    log: () => {},
    now: () => now,
  });
  const signal = new AbortController().signal;
  expect((await probe.step(signal))?.afterGap).toBe(true);
  now += 60_000;
  const r = await probe.step(signal);
  expect(r?.afterGap).toBe(false);
  expect(r?.fetchDelaySec).toBe(755);
});

test("失敗しても取得は止まらず、ログに出力して間隔を空ける", async () => {
  const db = openDb(":memory:");
  const ctrl = new AbortController();
  const waits: number[] = [];
  const logs: string[] = [];
  const probe = new TideProbe(db, {
    state: () => state({ tsunamis: [tsunami("major")] }),
    fetch: fakeFetch([
      () => new Response("x", { status: 500 }),
      () => new Response("<html>", { status: 200 }),
      tide("2026-11-16T19:14:45+09:00", "Mon, 16 Nov 2026 10:27:20 GMT"),
    ]).f,
    log: (m) => logs.push(m),
    now: () => NOW,
    sleep: async (ms) => {
      waits.push(ms);
      if (waits.length === 3) ctrl.abort();
    },
  });
  await probe.run(ctrl.signal);
  expect(waits).toEqual([60_000, 120_000, 60_000]);
  expect(
    logs.filter((l) => l.startsWith("[tide-probe] 測れませんでした")),
  ).toHaveLength(2);
  expect(logs.some((l) => l.startsWith("tide-latency "))).toBe(true);
});

test(`残すのは ${KEEP_ROWS} 行と 90 日まで`, async () => {
  const db = openDb(":memory:");
  const insert = db.query(
    `INSERT INTO tide_latency (fetched_at, data_time, last_modified, fetch_delay_s,
       modified_delay_s, triggers, after_gap) VALUES (?, 'x', NULL, 0, NULL, 'wave', 1)`,
  );
  insert.run("2026-08-01T00:00:00.000Z");
  for (let i = 0; i < KEEP_ROWS; i++) insert.run("2026-11-16T00:00:00.000Z");
  const probe = new TideProbe(db, {
    state: () => state({ warnings: [warning("VPWW59", 3)] }),
    fetch: fakeFetch([
      tide("2026-11-16T19:14:45+09:00", "Mon, 16 Nov 2026 10:27:20 GMT"),
    ]).f,
    log: () => {},
    now: () => NOW,
  });
  await probe.step(new AbortController().signal);
  const count = db
    .query<{ n: number; old: number }, []>(
      `SELECT COUNT(*) AS n, SUM(fetched_at < '2026-08-18') AS old FROM tide_latency`,
    )
    .get();
  expect(count).toEqual({ n: KEEP_ROWS, old: 0 });
});

test("quakesSince: 時刻で切り、数では切らない。発生の時刻が無ければ更新の時刻で見る", () => {
  const { store } = memoryStore();
  const insert = store.db.query(
    `INSERT INTO quakes (id, event_id, status, origin_time, updated_at, data)
     VALUES (?, NULL, ?, ?, ?, ?)`,
  );
  const add = (id: string, status: string, origin: string | null) =>
    insert.run(
      id,
      status,
      origin,
      "2026-11-16T09:00:00Z",
      JSON.stringify(quake({ id })),
    );
  add("main", "normal", "2026-11-16T08:40:00Z");
  for (let i = 0; i < 60; i++)
    add(
      `after${i}`,
      "normal",
      `2026-11-16T09:${String(i).padStart(2, "0")}:00Z`,
    );
  add("old", "normal", "2026-11-16T08:00:00Z");
  add("training", "training", "2026-11-16T09:00:00Z");
  add("noOrigin", "normal", null);
  const ids = store.quakesSince("2026-11-16T08:30:00.000Z").map((q) => q.id);
  expect(ids).toHaveLength(62);
  expect(ids).toContain("main");
  expect(ids).toContain("noOrigin");
  expect(ids).not.toContain("old");
  expect(ids).not.toContain("training");
});
