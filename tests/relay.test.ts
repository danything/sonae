import { expect, test } from "bun:test";

import {
  maxAgeOf,
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
  },
  r: {
    upstream: "https://example.test/file/",
    path: /^a\.pmtiles$/,
    ttl: 3600,
    range: true,
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
  const r = new Relay({ sources: SRC, fetch: up.fetch, maxTtl: 86_400 });
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
  expect(r.stats().entries).toBe(0);
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
  expect(r.stats().entries).toBe(1);
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
  expect(r.stats().entries).toBe(0);
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
  const r = new Relay({ sources: SRC, fetch: up.fetch, maxBytes: 25 });
  await r.handle("t", "a/1.png", none, h());
  await r.handle("t", "a/2.png", none, h());
  await r.handle("t", "a/1.png", none, h()); // 1 を使ったので、2 が古い
  await r.handle("t", "a/3.png", none, h());
  expect(r.stats()).toEqual({ bytes: 20, entries: 2 });
  await r.handle("t", "a/1.png", none, h());
  expect(up.calls).toHaveLength(3);
  await r.handle("t", "a/2.png", none, h());
  expect(up.calls).toHaveLength(4);
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
  expect(p.test("other/x.png")).toBe(false);
  expect(p.test("nowc/x.html")).toBe(false);
});
