import { expect, test } from "bun:test";

import { RTS_STALE_MS } from "#lib/rts.ts";
import { RtsBoard } from "#lib/server/rts-board.ts";
import {
  parseSeis,
  parseSeisList,
  seisSource,
} from "#lib/server/sources/seisjs.ts";

import { FakeSocket } from "./helpers.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// 2026-11-17 に受けた一覧と観測の形式 (値は短くした)
const LIST = {
  "a615e761-d26c-482c-9bba-c83e2c4f07cd": {
    enable: true,
    name: "a615e761-d26c-482c-9bba-c83e2c4f07cd",
    location: "臺灣臺南市",
    latitude: 23.0,
    longitude: 120.3,
    high_precision: true,
  },
  "6d39bc1c-b539-4d0b-9d92-ec0acb6a45ea": {
    enable: false,
    latitude: 25.0,
    longitude: 103.0,
  },
  broken: { enable: true, latitude: "x", longitude: 1 },
};

const reading = (over: Record<string, unknown> = {}) => ({
  type: "a615e761-d26c-482c-9bba-c83e2c4f07cd",
  PGA: 0.025,
  CalcShindo: -1.2,
  Shindo: "0",
  latitude: 23.0,
  longitude: 120.3,
  private: false,
  region: "臺灣臺南市",
  ...over,
});

test("観測点の一覧: 使えるものだけ、[経度, 緯度] で", () => {
  const m = parseSeisList(LIST);
  expect([...m]).toEqual([
    ["a615e761-d26c-482c-9bba-c83e2c4f07cd", [120.3, 23.0]],
  ]);
});

test("観測: CalcShindo を読む。heartbeat と位置を隠した観測点の位置は読まない", () => {
  expect(parseSeis(reading())).toEqual({
    id: "a615e761-d26c-482c-9bba-c83e2c4f07cd",
    i: -1.2,
    private: false,
    at: [120.3, 23.0],
  });
  expect(
    parseSeis({ type: "heartbeat", ver: 12, timestamp: 1 }),
  ).toBeUndefined();
  expect(parseSeis(reading({ CalcShindo: "x" }))).toBeUndefined();
  expect(parseSeis(reading({ private: true }))?.at).toBeUndefined();
});

test("配り方: 見た目 (震度の階級) が同じなら、決めた間はまとめて配らない", () => {
  let now = 1_000_000;
  const board = new RtsBoard(() => now, {
    events: { stations: "seis-stations", frame: "seis" },
    minRepeatMs: 5_000,
  });
  const got: string[] = [];
  board.subscribe((event) => got.push(event));
  board.setStations(new Map([["a", [120.3, 23.0]]]));
  board.put(new Map([["a", -1]]));
  now += 1_000;
  board.put(new Map([["a", 0.2]])); // まだ灰色のまま
  now += 1_000;
  board.put(new Map([["a", 1.6]])); // 震度 2 の色になった
  now += 1_000;
  board.put(new Map([["a", 1.7]]));
  now += 5_000;
  board.put(new Map([["a", 1.8]])); // 間が空いたので配り直す
  expect(got).toEqual(["seis-stations", "seis", "seis", "seis"]);
  // 配らなかった値も、いまの値としては持っている
  expect(board.current()?.points).toEqual([[120.3, 23.0, 1.8]]);
  now += RTS_STALE_MS;
  expect(board.current()).toBeUndefined();
});

test("情報源: 一覧を取り、受けた値を 1 秒ごとにまとめて入れる。位置を隠した観測点は一覧を取り直しても外す", async () => {
  const board = new RtsBoard();
  const frames: unknown[] = [];
  board.subscribe((event, data) => {
    if (event === "rts") frames.push(data);
  });
  const sockets: FakeSocket[] = [];
  const ac = new AbortController();
  const fakeFetch = (async () =>
    new Response(JSON.stringify(LIST), {
      headers: { etag: 'W/"1"' },
    })) as unknown as typeof fetch;
  const src = seisSource(board, {
    fetch: fakeFetch,
    flushMs: 10,
    listEveryMs: 20,
    log: () => {},
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      queueMicrotask(() => s.fire("open"));
      return s;
    },
  });
  const done = src.run(ac.signal);
  await tick(5);
  expect(board.stations().stations).toEqual([[120.3, 23.0]]);
  expect(src.status().state).toBe("connected");

  const ws = sockets[0];
  ws?.fire("message", { data: JSON.stringify({ type: "heartbeat" }) });
  ws?.fire("message", { data: JSON.stringify(reading({ CalcShindo: 2.04 })) });
  // 一覧に無くても、位置が付いていれば足す
  ws?.fire("message", {
    data: JSON.stringify(
      reading({ type: "new", latitude: 35, longitude: 139, CalcShindo: 0.1 }),
    ),
  });
  await tick(30);
  expect(board.current()?.points).toEqual([
    [120.3, 23.0, 2],
    [139, 35, 0.1],
  ]);
  expect(board.stations().stations).toHaveLength(2);

  ws?.fire("message", { data: JSON.stringify(reading({ private: true })) });
  await tick(30);
  expect(board.stations().stations).toEqual([[139, 35]]);
  expect(board.current()?.points).toEqual([[139, 35, 0.1]]);
  // 一覧を取り直しても (listEveryMs) 隠したまま
  await tick(60);
  expect(board.stations().stations).toEqual([[139, 35]]);

  ac.abort();
  await done;
  expect(src.status().state).toBe("stopped");
});
