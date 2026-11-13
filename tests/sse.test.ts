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
