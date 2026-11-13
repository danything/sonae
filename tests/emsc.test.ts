import { expect, test } from "bun:test";

import type { ForeignQuake } from "#lib/model.ts";
import { EMSC_WS, emscSource, parseEmsc } from "#lib/server/sources/emsc.ts";
import { Backoff, type SocketLike } from "#lib/server/sources/retry.ts";
import type { Incoming, SourceContext } from "#lib/server/sources/types.ts";
import { parseUsgs } from "#lib/server/sources/usgs.ts";

import { fixture, memoryStore } from "./helpers.ts";

const lines = fixture("emsc/made-messages.jsonl").trim().split("\n");
const BIG = lines[0] ?? ""; // M4.8 パプアニューギニア (USGS の fixture と同じ地震)
const SMALL = lines[1] ?? ""; // M2.1 (下限より小さい)
const BLAST = lines[2] ?? ""; // 爆破

test("M4.5 以上の地震だけを、海外の地震の発表に読む", () => {
  const m = parseEmsc(BIG);
  expect(m?.key).toBe("20261113_0000198@2026-11-13T19:53:40.000Z");
  const item = m?.items[0];
  if (item?.type !== "foreign") throw new Error("海外の地震ではない");
  expect(item.report).toEqual({
    source: "emsc",
    sourceId: "20261113_0000198",
    url: "https://www.seismicportal.eu/eventdetails.html?unid=20261113_0000198",
    originTime: "2026-11-13T19:49:22.400Z",
    lat: -1.52,
    lon: 149.98,
    depthKm: 12,
    magnitude: 4.9,
    magType: "mb",
    place: "NEW IRELAND REGION, P.N.G.",
    updatedAt: "2026-11-13T19:53:40.000Z",
  });
  expect(parseEmsc(SMALL)).toBeNull();
  expect(parseEmsc(BLAST)).toBeNull();
  expect(parseEmsc('{"action":"delete"}')).toBeNull();
  expect(() => parseEmsc("not json")).toThrow();
});

test("更新の時刻が無い続報でも、M が直れば別の鍵になる", () => {
  const v = JSON.parse(BIG);
  delete v.data.properties.lastupdate;
  const a = parseEmsc(JSON.stringify(v));
  v.action = "update";
  v.data.properties.mag = 5.2;
  const b = parseEmsc(JSON.stringify(v));
  expect(a?.key).not.toBe(b?.key);
});

test("USGS と同じ地震は 1 つにまとめる (重ねて出さない)", () => {
  const { store } = memoryStore();
  for (const m of parseUsgs(fixture("usgs/4.5_day.geojson"))) store.ingest(m);
  const m = parseEmsc(BIG);
  if (!m) throw new Error("読めない");
  const [e] = store.ingest(m);
  const q = e?.data as ForeignQuake | undefined;
  expect(q?.id).toBe("usgs-us7000ty43");
  expect(q?.reports.map((r) => r.source)).toEqual(["usgs", "emsc"]);
  expect(store.foreignQuakes()).toHaveLength(3);
});

class FakeSocket implements SocketLike {
  private on: Record<string, ((e: never) => void)[]> = {};
  addEventListener(type: string, fn: (e: never) => void) {
    (this.on[type] ??= []).push(fn);
  }
  fire(type: string, e?: unknown) {
    for (const fn of this.on[type] ?? []) fn(e as never);
  }
  send() {}
  close() {
    this.fire("close");
  }
}

test("つないで受け、読めない 1 通は捨て、切れたら間を置いて張り直す", async () => {
  const got: Incoming[] = [];
  const keys = new Set<string>();
  const ctx: SourceContext = {
    emit: (m) => {
      got.push(m);
      keys.add(m.key);
    },
    seen: (_s, k) => keys.has(k),
  };
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const waits: number[] = [];
  const controller = new AbortController();
  const source = emscSource(ctx, {
    connect: (url) => {
      urls.push(url);
      const ws = new FakeSocket();
      sockets.push(ws);
      queueMicrotask(() => {
        ws.fire("open");
        for (const text of [BIG, "壊れた", SMALL, BIG])
          ws.fire("message", { data: text });
        ws.close();
      });
      return ws;
    },
    backoff: new Backoff(5_000, 120_000, () => 1),
    log: () => {},
    sleep: async (ms) => {
      waits.push(ms);
      if (waits.length >= 2) controller.abort();
    },
  });
  await source.run(controller.signal);
  expect(urls).toEqual([EMSC_WS, EMSC_WS]);
  // 同じ地震の同じ更新は 1 回だけ。小さい地震と壊れた 1 通は渡さない
  expect(got).toHaveLength(1);
  expect(waits).toEqual([5_000, 10_000]);
});
