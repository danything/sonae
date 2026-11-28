import { expect, test } from "bun:test";

import {
  BosaiFetcher,
  BosaiHttpError,
  MAX_BODY_BYTES,
  retryable,
} from "#lib/server/sources/bosai-fetch.ts";

test("控えの無い応答を覚えると、前の控えを捨てる (古い控えで 304 をもらわない)", async () => {
  const sent: Record<string, string>[] = [];
  const replies = [
    new Response("a", { headers: { etag: '"1"' } }),
    new Response("b"),
    new Response("c"),
  ];
  const http = new BosaiFetcher((async (_: string, init: RequestInit) => {
    sent.push(init.headers as Record<string, string>);
    return replies.shift() ?? new Response(null, { status: 304 });
  }) as unknown as typeof fetch);
  const url = "https://example.test/list.json";
  const signal = new AbortController().signal;
  const a = await http.get(url, signal, true);
  http.remember(url, a?.validators ?? {});
  const b = await http.get(url, signal, true);
  expect(sent[1]?.["if-none-match"]).toBe('"1"');
  http.remember(url, b?.validators ?? {});
  await http.get(url, signal, true);
  expect(sent[2]?.["if-none-match"]).toBeUndefined();
});

test("取り直してよい失敗は 5xx・408・429・つながらない・時間切れ", () => {
  expect(retryable(new BosaiHttpError("u", 503))).toBe(true);
  expect(retryable(new BosaiHttpError("u", 429))).toBe(true);
  expect(retryable(new BosaiHttpError("u", 404))).toBe(false);
  expect(retryable(new TypeError("fetch failed"))).toBe(true);
});

test("本体は 8MB までしか読まず、超えたら取り直さない失敗にする", async () => {
  const big = new Uint8Array(MAX_BODY_BYTES + 1);
  const f = new BosaiFetcher(
    (async () => new Response(big)) as unknown as typeof fetch,
  );
  const err = await f
    .get("https://example.invalid/x.json", new AbortController().signal, false)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BosaiHttpError);
  expect(retryable(err)).toBe(false);
  expect(String(err)).toContain("8MB");
});
