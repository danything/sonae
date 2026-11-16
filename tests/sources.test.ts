import { describe, expect, test } from "bun:test";

import { jmaSource } from "#lib/server/sources/jma.ts";
import { p2pSource } from "#lib/server/sources/p2p.ts";
import {
  Backoff,
  runSocket,
  type SocketLike,
  StatusTracker,
} from "#lib/server/sources/retry.ts";
import type { Incoming, SourceContext } from "#lib/server/sources/types.ts";
import { wolfxSource } from "#lib/server/sources/wolfx.ts";

import { fixture, json } from "./helpers.ts";

/** 情報源のサーバーは立てない。WebSocket と fetch を差し替える */
class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  private on: Record<string, ((e: never) => void)[]> = {};
  addEventListener(type: string, fn: (e: never) => void) {
    (this.on[type] ??= []).push(fn);
  }
  fire(type: string, e?: unknown) {
    for (const fn of this.on[type] ?? []) fn(e as never);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.fire("close");
  }
}

function context() {
  const got: Incoming[] = [];
  const keys = new Set<string>();
  const ctx: SourceContext = {
    emit: (m) => {
      got.push(m);
      keys.add(`${m.source}:${m.key}`);
    },
    seen: (s, k) => keys.has(`${s}:${k}`),
  };
  return { ctx, got };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("バックオフ: 1 秒から倍々で上限 30 秒、戻せる", () => {
  const b = new Backoff(1000, 30_000, () => 1);
  expect([
    b.next(),
    b.next(),
    b.next(),
    b.next(),
    b.next(),
    b.next(),
    b.next(),
  ]).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  b.reset();
  expect(b.next()).toBe(1000);
});

describe("気象庁のフィード", () => {
  test("条件付きで取り、304 なら何もしない。取る種別だけを、古い順に取る", async () => {
    const { ctx, got } = context();
    const calls: { url: string; headers: Record<string, string> }[] = [];
    let feedCalls = 0;
    const fakeFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      if (url.endsWith("eqvol.xml") || url.endsWith("eqvol_l.xml")) {
        feedCalls++;
        if (url.endsWith("eqvol.xml") && feedCalls > 2)
          return new Response(null, { status: 304 });
        return new Response(fixture("jma/made-feed.xml"), {
          headers: {
            etag: '"abc"',
            "last-modified": "Thu, 12 Nov 2026 23:01:14 GMT",
          },
        });
      }
      const name = /_(VXSE5\d)_/.exec(url)?.[1];
      const file =
        name === "VXSE53"
          ? "32-35_06_04_240613_VXSE53.xml"
          : name === "VXSE52"
            ? "32-35_06_01_240613_VXSE52.xml"
            : null;
      if (file) return new Response(fixture(`jma/${file}`));
      return new Response(
        "<Report><Control><Status>通常</Status></Control><Head><ReportDateTime>2008-06-14T08:00:00+09:00</ReportDateTime></Head></Report>",
      );
    }) as typeof fetch;

    const ac = new AbortController();
    let rounds = 0;
    const src = jmaSource(ctx, {
      feedUrl: "https://example.invalid/eqvol.xml",
      longFeedUrl: "https://example.invalid/eqvol_l.xml",
      fetch: fakeFetch,
      log: () => {},
      sleep: async () => {
        if (++rounds >= 2) ac.abort();
      },
    });
    await src.run(ac.signal);

    // 長期フィード (起動時) → 高頻度 → 高頻度 (304)。電文は 1 回ずつ
    const feeds = calls.filter((c) => c.url.includes("eqvol"));
    expect(feeds.map((c) => c.url.split("/").pop())).toEqual([
      "eqvol_l.xml",
      "eqvol.xml",
      "eqvol.xml",
    ]);
    expect(feeds[2]?.headers["if-none-match"]).toBe('"abc"');
    expect(feeds[2]?.headers["if-modified-since"]).toBeTruthy();
    expect(got.map((m) => m.code)).toEqual(["VXSE56", "VXSE52", "VXSE53"]);
    expect(calls.some((c) => c.url.includes("VFVO53"))).toBe(false);
    expect(src.status().state).toBe("stopped");
  });

  test("取れなければ retrying にして、次の回にまた取る", async () => {
    const { ctx } = context();
    const ac = new AbortController();
    const states: string[] = [];
    const src = jmaSource(
      { ...ctx, onStatus: (s) => states.push(s.state) },
      {
        fetch: (async () =>
          new Response("", { status: 503 })) as unknown as typeof fetch,
        log: () => {},
        sleep: async () => ac.abort(),
      },
    );
    await src.run(ac.signal);
    expect(states).toContain("retrying");
    expect(src.status().lastError).toContain("503");
  });
});

describe("WebSocket の輪", () => {
  test("切れたら張り直し、無通信が続いたら死んだとみなす", async () => {
    const sockets: FakeSocket[] = [];
    const ac = new AbortController();
    const status = new StatusTracker("p2p");
    const done = runSocket({
      url: "wss://example.invalid",
      signal: ac.signal,
      status,
      idleMs: 30,
      backoff: new Backoff(1, 1, () => 0),
      log: () => {},
      connect: () => {
        const s = new FakeSocket();
        sockets.push(s);
        queueMicrotask(() => s.fire("open"));
        return s;
      },
      onMessage: () => {},
    });
    await tick(5);
    expect(status.get().state).toBe("connected");
    sockets[0]?.close(); // 相手から切れた
    await tick(5);
    expect(sockets).toHaveLength(2);
    await tick(60); // 無通信で切る
    expect(sockets.length).toBeGreaterThanOrEqual(3);
    expect(sockets[1]?.closed).toBe(true);
    ac.abort();
    await done;
    expect(status.get().state).toBe("stopped");
  });

  test("idleMs が null なら、静かでも切らない (P2P)", async () => {
    const sockets: FakeSocket[] = [];
    const ac = new AbortController();
    const done = runSocket({
      url: "wss://example.invalid",
      signal: ac.signal,
      status: new StatusTracker("p2p"),
      idleMs: null,
      log: () => {},
      connect: () => {
        const s = new FakeSocket();
        sockets.push(s);
        queueMicrotask(() => s.fire("open"));
        return s;
      },
      onMessage: () => {},
    });
    await tick(50);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closed).toBe(false);
    ac.abort();
    await done;
  });
});

describe("P2P", () => {
  test("つながったら history で埋め、同じ id は一度だけ渡す", async () => {
    const { ctx, got } = context();
    const ac = new AbortController();
    let socket: FakeSocket | undefined;
    const history = [
      {
        ...json("p2p/spec-556.json"),
        id: "b",
        time: "2022/08/11 00:53:25.000",
      },
      { ...json("p2p/spec-551.json"), id: "a" },
      { id: "z", code: 555, areas: [] },
    ];
    let historyUrl = "";
    const src = p2pSource(ctx, {
      url: "wss://example.invalid/ws",
      historyUrl: "https://example.invalid/history",
      log: () => {},
      fetch: (async (u: string | URL) => {
        historyUrl = String(u);
        return Response.json(history);
      }) as typeof fetch,
      connect: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket?.fire("open"));
        return socket;
      },
    });
    const run = src.run(ac.signal);
    await tick(5);
    expect(historyUrl).toBe(
      "https://example.invalid/history?codes=551&codes=552&codes=556&limit=30",
    );
    expect(got.map((m) => m.key)).toEqual(["a", "b"]);
    socket?.fire("message", { data: JSON.stringify(history[0]) });
    socket?.fire("message", {
      data: JSON.stringify({ ...json("p2p/spec-552.json"), id: "c" }),
    });
    expect(got.map((m) => m.key)).toEqual(["a", "b", "c"]);
    ac.abort();
    await run;
  });
});

describe("Wolfx", () => {
  test("heartbeat には ping を返し、原文は渡さない", async () => {
    const { ctx, got } = context();
    const ac = new AbortController();
    let socket: FakeSocket | undefined;
    const src = wolfxSource(ctx, {
      log: () => {},
      connect: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket?.fire("open"));
        return socket;
      },
    });
    const run = src.run(ac.signal);
    await tick(5);
    socket?.fire("message", { data: fixture("wolfx/made-heartbeat.json") });
    expect(socket?.sent).toEqual(["query_jmaeqlist", "ping"]);
    socket?.fire("message", { data: fixture("wolfx/made-warning.json") });
    socket?.fire("message", { data: fixture("wolfx/made-warning.json") });
    expect(got).toHaveLength(1);
    expect(got[0]?.body).toBeUndefined();
    expect(JSON.stringify(got[0])).not.toContain("OriginalText");
    expect(src.status().lastMessageAt).toBeTruthy();
    ac.abort();
    await run;
  });

  test("同じ接続で地震情報の一覧を問い合わせ、中身の変わった行だけを渡す。ほかの速報は捨てる", async () => {
    const { ctx, got } = context();
    const ac = new AbortController();
    const sockets: FakeSocket[] = [];
    const src = wolfxSource(ctx, {
      log: () => {},
      now: () => "2008-06-14T08:55:00.000Z",
      connect: (url) => {
        expect(url).toBe("wss://ws-api.wolfx.jp/all_eew");
        const s = new FakeSocket();
        sockets.push(s);
        queueMicrotask(() => s.fire("open"));
        return s;
      },
    });
    const run = src.run(ac.signal);
    await tick(5);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.sent).toEqual(["query_jmaeqlist"]);
    const list = fixture("wolfx/made-eqlist.json");
    sockets[0]?.fire("message", { data: list });
    expect(got.map((m) => m.code)).toEqual(["jma_eqlist", "jma_eqlist"]);
    expect(got.every((m) => m.body === undefined)).toBe(true);
    // 一覧はまるごと来る。同じ中身の行は渡さない
    sockets[0]?.fire("message", { data: list });
    expect(got).toHaveLength(2);
    // 続報で 1 行だけ変わった
    const v = JSON.parse(list) as Record<string, unknown>;
    v.No1 = { ...(v.No1 as object), magnitude: "7.2" };
    sockets[0]?.fire("message", { data: JSON.stringify(v) });
    expect(got).toHaveLength(3);
    expect(got[2]?.items[0]).toMatchObject({
      type: "quake",
      report: { magnitude: 7.2 },
    });
    // all_eew にはほかの国の速報も流れる
    sockets[0]?.fire("message", {
      data: JSON.stringify({ type: "cenc_eew", ID: 1 }),
    });
    expect(got).toHaveLength(3);
    ac.abort();
    await run;
  });

  test("つながっている間は一覧を定期に問い合わせ、受けたら数え直し、切れたら止める", async () => {
    const { ctx, got } = context();
    const ac = new AbortController();
    const sockets: FakeSocket[] = [];
    const src = wolfxSource(ctx, {
      log: () => {},
      eqlistPollMs: 50,
      connect: () => {
        const s = new FakeSocket();
        sockets.push(s);
        queueMicrotask(() => s.fire("open"));
        return s;
      },
    });
    const run = src.run(ac.signal);
    const s = () => sockets[0] as FakeSocket;
    const queries = () =>
      s().sent.filter((x) => x === "query_jmaeqlist").length;
    await tick(5);
    expect(queries()).toBe(1);
    await tick(70);
    expect(queries()).toBe(2);
    // Wolfx が一覧を自分から送ってきたら、次の問い合わせはそこから数える (すぐには重ねない)
    const list = fixture("wolfx/made-eqlist.json");
    s().fire("message", { data: list });
    expect(got).toHaveLength(2);
    await tick(30);
    expect(queries()).toBe(2);
    await tick(40);
    expect(queries()).toBe(3);
    // 答えが前と同じ一覧なら何も渡さない
    s().fire("message", { data: list });
    expect(got).toHaveLength(2);
    // 切れている間は問い合わせない
    s().close();
    const before = s().sent.length;
    // 切れた接続に遅れて届いた一覧でも、問い合わせを置き直さない (送っていないことを下で確かめる)
    s().fire("message", { data: list });
    await tick(100);
    expect(s().sent.length).toBe(before);
    ac.abort();
    await run;
  });

  test("閉じかけの接続で問い合わせが投げても落ちず、次の問い合わせを続ける", async () => {
    const { ctx } = context();
    const ac = new AbortController();
    const logs: string[] = [];
    let tries = 0;
    let socket: FakeSocket | undefined;
    const src = wolfxSource(ctx, {
      log: (m) => logs.push(m),
      eqlistPollMs: 20,
      connect: () => {
        const s = new FakeSocket();
        s.send = () => {
          tries++;
          throw new Error("closing");
        };
        socket = s;
        queueMicrotask(() => s.fire("open"));
        return s;
      },
    });
    const run = src.run(ac.signal);
    await tick(50);
    expect(tries).toBeGreaterThanOrEqual(2);
    expect(logs.some((m) => m.includes("問い合わせられませんでした"))).toBe(
      true,
    );
    expect(socket?.closed).toBe(false);
    ac.abort();
    await run;
  });
});
