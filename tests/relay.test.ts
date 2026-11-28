import { describe, expect, test } from "bun:test";

import { relayStale } from "#lib/relay.ts";
import type { RelayEntry, RelayStore } from "#lib/server/relay-store.ts";
import {
  maxAgeOf,
  readCapped,
  Relay,
  RELAY_SOURCES,
  type RelaySource,
  retryAfterSeconds,
} from "#lib/server/relay.ts";

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** 配信元のまね。`reply` が返すものを答え、呼ばれた URL と見出しを覚える */
function upstream(reply: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const c = {
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
    };
    calls.push(c);
    return reply(c, calls.length);
  }) as typeof fetch;
  return { calls, fetch: f };
}

const SRC = {
  t: {
    upstream: "https://example.test/data/",
    path: /^[a-z]+\/\d+\.png$/,
    ttl: 60,
    staleFor: 86_400,
    priority: 0,
  },
  q: {
    upstream: "https://example.test/search/",
    path: /^find$/,
    query: (q) => {
      const v = q.get("q");
      return v && [...q.keys()].length === 1
        ? `q=${encodeURIComponent(v)}`
        : null;
    },
    ttl: 0,
    store: false,
    staleFor: 0,
    priority: 0,
  },
  r: {
    upstream: "https://example.test/file/",
    path: /^a\.pmtiles$/,
    ttl: 3600,
    range: true,
    staleFor: 86_400,
    priority: 0,
  },
} satisfies Record<string, RelaySource>;

const png = (body = "img", headers: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "image/png", ...headers },
  });

const none = new URLSearchParams();
const h = (o: Record<string, string> = {}) => new Headers(o);

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, add: (ms: number) => (t += ms) };
}
/** 本体 10 バイトのものを 1 つ覚えたときに数える大きさ (本体と、鍵・見出し・入れ物の分) */ async function oneSize(
  sources: Record<string, RelaySource>,
  id: string,
  path: string,
): Promise<number> {
  const r = new Relay({
    sources,
    fetch: upstream(() => png("0123456789")).fetch,
  });
  await r.handle(id, path, none, h());
  return (await r.stats()).bytes;
}

test("同じタイルは、何台が読んでも配信元へは 1 回だけ取りに行く", async () => {
  const up = upstream(() => png("x", { "cache-control": "max-age=120" }));
  const c = clock();
  const r = new Relay({ sources: SRC, fetch: up.fetch, now: c.now });
  const a = await r.handle("t", "a/1.png", none, h());
  const b = await r.handle("t", "a/1.png", none, h());
  expect(await a.text()).toBe("x");
  expect(await b.text()).toBe("x");
  expect(a.headers.get("x-relay")).toBe("miss");
  expect(b.headers.get("x-relay")).toBe("hit");
  expect(b.headers.get("cache-control")).toBe("private, max-age=120");
  expect(b.headers.get("x-content-type-options")).toBe("nosniff");
  expect(b.headers.get("content-security-policy")).toBe(
    "default-src 'none'; sandbox",
  );
  expect(up.calls).toHaveLength(1);
  expect(up.calls.at(0)?.url).toBe("https://example.test/data/a/1.png");
  expect(up.calls.at(0)?.headers["user-agent"]).toContain("sonae");
  expect(up.calls.at(0)?.headers.cookie).toBeUndefined();
  expect(up.calls.at(0)?.headers.referer).toBeUndefined();
});

test("同時に来た同じ要求は 1 つにまとめる", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const up = upstream(async () => {
    await gate;
    return png("y");
  });
  const r = new Relay({ sources: SRC, fetch: up.fetch });
  const all = Promise.all(
    [1, 2, 3].map(() => r.handle("t", "a/2.png", none, h())),
  );
  release();
  const res = await all;
  expect(up.calls).toHaveLength(1);
  for (const x of res) expect(await x.text()).toBe("y");
});

test("期限が切れたら ETag を付けて取り直し、304 なら覚えたものを返す", async () => {
  const up = upstream((_, n) =>
    n === 1
      ? png("z", { "cache-control": "max-age=60", etag: '"v1"' })
      : new Response(null, { status: 304 }),
  );
  const c = clock();
  const r = new Relay({ sources: SRC, fetch: up.fetch, now: c.now });
  await r.handle("t", "a/3.png", none, h());
  c.add(61_000);
  const b = await r.handle("t", "a/3.png", none, h());
  expect(await b.text()).toBe("z");
  expect(up.calls).toHaveLength(2);
  expect(up.calls.at(1)?.headers["if-none-match"]).toBe('"v1"');
  // ブラウザが同じ ETag を持っていれば 304
  const c304 = await r.handle(
    "t",
    "a/3.png",
    none,
    h({ "if-none-match": '"v1"' }),
  );
  expect(c304.status).toBe(304);
  expect(up.calls).toHaveLength(2);
});

test("CDN が覚えていた分 (Age) は期限から引き、下限より短くはしない", async () => {
  const up = upstream(() =>
    png("a", { "cache-control": "max-age=60", age: "50" }),
  );
  const c = clock();
  const r = new Relay({
    sources: { t: { ...SRC.t, minTtl: 30 } },
    fetch: up.fetch,
    now: c.now,
  });
  const a = await r.handle("t", "a/4.png", none, h());
  expect(a.headers.get("cache-control")).toBe("private, max-age=30");
});

test("期限は上限 (maxTtl) より長くしない", async () => {
  const up = upstream(() => png("a", { "cache-control": "max-age=259200" }));
  const r = new Relay({
    sources: SRC,
    fetch: up.fetch,
    now: clock().now,
    maxTtl: 86_400,
  });
  const a = await r.handle("t", "a/5.png", none, h());
  expect(a.headers.get("cache-control")).toBe("private, max-age=86400");
});

test("429 を返されたら Retry-After の間は取りに行かず、覚えた古いものを返す", async () => {
  const up = upstream((_, n) =>
    n === 1
      ? png("old", { "cache-control": "max-age=60" })
      : new Response("busy", {
          status: 429,
          headers: { "retry-after": "120" },
        }),
  );
  const c = clock();
  const r = new Relay({ sources: SRC, fetch: up.fetch, now: c.now });
  await r.handle("t", "a/6.png", none, h());
  c.add(61_000);
  const b = await r.handle("t", "a/6.png", none, h());
  expect(b.headers.get("x-relay")).toBe("stale");
  expect(b.headers.get("cache-control")).toBe("no-store");
  expect(await b.text()).toBe("old");
  // 覚えていない道は 503 と Retry-After。配信元へは行かない
  const d = await r.handle("t", "b/1.png", none, h());
  expect(d.status).toBe(503);
  expect(Number(d.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(up.calls).toHaveLength(2);
  c.add(121_000);
  await r.handle("t", "b/1.png", none, h());
  expect(up.calls).toHaveLength(3);
});

test("配信元が落ちていて覚えたものも無ければ 502 (覚えない)", async () => {
  const up = upstream(() => {
    throw new TypeError("fetch failed");
  });
  const r = new Relay({ sources: SRC, fetch: up.fetch });
  const a = await r.handle("t", "a/7.png", none, h());
  expect(a.status).toBe(502);
  expect(a.headers.get("cache-control")).toBe("no-store");
  expect((await r.stats()).entries).toBe(0);
});

test("404 は短く覚え、500 は覚えないが、15 秒は取り直しに行かない", async () => {
  const up = upstream((c) =>
    c.url.endsWith("/1.png")
      ? new Response("no", { status: 404 })
      : new Response("err", { status: 500 }),
  );
  const c = clock();
  const r = new Relay({ sources: SRC, fetch: up.fetch, now: c.now });
  expect((await r.handle("t", "c/1.png", none, h())).status).toBe(404);
  expect((await r.handle("t", "c/1.png", none, h())).status).toBe(404);
  expect(up.calls).toHaveLength(1);
  expect((await r.handle("t", "c/2.png", none, h())).status).toBe(502);
  // 落ちている間は、要求のたびに配信元へ行かない
  const again = await r.handle("t", "c/2.png", none, h());
  expect(again.status).toBe(502);
  expect(again.headers.get("retry-after")).toBe("15");
  expect(up.calls).toHaveLength(2);
  c.add(16_000);
  await r.handle("t", "c/2.png", none, h());
  expect(up.calls).toHaveLength(3);
  expect((await r.stats()).entries).toBe(1);
});

test("壊れた gzip は、gzip を受けない要求に 502 で返す", async () => {
  const up = upstream(
    () =>
      new Response("not gzip", {
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
      }),
  );
  const r = new Relay({
    sources: { t: { ...SRC.t, path: /^x\.json$/ } },
    fetch: up.fetch,
  });
  expect((await r.handle("t", "x.json", none, h())).status).toBe(502);
});

test("弱い ETag も If-None-Match で同じものとみなす", async () => {
  const up = upstream(() =>
    png("w", { etag: 'W/"abc"', "cache-control": "max-age=60" }),
  );
  const r = new Relay({ sources: SRC, fetch: up.fetch });
  await r.handle("t", "a/9.png", none, h());
  const b = await r.handle(
    "t",
    "a/9.png",
    none,
    h({ "if-none-match": '"abc"' }),
  );
  expect(b.status).toBe(304);
});

test("同時に取りに行く数は、源ごとに上限を超えない", async () => {
  let running = 0;
  let peak = 0;
  const up = upstream(async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return png();
  });
  const r = new Relay({
    sources: { t: { ...SRC.t, concurrency: 2 } },
    fetch: up.fetch,
  });
  await Promise.all(
    Array.from({ length: 9 }, (_, i) => r.handle("t", `a/${i}.png`, none, h())),
  );
  expect(peak).toBe(2);
  expect(up.calls).toHaveLength(9);
});

test("表に無い源・道・問い合わせは断り、配信元へは行かない", async () => {
  const up = upstream(() => png());
  const r = new Relay({ sources: SRC, fetch: up.fetch });
  expect((await r.handle("x", "a/1.png", none, h())).status).toBe(404);
  expect((await r.handle("toString", "a/1.png", none, h())).status).toBe(404);
  expect((await r.handle("t", "../1.png", none, h())).status).toBe(400);
  expect((await r.handle("t", "a/1.jpg", none, h())).status).toBe(400);
  expect((await r.handle("t", "a//1.png", none, h())).status).toBe(400);
  expect(
    (await r.handle("t", "a/1.png", new URLSearchParams("x=1"), h())).status,
  ).toBe(400);
  expect(
    (await r.handle("q", "find", new URLSearchParams("q=a&b=1"), h())).status,
  ).toBe(400);
  expect(
    (await r.handle("t", "a/1.png", none, h({ range: "bytes=0-1" }))).status,
  ).toBe(416);
  expect(up.calls).toHaveLength(0);
});

test("覚えない源は、覚えずブラウザにも覚えさせない", async () => {
  const up = upstream(
    () =>
      new Response("[]", { headers: { "content-type": "application/json" } }),
  );
  const r = new Relay({ sources: SRC, fetch: up.fetch });
  const q = new URLSearchParams("q=厚木");
  const a = await r.handle("q", "find", q, h());
  await r.handle("q", "find", q, h());
  expect(a.headers.get("cache-control")).toBe("no-store");
  expect(up.calls).toHaveLength(2);
  expect(up.calls.at(0)?.url).toBe(
    `https://example.test/search/find?q=${encodeURIComponent("厚木")}`,
  );
  expect((await r.stats()).entries).toBe(0);
});

test("Range は範囲ごとに覚え、ファイルの ETag が変わったら前の版の範囲を捨てる", async () => {
  let etag = '"e1"';
  const up = upstream(
    (c) =>
      new Response(`part ${c.headers.range} ${etag}`, {
        status: 206,
        headers: { "content-range": "bytes 0-9/100", etag },
      }),
  );
  const r = new Relay({ sources: SRC, fetch: up.fetch });
  const a = await r.handle("r", "a.pmtiles", none, h({ range: "bytes=0-9" }));
  expect(a.status).toBe(206);
  expect(a.headers.get("content-range")).toBe("bytes 0-9/100");
  expect(up.calls.at(0)?.headers.range).toBe("bytes=0-9");
  await r.handle("r", "a.pmtiles", none, h({ range: "bytes=10-19" }));
  await r.handle("r", "a.pmtiles", none, h({ range: "bytes=0-9" }));
  expect(up.calls).toHaveLength(2);
  etag = '"e2"';
  await r.handle("r", "a.pmtiles", none, h({ range: "bytes=20-29" }));
  // 0-9 は前の版なので捨ててあり、取り直す
  const b = await r.handle("r", "a.pmtiles", none, h({ range: "bytes=0-9" }));
  expect(await b.text()).toContain('"e2"');
  expect(up.calls).toHaveLength(4);
  // 大きすぎる範囲は断る
  expect(
    (await r.handle("r", "a.pmtiles", none, h({ range: "bytes=0-99999999" })))
      .status,
  ).toBe(416);
});

test("gzip のまま覚え、gzip を受けない要求には開いて返す", async () => {
  const gz = Bun.gzipSync(new TextEncoder().encode('{"a":1}'));
  const up = upstream(
    () =>
      new Response(gz, {
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
      }),
  );
  const r = new Relay({
    sources: { t: { ...SRC.t, path: /^x\.json$/ } },
    fetch: up.fetch,
  });
  const a = await r.handle(
    "t",
    "x.json",
    none,
    h({ "accept-encoding": "gzip, br" }),
  );
  expect(a.headers.get("content-encoding")).toBe("gzip");
  const b = await r.handle("t", "x.json", none, h());
  expect(b.headers.get("content-encoding")).toBeNull();
  expect(await b.text()).toBe('{"a":1}');
});

test("上限を超えたら、長く使っていないものから捨てる", async () => {
  const up = upstream(() => png("0123456789"));
  const r = new Relay({
    sources: SRC,
    fetch: up.fetch,
    maxBytes: 2.5 * (await oneSize(SRC, "t", "a/1.png")),
  });
  await r.handle("t", "a/1.png", none, h());
  await r.handle("t", "a/2.png", none, h());
  await r.handle("t", "a/1.png", none, h()); // 1 を使ったので、2 が古い
  await r.handle("t", "a/3.png", none, h());
  expect((await r.stats()).entries).toBe(2);
  await r.handle("t", "a/1.png", none, h());
  expect(up.calls).toHaveLength(3);
  await r.handle("t", "a/2.png", none, h());
  expect(up.calls).toHaveLength(4);
});

test("本体は上限まで読み、Content-Length が無くても途中で切る", async () => {
  const stream = (n: number) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(10));
          c.close();
        },
      }),
    );
  expect((await readCapped(stream(3), 30))?.byteLength).toBe(30);
  expect(await readCapped(stream(4), 30)).toBeNull();
  expect(
    await readCapped(
      new Response("x", { headers: { "content-length": "99" } }),
      30,
    ),
  ).toBeNull();
});

test("見出しの読み方", () => {
  expect(maxAgeOf("public, max-age=259200")).toBe(259200);
  expect(maxAgeOf("no-store")).toBe(0);
  expect(maxAgeOf(null)).toBeUndefined();
  expect(retryAfterSeconds("30", 0)).toBe(30);
  expect(retryAfterSeconds(null, 0)).toBe(60);
  expect(retryAfterSeconds("99999", 0)).toBe(600);
});

test("地理院・ハザードマップ・GIBS の道", () => {
  const ok = (s: keyof typeof RELAY_SOURCES, p: string) =>
    RELAY_SOURCES[s].path.test(p);
  expect(ok("gsi", "seamlessphoto/14/14540/6451.jpg")).toBe(true);
  expect(ok("gsi", "afm/14/14540/6451.png")).toBe(true);
  expect(ok("gsi", "skhb04/10/908/403.geojson")).toBe(true);
  expect(ok("gsi", "sfh/10/908/403.geojson")).toBe(true);
  expect(ok("gsi", "std/10/908/403.png")).toBe(false);
  expect(ok("gsi", "optimal_bvmap-v1/optimal_bvmap-v1.pmtiles")).toBe(false);
  expect(ok("gsi-vector", "optimal_bvmap-v1/optimal_bvmap-v1.pmtiles")).toBe(
    true,
  );
  expect(ok("disaportal", "01_flood_l2_shinsuishin_data/10/908/403.png")).toBe(
    true,
  );
  expect(ok("disaportal-legend", "shinsui_legend3.png")).toBe(true);
  expect(ok("gibs", "5/12/28.jpeg")).toBe(true);
  expect(ok("gibs", "9/12/28.jpeg")).toBe(true);
});

test("火山カメラはページ (5 桁の VC だけ) と、撮った時刻の名前の画像だけを通す", async () => {
  const up = upstream(() => png());
  const r = new Relay({ sources: RELAY_SOURCES, fetch: up.fetch });
  const q = (s: string) => new URLSearchParams(s);
  const ok = async (p: string, s = "") =>
    (await r.handle("volcam", p, q(s), h())).status;
  expect(await ok("volcam/volcam.php", "VC=31501")).toBe(200);
  expect(await ok("camera/315_820081B0/20261128121001.jpg")).toBe(200);
  expect(up.calls.map((c) => c.url)).toEqual([
    "https://www.data.jma.go.jp/vois/data/obs/volcam/volcam.php?VC=31501",
    "https://www.data.jma.go.jp/vois/data/obs/camera/315_820081B0/20261128121001.jpg",
  ]);
  expect(await ok("volcam/volcam.php")).toBe(400);
  expect(await ok("volcam/volcam.php", "VC=315")).toBe(400);
  expect(await ok("volcam/volcam.php", "VC=31501&x=1")).toBe(400);
  expect(await ok("camera/315_820081B0/20261128121001.jpg", "a=1")).toBe(400);
  expect(await ok("camera/../volcam.php")).toBe(400);
  expect(await ok("other.php", "VC=31501")).toBe(400);
  expect(up.calls).toHaveLength(2);
});

test("地名検索は q だけを通し、覚えない", async () => {
  const up = upstream(
    () =>
      new Response("[]", { headers: { "content-type": "application/json" } }),
  );
  const r = new Relay({ sources: RELAY_SOURCES, fetch: up.fetch });
  const q = (s: string) => new URLSearchParams(s);
  const a = await r.handle("gsi-search", "AddressSearch", q("q=厚木市"), h());
  expect(a.status).toBe(200);
  expect(a.headers.get("cache-control")).toBe("no-store");
  expect(up.calls.at(0)?.url).toBe(
    `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent("厚木市")}`,
  );
  expect((await r.stats()).entries).toBe(0);
  for (const s of ["", "q=", "q=a&x=1", `q=${"あ".repeat(101)}`])
    expect(
      (await r.handle("gsi-search", "AddressSearch", q(s), h())).status,
    ).toBe(400);
  expect(up.calls).toHaveLength(1);
});

test("PMTiles は Range の無い要求を断る (まるごと取らせない)", async () => {
  const up = upstream(() => png());
  const r = new Relay({ sources: RELAY_SOURCES, fetch: up.fetch });
  const p = "optimal_bvmap-v1/optimal_bvmap-v1.pmtiles";
  expect((await r.handle("gsi-vector", p, none, h())).status).toBe(416);
  expect(up.calls).toHaveLength(0);
});

test("気象庁のタイルの道", () => {
  const p = RELAY_SOURCES.jmatile.path;
  expect(p.test("nowc/targetTimes_N1.json")).toBe(true);
  expect(
    p.test("nowc/20261120141500/none/20261120141500/surf/hrpns/10/908/403.png"),
  ).toBe(true);
  expect(
    p.test("risk/20261128042000/immed0/20261128042000/surf/flood/8/1/2.pbf"),
  ).toBe(true);
  expect(p.test("map/none/none/none/surf/designated_river/data.geojson")).toBe(
    true,
  );
  expect(p.test("snow/targetTimes.json")).toBe(true);
  expect(
    p.test("snow/20261128070000/none/20261128070000/surf/snowd/6/57/23.png"),
  ).toBe(true);
  expect(p.test("other/x.png")).toBe(false);
  expect(p.test("nowc/x.html")).toBe(false);
});

// ---- 配信元が落ちた・混んだとき (docs/design.md の 2.14 の「失敗したとき」) ----

/** 源の様子 (試験の源の名前は RelaySourceId に無いので、文字で引く) */
const stat = (r: Relay, id: string) =>
  r.statuses().find((s) => (s.id as string) === id);

/** 1 回目は取れ、`down()` の後は `fail` で失敗する配信元 */
function flaky(fail: () => Response) {
  let down = false;
  const up = upstream(() =>
    down ? fail() : png("old", { "cache-control": "max-age=60" }),
  );
  return { ...up, down: () => (down = true), up: () => (down = false) };
}

test("配信元が 5xx を返す間は、古いものに取った時刻を付けて返し、源の様子を「取れない」にする", async () => {
  const up = flaky(() => new Response("err", { status: 500 }));
  const c = clock();
  const r = new Relay({ sources: SRC, fetch: up.fetch, now: c.now });
  await r.handle("t", "a/1.png", none, h());
  const fetchedAt = new Date(c.now()).toISOString();
  expect(stat(r, "t")?.state).toBe("ok");
  up.down();
  c.add(61_000);
  const a = await r.handle("t", "a/1.png", none, h());
  expect(a.status).toBe(200);
  expect(a.headers.get("x-relay")).toBe("stale");
  expect(a.headers.get("x-relay-fetched-at")).toBe(fetchedAt);
  expect(relayStale(a)).toEqual({ fetchedAt: Date.parse(fetchedAt) });
  expect(a.headers.get("cache-control")).toBe("no-store");
  expect(await a.text()).toBe("old");
  const s = stat(r, "t");
  expect(s?.state).toBe("failing");
  expect(s?.since).toBe(new Date(c.now()).toISOString());
  expect(s?.lastOkAt).toBe(fetchedAt);
  expect(s?.staleAt).toBeDefined();
  // 戻ったら「取れる」に戻し、古いものを返した印も消す
  up.up();
  c.add(16_000);
  const b = await r.handle("t", "a/1.png", none, h());
  expect(b.headers.get("x-relay")).toBe("miss");
  expect(relayStale(b)).toBeUndefined();
  const back = stat(r, "t");
  expect(back?.state).toBe("ok");
  expect(back?.staleAt).toBeUndefined();
  expect(back?.since).toBeUndefined();
});

test("時間切れ (返らない) も落ちたのと同じに、古いものを返す", async () => {
  const up = flaky(() => {
    throw new DOMException("timed out", "TimeoutError");
  });
  const c = clock();
  const r = new Relay({ sources: SRC, fetch: up.fetch, now: c.now });
  await r.handle("t", "a/2.png", none, h());
  up.down();
  c.add(61_000);
  const a = await r.handle("t", "a/2.png", none, h());
  expect(a.headers.get("x-relay")).toBe("stale");
  expect(stat(r, "t")?.state).toBe("failing");
  // 覚えていないものは 502
  expect((await r.handle("t", "b/2.png", none, h())).status).toBe(502);
});

test("古いものを返すのは、源ごとに決めた長さ (staleFor) まで", async () => {
  const up = flaky(() => new Response("err", { status: 502 }));
  const c = clock();
  const r = new Relay({
    sources: { t: { ...SRC.t, staleFor: 600 } },
    fetch: up.fetch,
    now: c.now,
  });
  await r.handle("t", "a/3.png", none, h());
  up.down();
  // 期限 60 秒 + 古くても返す 600 秒の中
  c.add(60_000 + 599_000);
  expect((await r.handle("t", "a/3.png", none, h())).status).toBe(200);
  // 過ぎたら返さない
  c.add(16_000);
  expect((await r.handle("t", "a/3.png", none, h())).status).toBe(502);
});

test("続けて 3 回取れなければ、その源へはしばらく取りに行かない (ほかの道も)。待つ長さは倍々", async () => {
  const up = upstream(() => new Response("err", { status: 504 }));
  const c = clock();
  const r = new Relay({ sources: SRC, fetch: up.fetch, now: c.now });
  for (const p of ["c/1.png", "c/2.png", "c/3.png"])
    expect((await r.handle("t", p, none, h())).status).toBe(502);
  expect(up.calls).toHaveLength(3);
  // 4 つ目の道は配信元へ行かずに 503 と Retry-After
  const d = await r.handle("t", "c/4.png", none, h());
  expect(d.status).toBe(503);
  expect(d.headers.get("retry-after")).toBe("15");
  expect(d.headers.get("x-relay")).toBe("busy");
  expect(up.calls).toHaveLength(3);
  const s = stat(r, "t");
  expect(s?.state).toBe("blocked");
  expect(s?.retryAt).toBe(new Date(c.now() + 15_000).toISOString());
  // 15 秒たったら 1 回試し、また落ちていれば 30 秒待つ
  c.add(15_001);
  expect((await r.handle("t", "c/5.png", none, h())).status).toBe(502);
  expect(up.calls).toHaveLength(4);
  const e = await r.handle("t", "c/6.png", none, h());
  expect(e.headers.get("retry-after")).toBe("30");
  expect(up.calls).toHaveLength(4);
  // ほかの源には響かない
  expect(stat(r, "r")?.state).toBe("idle");
});

test("429 の間は源の様子を「控えている」にし、次に取りに行く時刻を出す", async () => {
  const up = upstream(
    () =>
      new Response("busy", { status: 429, headers: { "retry-after": "90" } }),
  );
  const c = clock();
  const r = new Relay({ sources: SRC, fetch: up.fetch, now: c.now });
  expect((await r.handle("t", "a/9.png", none, h())).status).toBe(503);
  const s = stat(r, "t");
  expect(s?.state).toBe("blocked");
  expect(s?.retryAt).toBe(new Date(c.now() + 90_000).toISOString());
  expect(s?.since).toBe(new Date(c.now()).toISOString());
});

test("源の様子が変わったときだけ知らせる", async () => {
  const up = flaky(() => new Response("err", { status: 500 }));
  const c = clock();
  const r = new Relay({ sources: SRC, fetch: up.fetch, now: c.now });
  let n = 0;
  r.onChange(() => n++);
  await r.handle("t", "a/1.png", none, h()); // まだ → 取れる
  c.add(61_000);
  await r.handle("t", "a/1.png", none, h()); // 取れるのまま
  expect(n).toBe(1);
  up.down();
  c.add(61_000);
  // 取れない、と、古いものを返した、の 2 つ
  await r.handle("t", "a/1.png", none, h());
  expect(n).toBe(3);
  await r.handle("t", "a/1.png", none, h()); // 15 秒の間。変わらない
  expect(n).toBe(3);
});

test("上限を超えたら、使った時刻に段の猶予を足して古いものから捨てる (災害時に要る層を後に回す)", async () => {
  const up = upstream(() => png("0123456789"));
  const c = clock();
  const sources = {
    low: { ...SRC.t, upstream: "https://low.test/", priority: 0 as const },
    high: { ...SRC.t, upstream: "https://high.test/", priority: 2 as const },
  };
  const r = new Relay({
    sources,
    fetch: up.fetch,
    now: c.now,
    maxBytes: 2.5 * (await oneSize(sources, "high", "a/1.png")),
  });
  await r.handle("high", "a/1.png", none, h());
  c.add(1000);
  await r.handle("low", "a/1.png", none, h());
  c.add(1000);
  // 高い層は先に使っていても残り、低い層が捨てられる
  await r.handle("low", "a/2.png", none, h());
  expect((await r.stats()).entries).toBe(2);
  await r.handle("high", "a/1.png", none, h());
  expect(up.calls).toHaveLength(3);
  // 猶予 (2 時間) を過ぎるほど使っていなければ、高い層でも先に捨てる
  c.add(3 * 3600_000);
  await r.handle("low", "a/3.png", none, h());
  c.add(1000);
  await r.handle("low", "a/4.png", none, h());
  await r.handle("high", "a/1.png", none, h());
  expect(
    up.calls.filter((x) => x.url === "https://high.test/a/1.png"),
  ).toHaveLength(2);
});

test("返せなくなったもの (古くても返してよい長さを過ぎたもの) から先に捨てる", async () => {
  const up = upstream(() =>
    png("0123456789", { "cache-control": "max-age=60" }),
  );
  const c = clock();
  const sources = {
    short: {
      ...SRC.t,
      upstream: "https://short.test/",
      staleFor: 60,
      priority: 2 as const,
    },
    long: {
      ...SRC.t,
      upstream: "https://long.test/",
      staleFor: 86_400,
      priority: 0 as const,
    },
  };
  const r = new Relay({
    sources,
    fetch: up.fetch,
    now: c.now,
    maxBytes: 2.5 * (await oneSize(sources, "short", "a/1.png")),
  });
  await r.handle("long", "a/1.png", none, h());
  await r.handle("short", "a/1.png", none, h());
  c.add(121_000);
  await r.handle("long", "a/2.png", none, h());
  // short は返せる長さを過ぎたので捨て、long の 2 つが残る
  expect((await r.stats()).entries).toBe(2);
});

test("置き場は差し替えられる (外の置き場のように Promise を返すものでも)", async () => {
  const m = new Map<string, RelayEntry>();
  const store: RelayStore = {
    get: async (k) => m.get(k),
    set: async (k, e) => void m.set(k, e),
    delete: async (k) => void m.delete(k),
    deletePrefix: async (p) => {
      for (const k of m.keys()) if (k.startsWith(p)) m.delete(k);
    },
    stats: async () => ({ bytes: 0, entries: m.size }),
  };
  const up = upstream(() => png("x", { "cache-control": "max-age=60" }));
  const r = new Relay({ sources: SRC, fetch: up.fetch, store });
  await r.handle("t", "a/1.png", none, h());
  const b = await r.handle("t", "a/1.png", none, h());
  expect(b.headers.get("x-relay")).toBe("hit");
  expect(m.size).toBe(1);
  expect(up.calls).toHaveLength(1);
});

test("源の表: 古いと危ない気象庁のタイルは短く、地図の下地は長く。避難場所は写真より後まで残す", () => {
  const s = RELAY_SOURCES;
  expect(s.jmatile.staleFor).toBeLessThan(s.gsi.staleFor);
  expect(s.gibs.staleFor).toBeGreaterThan(s.gsi.staleFor);
  expect(s.jmatile.priority).toBe(2);
  expect(s.gsi.priority("skhb04/10/908/403.geojson")).toBe(1);
  expect(s.gsi.priority("seamlessphoto/14/14540/6451.jpg")).toBe(0);
});

test("回路を開いた後は 1 本だけ試し、試している間に来たほかの要求は取りに行かない", async () => {
  let down = true;
  let release: () => void = () => {};
  const up = upstream(async (_, n) => {
    if (down) return new Response("err", { status: 500 });
    // 試しの 1 本 (4 回目) は、こちらが離すまで返らない
    if (n === 4) await new Promise<void>((r) => (release = r));
    return png("new", { "cache-control": "max-age=60" });
  });
  const c = clock();
  const r = new Relay({ sources: SRC, fetch: up.fetch, now: c.now });
  for (const p of ["d/1.png", "d/2.png", "d/3.png"])
    await r.handle("t", p, none, h());
  expect(up.calls).toHaveLength(3);
  down = false;
  c.add(15_001);
  const probe = r.handle("t", "d/4.png", none, h());
  await Promise.resolve();
  // 試している間のほかの道は、配信元へ行かずに 503
  const other = await r.handle("t", "d/5.png", none, h());
  expect(other.status).toBe(503);
  expect(up.calls).toHaveLength(4);
  release();
  expect((await probe).status).toBe(200);
  expect(stat(r, "t")?.state).toBe("ok");
  // 戻ったら、ほかの道も取りに行く
  expect((await r.handle("t", "d/5.png", none, h())).status).toBe(200);
  expect(up.calls).toHaveLength(5);
});

test("同時に取りに行っていたものが一度に落ちても、回路を開くのは 1 回に数える (待つのは 15 秒から)", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const up = upstream(async () => {
    await gate;
    return new Response("err", { status: 500 });
  });
  const c = clock();
  const r = new Relay({ sources: SRC, fetch: up.fetch, now: c.now });
  const all = ["e/1", "e/2", "e/3", "e/4", "e/5", "e/6"].map((p) =>
    r.handle("t", `${p}.png`, none, h()),
  );
  release();
  await Promise.all(all);
  expect(stat(r, "t")?.retryAt).toBe(new Date(c.now() + 15_000).toISOString());
});

test("見出しの後に本体の途中で切れたものも、落ちたのと同じに数えて古いものを返す", async () => {
  let broken = false;
  const up = upstream(() => {
    if (!broken) return png("old", { "cache-control": "max-age=60" });
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(new TextEncoder().encode("ha"));
        ctl.error(new DOMException("timed out", "TimeoutError"));
      },
    });
    return new Response(body, { status: 200 });
  });
  const c = clock();
  const r = new Relay({ sources: SRC, fetch: up.fetch, now: c.now });
  await r.handle("t", "f/1.png", none, h());
  broken = true;
  c.add(61_000);
  const a = await r.handle("t", "f/1.png", none, h());
  expect(a.headers.get("x-relay")).toBe("stale");
  expect(await a.text()).toBe("old");
  expect(stat(r, "t")?.state).toBe("failing");
});

test("取った時刻の見出しが読めない古いものは、時刻を出さない", () => {
  const res = new Response("x", { headers: { "x-relay": "stale" } });
  expect(relayStale(res)).toEqual({});
  expect(relayStale(new Response("x"))).toBeUndefined();
});

test("枠を待っていた要求は、その間に断られた (429) なら配信元へ行かない", async () => {
  let release: () => void = () => {};
  const first = new Promise<void>((r) => (release = r));
  const up = upstream(async (_, n) => {
    if (n === 1) {
      await first;
      return new Response("busy", {
        status: 429,
        headers: { "retry-after": "600" },
      });
    }
    return png();
  });
  const r = new Relay({
    sources: { t: { ...SRC.t, concurrency: 1 } },
    fetch: up.fetch,
  });
  const all = Array.from({ length: 10 }, (_, i) =>
    r.handle("t", `w/${i}.png`, none, h()),
  );
  release();
  const res = await Promise.all(all);
  expect(up.calls).toHaveLength(1);
  for (const x of res) {
    expect(x.status).toBe(503);
    expect(x.headers.get("x-relay")).toBe("busy");
  }
});

test("枠を待っていた要求は、その間に回路が開いたなら配信元へ行かない", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const up = upstream(async () => {
    await gate;
    return new Response("err", { status: 500 });
  });
  const r = new Relay({
    sources: { t: { ...SRC.t, concurrency: 3 } },
    fetch: up.fetch,
  });
  const all = Array.from({ length: 12 }, (_, i) =>
    r.handle("t", `x/${i}.png`, none, h()),
  );
  release();
  await Promise.all(all);
  expect(up.calls).toHaveLength(3);
});

test("403 (断られた) は配信元の不調に数え、覚えた古いものを消さずに返す", async () => {
  let refuse = false;
  const up = upstream(() =>
    refuse
      ? new Response("<html>denied</html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        })
      : png("old", { "cache-control": "max-age=60" }),
  );
  const c = clock();
  const r = new Relay({ sources: SRC, fetch: up.fetch, now: c.now });
  await r.handle("t", "y/1.png", none, h());
  refuse = true;
  c.add(61_000);
  const a = await r.handle("t", "y/1.png", none, h());
  expect(a.status).toBe(200);
  expect(a.headers.get("x-relay")).toBe("stale");
  expect(await a.text()).toBe("old");
  expect(stat(r, "t")?.state).toBe("failing");
  // 15 秒は取り直しに行かず、その後も古いものは残っている
  await r.handle("t", "y/1.png", none, h());
  expect(up.calls).toHaveLength(2);
  c.add(16_000);
  const b = await r.handle("t", "y/1.png", none, h());
  expect(await b.text()).toBe("old");
  expect((await r.stats()).entries).toBe(1);
  // 覚えたものが無ければ 502 で、配信元の HTML は返さない
  const d = await r.handle("t", "y/2.png", none, h());
  expect(d.status).toBe(502);
  expect(d.headers.get("content-type")).toContain("text/plain");
});

test("断るときの応答にも nosniff と CSP を付ける", async () => {
  const r = new Relay({ sources: SRC, fetch: upstream(() => png()).fetch });
  for (const res of [
    await r.handle("nope", "a/1.png", none, h()),
    await r.handle("t", "../x", none, h()),
  ]) {
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
  }
});

test("桁の多すぎる Range は断り、配信元へは行かない", async () => {
  const up = upstream(() => png());
  const r = new Relay({ sources: SRC, fetch: up.fetch });
  const big = "9".repeat(400);
  const a = await r.handle(
    "r",
    "a.pmtiles",
    none,
    h({ range: `bytes=${big}-${big}` }),
  );
  expect(a.status).toBe(416);
  expect(up.calls).toHaveLength(0);
});

test("覚えない源は、失敗した要求の文字も残さない", async () => {
  const up = upstream(() => new Response("err", { status: 500 }));
  const r = new Relay({ sources: SRC, fetch: up.fetch });
  const q = new URLSearchParams({ q: "東京都千代田区" });
  expect((await r.handle("q", "find", q, h())).status).toBe(502);
  const keys = [
    ...(
      r as unknown as { failedUntil: Map<string, number> }
    ).failedUntil.keys(),
  ];
  expect(keys.some((k) => k.includes("q="))).toBe(false);
});

test("覚えた量は、本体だけでなく鍵と見出しと入れ物の分も数える", async () => {
  const size = await oneSize(SRC, "t", "a/1.png");
  expect(size).toBeGreaterThan(10 + 256);
});

test("上限の内でも、返せなくなったものは 1 分に 1 回掃く", async () => {
  const up = upstream(() => new Response("no", { status: 404 }));
  const c = clock();
  const r = new Relay({ sources: SRC, fetch: up.fetch, now: c.now });
  for (let i = 0; i < 50; i++) await r.handle("t", `z/${i}.png`, none, h());
  expect((await r.stats()).entries).toBe(50);
  // 404 は 5 分だけ覚える。過ぎた後に何かを覚えると、掃かれる
  c.add(6 * 60_000);
  await r.handle("t", "z/99.png", none, h());
  expect((await r.stats()).entries).toBe(1);
});

test("同じホストの源 (地理院タイルと地理院地図Vector) は、断られたら一緒に控える", async () => {
  const up = upstream(
    () =>
      new Response("busy", { status: 429, headers: { "retry-after": "120" } }),
  );
  const sources = {
    a: { ...SRC.t, upstream: "https://same.test/a/" },
    b: { ...SRC.t, upstream: "https://same.test/b/" },
    c: { ...SRC.t, upstream: "https://other.test/" },
  };
  const r = new Relay({ sources, fetch: up.fetch });
  expect((await r.handle("a", "x/1.png", none, h())).status).toBe(503);
  // 同じホストの b は配信元へ行かずに控える。ほかのホストの c は取りに行く
  const b = await r.handle("b", "x/1.png", none, h());
  expect(b.headers.get("x-relay")).toBe("busy");
  await r.handle("c", "x/1.png", none, h());
  expect(up.calls.map((x) => new URL(x.url).host)).toEqual([
    "same.test",
    "other.test",
  ]);
});

test("Range の源で ETag が行き来しても、置き換えられた版は覚えず、いまの版の範囲を毎回捨てない", async () => {
  let etag = '"A"';
  const up = upstream(
    (c) =>
      new Response(`part ${c.headers.range} ${etag}`, {
        status: 206,
        headers: { "content-range": "bytes 0-9/100", etag },
      }),
  );
  const r = new Relay({ sources: SRC, fetch: up.fetch });
  const get = (range: string) => r.handle("r", "a.pmtiles", none, h({ range }));
  await get("bytes=0-9");
  etag = '"B"';
  await get("bytes=10-19");
  // 遅れて着いた前の版 (A) は返すが覚えず、B の範囲も捨てない
  etag = '"A"';
  const old = await get("bytes=20-29");
  expect(await old.text()).toContain('"A"');
  expect((await r.stats()).entries).toBe(1);
  etag = '"B"';
  await get("bytes=30-39");
  expect((await r.stats()).entries).toBe(2);
  // B の範囲は覚えたまま (配信元へは行かない)
  const calls = up.calls.length;
  await get("bytes=10-19");
  expect(up.calls).toHaveLength(calls);
});

test("同じホストの源が断られたら、もう片方の源の様子にも控えの始まりを出す", async () => {
  const up = upstream(
    () =>
      new Response("busy", {
        status: 429,
        headers: { "retry-after": "120" },
      }),
  );
  const c = clock();
  const sources = {
    a: { ...SRC.t, upstream: "https://same.test/a/" },
    b: { ...SRC.t, upstream: "https://same.test/b/" },
  };
  const r = new Relay({ sources, fetch: up.fetch, now: c.now });
  await r.handle("a", "x/1.png", none, h());
  const b = stat(r, "b");
  expect(b?.state).toBe("blocked");
  expect(b?.since).toBe(new Date(c.now()).toISOString());
});

test("同じホストの枠は、そのホストの源のうち小さいほうの数になる", async () => {
  let running = 0;
  let peak = 0;
  const up = upstream(async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((res) => setTimeout(res, 5));
    running--;
    return png();
  });
  const sources = {
    a: { ...SRC.t, upstream: "https://same.test/a/", concurrency: 5 },
    b: { ...SRC.t, upstream: "https://same.test/b/", concurrency: 2 },
  };
  const r = new Relay({ sources, fetch: up.fetch });
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => r.handle("a", `x/${i}.png`, none, h())),
  );
  expect(peak).toBe(2);
});

test("控えは、同じホストのほかの源が受けた短い Retry-After で縮めない", async () => {
  const releases: (() => void)[] = [];
  const up = upstream(async (c) => {
    await new Promise<void>((res) => releases.push(res));
    return new Response("busy", {
      status: 429,
      headers: { "retry-after": c.url.includes("/a/") ? "120" : "5" },
    });
  });
  const c = clock();
  const sources = {
    a: { ...SRC.t, upstream: "https://same.test/a/" },
    b: { ...SRC.t, upstream: "https://same.test/b/" },
  };
  const r = new Relay({ sources, fetch: up.fetch, now: c.now });
  const pa = r.handle("a", "x/1.png", none, h());
  const pb = r.handle("b", "x/1.png", none, h());
  while (releases.length < 2) await Promise.resolve();
  releases[0]?.();
  await pa;
  releases[1]?.();
  await pb;
  c.add(10_000);
  const again = await r.handle("b", "x/2.png", none, h());
  expect(again.headers.get("x-relay")).toBe("busy");
  expect(up.calls).toHaveLength(2);
});

describe("見る人の取り消し", () => {
  /** 枠を 1 本にし、1 本目 (`hold/0.png`) を離すまで返さない配信元 */
  function setup() {
    let release: () => void = () => {};
    const held = new Promise<void>((res) => (release = res));
    const up = upstream(async (c) => {
      if (c.url.includes("/hold/")) await held;
      return png("ok", { "cache-control": "max-age=60" });
    });
    const r = new Relay({
      sources: { t: { ...SRC.t, concurrency: 1 } },
      fetch: up.fetch,
    });
    const first = r.handle("t", "hold/0.png", none, h());
    return { r, up, first, release };
  }

  test("1 人が取り消しても、同じものを待つほかの人は取れる", async () => {
    const { r, up, first, release } = setup();
    const ac = new AbortController();
    const a = r.handle("t", "w/1.png", none, h(), ac.signal);
    const b = r.handle("t", "w/1.png", none, h(), new AbortController().signal);
    ac.abort();
    release();
    await first;
    expect((await b).status).toBe(200);
    await a;
    expect(up.calls.map((x) => new URL(x.url).pathname)).toEqual([
      "/data/hold/0.png",
      "/data/w/1.png",
    ]);
  });

  test("待っていた人が全員取り消したら、枠を待っている取りに行きはやめ、回路にも数えない", async () => {
    const { r, up, first, release } = setup();
    const ac = new AbortController();
    const a = r.handle("t", "w/2.png", none, h(), ac.signal);
    ac.abort();
    release();
    await first;
    expect((await a).status).toBe(503);
    expect(up.calls).toHaveLength(1);
    expect(stat(r, "t")?.state).toBe("ok");
    // 次に来た要求は取りに行く
    expect((await r.handle("t", "w/2.png", none, h())).status).toBe(200);
  });

  test("取りに行き始めた後に取り消しても、止めずに覚える", async () => {
    const { r, first, release } = setup();
    const ac = new AbortController();
    const a = r.handle("t", "hold/0.png", none, h(), ac.signal);
    ac.abort();
    release();
    await first;
    await a;
    expect((await r.stats()).entries).toBe(1);
  });
});

test("読む上限 (4MB) を超える応答は覚えられないので、読まずに 502 にする", async () => {
  const up = upstream(() => new Response(new Uint8Array(4 * 1024 * 1024 + 1)));
  const r = new Relay({ sources: SRC, fetch: up.fetch });
  expect((await r.handle("t", "big/1.png", none, h())).status).toBe(502);
});

test("gzip を受けない要求に開いて返すときも、開いた後の大きさは 4MB まで", async () => {
  const { gzipSync } = await import("node:zlib");
  const bomb = gzipSync(new Uint8Array(5 * 1024 * 1024));
  const up = upstream(
    () =>
      new Response(bomb, {
        headers: { "content-type": "image/png", "content-encoding": "gzip" },
      }),
  );
  const r = new Relay({ sources: SRC, fetch: up.fetch });
  const plain = await r.handle("t", "gz/1.png", none, h());
  expect(plain.status).toBe(502);
  const gz = await r.handle(
    "t",
    "gz/1.png",
    none,
    h({ "accept-encoding": "gzip" }),
  );
  expect(gz.status).toBe(200);
});

test("置き換えられた ETag が続けて 3 回来たら、配信元が前の版に戻したとみなして、いまの版にする", async () => {
  let etag = '"A"';
  const up = upstream(
    (c) =>
      new Response(`part ${c.headers.range} ${etag}`, {
        status: 206,
        headers: { "content-range": "bytes 0-9/100", etag },
      }),
  );
  const r = new Relay({ sources: SRC, fetch: up.fetch });
  const get = (range: string) => r.handle("r", "a.pmtiles", none, h({ range }));
  await get("bytes=0-9");
  etag = '"B"';
  await get("bytes=10-19");
  etag = '"A"';
  await get("bytes=20-29");
  await get("bytes=30-39");
  expect((await r.stats()).entries).toBe(1);
  // 3 回目で A をいまの版にし、B の範囲を捨てる
  await get("bytes=40-49");
  expect((await r.stats()).entries).toBe(1);
  await get("bytes=50-59");
  expect((await r.stats()).entries).toBe(2);
});
