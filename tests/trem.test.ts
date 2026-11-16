import { expect, test } from "bun:test";

import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

import { baseStyle, MAP_LEGEND } from "#lib/map/style.ts";
import type { SourceStatus } from "#lib/model.ts";
import { CREDITS, creditText } from "#lib/notice.ts";
import {
  RTS_QUIET,
  RTS_STALE_MS,
  rtsClass,
  rtsColor,
  rtsFeatures,
} from "#lib/rts.ts";
import {
  decodeRts,
  parseStations,
  RtsBoard,
  SseParser,
  tremDelay,
  tremSource,
} from "#lib/server/sources/trem.ts";

// 文書 (https://exptech.dev/docs/api/stream/station/) の項目の並びで作った観測点の表
const CSV = [
  "loc_code,id,lat,lon,floor,code,net,time,work",
  "1,125313C,23.3188,121.4564,2,962,3,2026-02-16,1",
  "2,1255670,24.1000,120.6000,1,401,3,2026-02-16,1",
  ",11DFDBC,22.6000,120.3000,1,800,4,2026-02-16,0",
  "3,BAD,x,121,1,1,3,2026-02-16,1",
].join("\n");

/** 文書の例の形のスナップショットを、配信と同じ base64(gzip(JSON)) にする */
const snapshot = (
  stations: Record<string, { i: number; pga?: number; alert?: 1 }>,
) =>
  Buffer.from(
    Bun.gzipSync(
      new TextEncoder().encode(
        JSON.stringify({
          source: "core-tnn1",
          ts: 1790619680000,
          stations,
          eq: [],
        }),
      ),
    ),
  ).toString("base64");

test("観測点の表: 使っている (work が 1) 観測点の位置だけ", () => {
  const m = parseStations(CSV);
  expect([...m.keys()]).toEqual(["125313C", "1255670"]);
  expect(m.get("125313C")).toEqual([121.4564, 23.3188]);
  expect(() => parseStations("a,b\n1,2")).toThrow();
});

test("スナップショット: base64 の gzip の JSON から計測震度 (i) を読む", () => {
  const r = decodeRts(
    snapshot({ "125313C": { i: 3.3, pga: 4.05, alert: 1 }, X: { i: -3 } }),
  );
  expect(r.ts).toBe(1790619680000);
  expect(r.i.get("125313C")).toBe(3.3);
  expect(r.i.get("X")).toBe(-3);
  expect(() =>
    decodeRts(
      Buffer.from(Bun.gzipSync(new TextEncoder().encode("{}"))).toString(
        "base64",
      ),
    ),
  ).toThrow();
});

test("SSE を分ける: 途中で切れた行もつなぎ、コメント (: ping) は数えない", () => {
  const p = new SseParser();
  expect(
    p.push(
      'retry: 3000\n\nevent: info\ndata: {"location":"lb-tpe1"}\n\n: ping 1\n\nda',
    ),
  ).toEqual([{ event: "info", data: '{"location":"lb-tpe1"}' }]);
  expect(p.push("ta: AAA\r\n\r\n")).toEqual([
    { event: "message", data: "AAA" },
  ]);
});

test("張り直しの間隔: 3 秒から倍々で上限 60 秒、1 秒までの揺らぎ。429 は 60 秒より短くしない", () => {
  const zero = () => 0;
  expect([0, 1, 2, 3, 4, 5, 9].map((n) => tremDelay(n, false, zero))).toEqual([
    3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000,
  ]);
  expect(tremDelay(0, false, () => 1)).toBe(4_000);
  expect(tremDelay(0, true, zero)).toBe(60_000);
});

test("いまの揺れ: 位置の分かる観測点だけを送り、古くなったら無し", () => {
  let now = 1_000_000;
  const board = new RtsBoard(() => now);
  const got: string[] = [];
  const stop = board.subscribe((kind) => got.push(kind));
  board.setStations(parseStations(CSV));
  const f = board.put(
    new Map([
      ["125313C", 3.26],
      ["NOPE", 5],
    ]),
  );
  expect(f.points).toEqual([[121.4564, 23.3188, 3.3]]);
  expect(board.current()).toEqual(f);
  now += RTS_STALE_MS;
  expect(board.current()).toBeUndefined();
  expect(got).toEqual(["rts-stations", "rts"]);
  stop();
  board.put(new Map());
  expect(got.length).toBe(2);
});

test("震度の色: 気象庁の階級の境で引く。0.5 未満と値の無い観測点は灰色", () => {
  expect(
    [0.4, 0.5, 1.5, 2.5, 3.5, 4.5, 5.0, 5.5, 6.0, 6.5].map(rtsClass),
  ).toEqual([undefined, "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"]);
  expect(rtsColor(undefined)).toBe(RTS_QUIET);
  expect(rtsColor(-3)).toBe(RTS_QUIET);
  expect(rtsColor(3.2)).toBe("rgb(0 65 255)");
});

test("地図の点: 観測点はいつも置き、揺れた観測点だけ色を付けて上に描く", () => {
  const fc = rtsFeatures(
    [
      [121.4, 23.3],
      [120.6, 24.1],
    ],
    {
      at: "2026-11-16T00:00:00.000Z",
      points: [
        [121.4, 23.3, 4.1],
        [121.4, 23.3, 2],
      ],
    },
  );
  expect(fc.features.length).toBe(2);
  const [a, b] = fc.features;
  expect(a?.properties).toEqual({
    shaking: true,
    color: "rgb(250 230 150)",
    order: 4.1,
  });
  expect(b?.properties.shaking).toBe(false);
  expect(b?.properties.color).toBe(RTS_QUIET);
  // 揺れが無いときは全部灰色
  expect(
    rtsFeatures([[121.4, 23.3]], null).features[0]?.properties.shaking,
  ).toBe(false);
});

/** 決まった字を流して閉じる応答 */
const streamOf = (text: string) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

test("受信: 観測点の表を取り、SSE のスナップショットを入れる。切れたら張り直す", async () => {
  const board = new RtsBoard();
  const seen: string[] = [];
  const statuses: SourceStatus["state"][] = [];
  const ctl = new AbortController();
  const waits: number[] = [];
  const src = tremSource(board, {
    url: "https://rts.example/sse",
    stationUrls: ["https://st.example/a"],
    random: () => 0,
    onStatus: (s) => statuses.push(s.state),
    log: () => {},
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      seen.push(u);
      if (u === "https://st.example/a") {
        const tag = new Headers(init?.headers).get("if-none-match");
        if (tag === 'W/"1"') return new Response(null, { status: 304 });
        return new Response(CSV, { headers: { etag: 'W/"1"' } });
      }
      return streamOf(
        `retry: 3000\n\nevent: info\ndata: {"location":"lb-tpe1"}\n\n: ping 1\n\ndata: ${snapshot({ "125313C": { i: 2.1, alert: 1 } })}\n\n`,
      );
    }) as typeof fetch,
    sleep: async (ms, signal) => {
      waits.push(ms);
      // 張り直しの 2 回目で止める (観測点の表の待ちは 10 分より長いので数えない)
      if (ms <= 61_000 && waits.filter((w) => w <= 61_000).length >= 2)
        ctl.abort();
      await new Promise((r) => setTimeout(r, 0));
      void signal;
    },
  });
  await src.run(ctl.signal);
  expect(board.stations().stations.length).toBe(2);
  expect(seen.filter((u) => u === "https://rts.example/sse").length).toBe(2);
  // 切れた後の張り直しは 3 秒・6 秒
  expect(waits.filter((w) => w <= 61_000)).toEqual([3_000, 6_000]);
  expect(statuses).toContain("connected");
  expect(src.status().state).toBe("stopped");
  expect(src.status().lastMessageAt).toBeDefined();
});

test("受信: 429 なら 60 秒より短く張り直さない", async () => {
  const ctl = new AbortController();
  const waits: number[] = [];
  const src = tremSource(new RtsBoard(), {
    url: "https://rts.example/sse",
    stationUrls: [],
    random: () => 0,
    log: () => {},
    fetch: (async () =>
      new Response("slow down", { status: 429 })) as unknown as typeof fetch,
    sleep: async (ms) => {
      waits.push(ms);
      if (ms <= 61_000) ctl.abort();
      await new Promise((r) => setTimeout(r, 0));
    },
  });
  await src.run(ctl.signal);
  expect(waits.filter((w) => w <= 61_000)).toEqual([60_000]);
});

test("出典: ExpTech の授權頁の書き方と、非公式で中央氣象署を優先する旨。地図の見方にも書く", () => {
  const all = CREDITS.map(creditText).join("\n");
  expect(all).toContain("資料來源：ExpTech Studio TREM（exptech.dev）");
  expect(all).toContain("以中央氣象署發布為準");
  expect(all).toContain("中央氣象署の発表を優先してください");
  expect(all).toContain("通知では知らせません");
  const legend = MAP_LEGEND.find((l) => l.label.startsWith("台湾の観測点"));
  expect(legend?.note).toContain("非公式");
});

test("地図の style は MapLibre の決まりに合う (式の形の誤りで地図が出なくなるのを防ぐ)", () => {
  for (const hazard of ["none", "flood", "faults"] as const) {
    const errors = validateStyleMin(
      baseStyle("https://s.example", hazard) as never,
    );
    expect(errors.map((e) => e.message)).toEqual([]);
  }
});
