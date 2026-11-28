import { expect, test } from "bun:test";

import {
  channelStreamsUrl,
  embedUrl,
  isChannelId,
  isVideoId,
  type Livecam,
  livecamFeatures,
  livecamFoot,
  LIVECAMS,
  livecamStatusText,
  watchUrl,
} from "#lib/map/livecams.ts";
import { baseStyle, MAP_LEGEND } from "#lib/map/style.ts";
import { CREDITS, creditText } from "#lib/notice.ts";
import {
  usable,
  YOUTUBE_SEARCH_MIN_MS,
  YOUTUBE_STALE_MS,
  youtubeSource,
  type YtVideo,
} from "#lib/server/sources/youtube.ts";

test("表: id・チャンネル・目安の ID・位置・出典がそろう", () => {
  const ids = new Set<string>();
  for (const c of LIVECAMS) {
    expect(c.id).toMatch(/^[a-z0-9-]+$/);
    expect(ids.has(c.id)).toBe(false);
    ids.add(c.id);
    expect(isChannelId(c.channel)).toBe(true);
    expect(isVideoId(c.seed)).toBe(true);
    expect(c.match.length).toBeGreaterThan(0);
    expect(c.page).toStartWith("https://");
    expect(c.credit.length).toBeGreaterThan(0);
    const [lon, lat] = c.at;
    expect(lon).toBeGreaterThan(122);
    expect(lon).toBeLessThan(154);
    expect(lat).toBeGreaterThan(24);
    expect(lat).toBeLessThan(46);
  }
  expect(livecamFeatures().features).toHaveLength(LIVECAMS.length);
});

test("URL: プライバシー強化モードで、音を消して再生。形の合わない ID は組まない", () => {
  expect(embedUrl("wOvC84yodk4")).toBe(
    "https://www.youtube-nocookie.com/embed/wOvC84yodk4?autoplay=1&mute=1&playsinline=1&rel=0",
  );
  expect(embedUrl("wOvC84yodk4", false)).toContain("autoplay=0");
  expect(embedUrl("../evil")).toBeUndefined();
  expect(embedUrl("wOvC84yodk4?x=1")).toBeUndefined();
  expect(watchUrl("wOvC84yodk4")).toBe(
    "https://www.youtube.com/watch?v=wOvC84yodk4",
  );
  expect(channelStreamsUrl("UCqdejTsUrCvZ55Y8u9v5h9w")).toBe(
    "https://www.youtube.com/channel/UCqdejTsUrCvZ55Y8u9v5h9w/streams",
  );
  expect(channelStreamsUrl("x")).toBeUndefined();
});

const cam = LIVECAMS.find((c) => c.id === "oshima-motomachi") as Livecam;

test("吹き出しの文: キーが無い・配信していない・読めないを書き分け、配信中なら何も書かない", () => {
  expect(livecamStatusText(undefined, cam)).toContain("読めませんでした");
  expect(livecamStatusText({ enabled: false, cams: {} }, cam)).toContain(
    "API のキーが無い",
  );
  expect(
    livecamStatusText(
      {
        enabled: true,
        cams: { [cam.id]: { checkedAt: "2026-11-28T03:00:00Z" } },
      },
      cam,
    ),
  ).toBe("いまは配信していないか、見つかりません (12:00 に確かめた)。");
  expect(
    livecamStatusText(
      { enabled: true, cams: { [cam.id]: { videoId: "wOvC84yodk4" } } },
      cam,
    ),
  ).toBeUndefined();
  // 配信していなければチャンネルのライブへ、配信中なら動画へ。出典と、映像に頼らない旨
  const off = livecamFoot(cam, undefined);
  expect(off[0]?.href).toBe(channelStreamsUrl(cam.channel));
  const on = livecamFoot(cam, "wOvC84yodk4");
  expect(on[0]?.href).toBe(watchUrl("wOvC84yodk4"));
  const text = on.map((l) => l.text).join("\n");
  expect(text).toContain("東京都港湾局提供");
  expect(text).toContain("この映像に頼らず");
  // YouTube 利用規約とプライバシーポリシーへのリンク (Developer Policies III.A.1・III.A.2)
  const hrefs = on.map((l) => l.href);
  expect(hrefs).toContain("https://www.youtube.com/t/terms");
  expect(hrefs).toContain("/privacy");
  expect(text).toContain("同意したことになります");
});

const live = (id: string, over: Partial<YtVideo> = {}): YtVideo => ({
  id,
  snippet: {
    channelId: cam.channel,
    title: "元町港（大島）",
    liveBroadcastContent: "live",
  },
  status: { privacyStatus: "public", embeddable: true, madeForKids: false },
  ...over,
});

test("採るのは、ライブ中・公開・埋め込み可・子ども向けでない・表のチャンネルでタイトルが合うものだけ", () => {
  expect(usable(live("wOvC84yodk4"), cam)).toBe(true);
  const no = (v: YtVideo) => expect(usable(v, cam)).toBe(false);
  no(
    live("wOvC84yodk4", {
      snippet: { ...live("x").snippet, liveBroadcastContent: "none" },
    }),
  );
  no(
    live("wOvC84yodk4", {
      snippet: { ...live("x").snippet, channelId: "UCxxxxxxxxxxxxxxxxxxxxxx" },
    }),
  );
  no(
    live("wOvC84yodk4", {
      snippet: { ...live("x").snippet, title: "三池港（三宅島）" },
    }),
  );
  no(
    live("wOvC84yodk4", {
      status: { privacyStatus: "unlisted", embeddable: true },
    }),
  );
  no(
    live("wOvC84yodk4", {
      status: { privacyStatus: "public", embeddable: false },
    }),
  );
  no(
    live("wOvC84yodk4", {
      status: { privacyStatus: "public", embeddable: true, madeForKids: true },
    }),
  );
  no(live("bad"));
});

/** YouTube Data API の代わり。呼ばれたパスと query を残す */
function fakeApi(o: { videos: Record<string, YtVideo>; search?: string[] }) {
  const calls: { path: string; q: URLSearchParams }[] = [];
  const f = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const path = u.pathname.split("/").pop() ?? "";
    calls.push({ path, q: u.searchParams });
    if (path === "videos") {
      const ids = (u.searchParams.get("id") ?? "").split(",");
      return Response.json({
        items: ids.flatMap((i) => (o.videos[i] ? [o.videos[i]] : [])),
      });
    }
    if (path === "search")
      return Response.json({
        items: (o.search ?? []).map((v) => ({ id: { videoId: v } })),
      });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

test("キーが無ければ情報源を作らない", () => {
  expect(youtubeSource(undefined)).toBeUndefined();
  expect(youtubeSource("  ")).toBeUndefined();
});

test("保存した ID がライブのままなら、探し直さない (videos.list だけ)", async () => {
  let t = Date.parse("2026-11-28T03:00:00Z");
  const api = fakeApi({ videos: { wOvC84yodk4: live("wOvC84yodk4") } });
  const ac = new AbortController();
  const src = youtubeSource("k", {
    cams: [cam],
    fetch: api.f,
    now: () => t,
    log: () => {},
    sleep: async () => ac.abort(),
  });
  if (!src) throw new Error("作られない");
  await src.run(ac.signal);
  expect(api.calls.map((c) => c.path)).toEqual(["videos"]);
  expect(api.calls[0]?.q.get("key")).toBe("k");
  expect(src.response().cams[cam.id]?.videoId).toBe("wOvC84yodk4");
  // 確かめてから 20 分より古ければ、配信中とは言わない (終わった配信の録画を流さない)
  t += YOUTUBE_STALE_MS + 1;
  expect(src.response().cams[cam.id]?.videoId).toBeUndefined();
});

test("ライブでなくなったら、チャンネルを探し直してタイトルの合う配信に替える。探し直しは 3 時間に 1 回まで", async () => {
  let t = Date.parse("2026-11-28T03:00:00Z");
  const ended = live("wOvC84yodk4", {
    snippet: { ...live("x").snippet, liveBroadcastContent: "none" },
  });
  const api = fakeApi({
    videos: {
      wOvC84yodk4: ended,
      NEWNEWNEW01: live("NEWNEWNEW01", {
        snippet: { ...live("x").snippet, title: "三池港（三宅島）" },
      }),
      NEWNEWNEW02: live("NEWNEWNEW02"),
    },
    search: ["NEWNEWNEW01", "NEWNEWNEW02"],
  });
  let rounds = 0;
  const ac = new AbortController();
  const logs: string[] = [];
  const src = youtubeSource("k", {
    cams: [cam],
    fetch: api.f,
    now: () => t,
    log: (m) => logs.push(m),
    sleep: async () => {
      rounds++;
      t += 5 * 60_000;
      if (rounds >= 2) ac.abort();
    },
  });
  if (!src) throw new Error("作られない");
  await src.run(ac.signal);
  // 1 回目: videos → search → videos。2 回目: 新しい ID がライブなので videos だけ
  expect(api.calls.map((c) => c.path)).toEqual([
    "videos",
    "search",
    "videos",
    "videos",
  ]);
  const s = api.calls[1]?.q;
  expect(s?.get("channelId")).toBe(cam.channel);
  expect(s?.get("eventType")).toBe("live");
  expect(src.response().cams[cam.id]?.videoId).toBe("NEWNEWNEW02");
  expect(logs.join("\n")).toContain("配信が替わりました");
  expect(YOUTUBE_SEARCH_MIN_MS).toBeGreaterThanOrEqual(3 * 60 * 60_000);
});

test("見つからなければ、3 時間たつまで探し直さない", async () => {
  let t = Date.parse("2026-11-28T03:00:00Z");
  const api = fakeApi({ videos: {}, search: [] });
  let rounds = 0;
  const ac = new AbortController();
  const src = youtubeSource("k", {
    cams: [cam],
    fetch: api.f,
    now: () => t,
    log: () => {},
    sleep: async () => {
      rounds++;
      t += 5 * 60_000;
      if (rounds >= 3) ac.abort();
    },
  });
  if (!src) throw new Error("作られない");
  await src.run(ac.signal);
  expect(api.calls.filter((c) => c.path === "search")).toHaveLength(1);
  expect(src.response().cams[cam.id]?.videoId).toBeUndefined();
});

test("探し直しが失敗しても、配信中のカメラは出し続け、確かめた時刻は進め、理由を状態に出す", async () => {
  let t = Date.parse("2026-11-28T03:00:00Z");
  const other = LIVECAMS.find((c) => c.id === "kumagawa") as Livecam;
  const base = fakeApi({ videos: { wOvC84yodk4: live("wOvC84yodk4") } });
  // 球磨川の目安の ID は答えに無い (終わった) ので探し直すが、search.list は 403 (割り当て切れ)
  const f = (async (input: string | URL | Request, init?: RequestInit) =>
    new URL(String(input)).pathname.endsWith("/search")
      ? new Response("", { status: 403 })
      : base.f(input, init)) as typeof fetch;
  const ac = new AbortController();
  const logs: string[] = [];
  const errs: string[] = [];
  let rounds = 0;
  const src = youtubeSource("k", {
    cams: [cam, other],
    fetch: f,
    now: () => t,
    log: (m) => logs.push(m),
    onStatus: (st) => errs.push(st.lastError ?? ""),
    sleep: async () => {
      rounds++;
      t += 15 * 60_000;
      if (rounds >= 2) ac.abort();
    },
  });
  if (!src) throw new Error("作られない");
  await src.run(ac.signal);
  // 2 回目は 15 分後。確かめた時刻が進んでいるので、20 分を過ぎても配信中のまま
  const r = src.response();
  expect(r.cams[cam.id]?.videoId).toBe("wOvC84yodk4");
  expect(r.cams[other.id]?.videoId).toBeUndefined();
  expect(r.cams[cam.id]?.checkedAt).toBe("2026-11-28T03:15:00.000Z");
  // 状態の欄に理由を出す (次の回は 3 時間の間を空けるので探し直さず、直近のエラーは消える)
  expect(errs.some((e) => e.includes("探し直せませんでした"))).toBe(true);
  expect(logs.join("\n")).toContain("403");
});

test("地図: 層と出典・凡例・出典の窓", () => {
  const style = baseStyle("https://example.test", undefined) as {
    sources: Record<string, { attribution?: string }>;
    layers: { id: string }[];
  };
  expect(style.sources.livecams?.attribution).toContain("YouTube");
  const ids = style.layers.map((l) => l.id);
  expect(ids.indexOf("livecams")).toBeGreaterThan(ids.indexOf("cameras"));
  expect(MAP_LEGEND.some((l) => l.label === "YouTube のライブカメラ")).toBe(
    true,
  );
  const credit = CREDITS.find((c) => c.label === "YouTube のライブカメラ");
  const text = credit ? creditText(credit) : "";
  expect(text).toContain("https://www.youtube.com/t/terms");
  expect(text).toContain("https://policies.google.com/privacy");
});
