import { expect, test } from "bun:test";

import type { SonaeEvent } from "#lib/model.ts";
import { Broker } from "#lib/server/broker.ts";
import { sseFrame, sseStream } from "#lib/server/sse.ts";

const ev = (seq: number): SonaeEvent =>
  ({ seq, type: "advisory", data: { id: `a${seq}` } }) as unknown as SonaeEvent;

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
) {
  const dec = new TextDecoder();
  let text = "";
  while (!text.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value);
  }
  return text;
}

test("埋め直し → 生の配信。番号で重複を除き、ping と状況を送る", async () => {
  const broker = new Broker();
  const ac = new AbortController();
  const res = sseStream({
    backlog: () => [ev(2), ev(3)],
    latestSeq: () => 3,
    subscribe: (fn) => broker.subscribe(fn),
    status: () => sseFrame({ event: "status", data: [] }),
    signal: ac.signal,
    pingMs: 20,
  });
  expect(res.headers.get("content-type")).toStartWith("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
  expect(res.headers.get("x-accel-buffering")).toBe("no");

  const reader = res.body?.getReader();
  if (!reader) throw new Error("本文が無い");
  const first = await readUntil(reader, "event: status");
  expect(first).toContain("retry: 5000");
  expect(first).toContain('id: 2\nevent: advisory\ndata: {"id":"a2"}\n\n');
  expect(first).toContain("id: 3\n");

  broker.publish(ev(3)); // 埋め直しで送ったもの
  broker.publish(ev(4));
  const later = await readUntil(reader, ": ping");
  expect(later).not.toContain("id: 3\n");
  expect(later).toContain("id: 4\n");

  ac.abort();
  expect(broker.size).toBe(0);
});

test("埋め直しで投げたら、購読を残さずに閉じる", async () => {
  const broker = new Broker();
  const res = sseStream({
    latestSeq: () => 0,
    backlog: () => {
      throw new Error("DB が読めない");
    },
    subscribe: (fn) => broker.subscribe(fn),
    signal: new AbortController().signal,
  });
  const text = await res.text();
  expect(text).toContain("retry: 5000");
  expect(broker.size).toBe(0);
});

test("埋め直しが上限を超えたら、送らずに resync を送り、いまの最後から生の配信に移る", async () => {
  const broker = new Broker();
  const ac = new AbortController();
  let asked = 0;
  const res = sseStream({
    backlog: (limit) => {
      asked = limit;
      return [ev(2), ev(3), ev(4), ev(5)].slice(0, limit);
    },
    latestSeq: () => 5,
    backlogLimit: 3,
    subscribe: (fn) => broker.subscribe(fn),
    signal: ac.signal,
    pingMs: 20,
  });
  const reader = res.body?.getReader();
  if (!reader) throw new Error("本文が無い");
  const first = await readUntil(reader, "event: resync");
  // 超えたと分かるよう、上限より 1 件多く尋ねる
  expect(asked).toBe(4);
  expect(first).toContain('id: 5\nevent: resync\ndata: {"after":5}\n\n');
  expect(first).not.toContain("event: advisory");

  broker.publish(ev(5)); // resync の番号までは送らない
  broker.publish(ev(6));
  const later = await readUntil(reader, ": ping");
  expect(later).not.toContain("id: 5\n");
  expect(later).toContain("id: 6\n");
  ac.abort();
});

test("上限ちょうどなら、resync は送らずに全部埋め直す", async () => {
  const ac = new AbortController();
  const res = sseStream({
    backlog: (limit) => [ev(2), ev(3), ev(4)].slice(0, limit),
    latestSeq: () => 4,
    backlogLimit: 3,
    subscribe: () => () => {},
    signal: ac.signal,
    pingMs: 20,
  });
  const reader = res.body?.getReader();
  if (!reader) throw new Error("本文が無い");
  const text = await readUntil(reader, ": ping");
  expect(text).not.toContain("resync");
  expect(text).toContain("id: 4\n");
  ac.abort();
});
