/**
 * YouTube のライブカメラの、いま配信中の動画を確かめる (docs/design.md の 2.13)。
 *
 * - API のキー (`YOUTUBE_API_KEY`) が無ければ作らない。地図の印は出すが、地図の中では再生せず、チャンネルの
 *   ページへのリンクだけにする (`#lib/map/livecams.ts`)
 * - 動画の ID は配信をやり直すたびに替わるので、表 (`LIVECAMS`) にはチャンネルとタイトルの言葉を持つ。
 *   5 分ごとに、いま覚えている ID (初めは表の `seed`) を `videos.list` でまとめて確かめる (1 回 1 単位)。
 *   ライブでなくなったカメラがあれば、そのチャンネルを `search.list` (1 回 100 単位) で探し直す。探し直すのは
 *   チャンネルごとに 3 時間に 1 回まで (1 日の割り当て 1 万単位を守る)
 * - 採るのは、ライブ配信中・公開・埋め込みが許されている・子ども向け (made for kids) でない・表のチャンネルのもの・
 *   タイトルに表の言葉を含むもの。子ども向けの動画は埋め込むと追跡を止める決まりがあり (Developer Policies III.E.4.j)、
 *   ライブカメラには無いはずなので、出さない
 * - 取ったものはメモリに置くだけで、DB に残さない (Developer Policies の、API のデータを 30 日を超えて持たない決まり)
 * - キーは URL の query で送る (Data API の決まった形)。ログ・状態の欄・ブラウザには出さない
 */
import {
  isVideoId,
  type Livecam,
  type LivecamResponse,
  LIVECAMS,
} from "#lib/map/livecams.ts";

import { sleep, StatusTracker, USER_AGENT } from "./retry.ts";
import type { Source, SourceContext } from "./types.ts";

export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

/** いまの ID を確かめる間隔 (ミリ秒) */
export const YOUTUBE_CHECK_MS = 5 * 60_000;
/** 同じチャンネルを探し直す間の下限 (ミリ秒)。search.list は 1 回 100 単位で重い */
export const YOUTUBE_SEARCH_MIN_MS = 3 * 60 * 60_000;
/**
 * 最後に確かめてからこれより古ければ、配信中とは言わない (ミリ秒)。確かめられない間に配信が終わると、埋め込みが
 * 終わった配信の録画を流し、いまの映像と取り違えるため
 */
export const YOUTUBE_STALE_MS = 20 * 60_000;
const RETRY_MS = 60_000;
const MAX_RETRY_MS = 30 * 60_000;
const TIMEOUT_MS = 30_000;

/** 環境変数の API のキー。無ければ undefined */
export const youtubeKey = () =>
  process.env.YOUTUBE_API_KEY?.trim() || undefined;

/** `videos.list` の 1 件 (使う所だけ) */
export interface YtVideo {
  id: string;
  snippet?: {
    channelId?: string;
    title?: string;
    liveBroadcastContent?: string;
  };
  status?: {
    privacyStatus?: string;
    embeddable?: boolean;
    madeForKids?: boolean;
  };
}

/** この動画を、このカメラのいまの配信として出してよいか */
export function usable(v: YtVideo, c: Livecam): boolean {
  return (
    isVideoId(v.id) &&
    v.snippet?.channelId === c.channel &&
    v.snippet.liveBroadcastContent === "live" &&
    (v.snippet.title ?? "").includes(c.match) &&
    v.status?.privacyStatus === "public" &&
    v.status.embeddable === true &&
    v.status.madeForKids !== true
  );
}

export interface YoutubeOptions {
  onStatus?: SourceContext["onStatus"];
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
  cams?: Livecam[];
}

export interface YoutubeSource extends Source {
  /** `/api/livecams` の答え */
  response(): LivecamResponse;
}

/** いまの配信 (キーの無いサーバーでも、答えの形は同じ。`enabled: false` で中は空) */
let current: (() => LivecamResponse) | undefined;
export const livecamResponse = (): LivecamResponse =>
  current?.() ?? { enabled: false, cams: {} };

/** キーがあれば情報源を作る。無ければ undefined (受信の一覧には `off` で並べる) */
export function youtubeSource(
  key: string | undefined = youtubeKey(),
  o: YoutubeOptions = {},
): YoutubeSource | undefined {
  const k = key?.trim();
  if (!k) return undefined;
  const cams = o.cams ?? LIVECAMS;
  const status = new StatusTracker("youtube", o.onStatus, {
    kind: "poll",
    everyMs: YOUTUBE_CHECK_MS,
  });
  const doFetch = o.fetch ?? fetch;
  const wait = o.sleep ?? sleep;
  const now = o.now ?? Date.now;
  const log = o.log ?? ((m: string) => console.log(m));

  /** カメラの id → いま覚えている動画の ID と、それが配信中か */
  const known = new Map<string, { videoId: string; live: boolean }>(
    cams.map((c) => [c.id, { videoId: c.seed, live: false }]),
  );
  let checkedAt: string | undefined;
  /** チャンネル → 最後に探した時刻 */
  const searchedAt = new Map<string, number>();

  async function get(
    path: string,
    q: Record<string, string>,
    signal: AbortSignal,
  ) {
    const url = `${YOUTUBE_API}/${path}?${new URLSearchParams({ ...q, key: k as string })}`;
    const res = await doFetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    // URL にキーが入るので、エラーには API の名前 (path) と HTTP のステータスだけを出す
    if (!res.ok)
      throw new Error(
        `YouTube Data API の ${path} が ${res.status} を返しました`,
      );
    return (await res.json()) as { items?: unknown[] };
  }

  async function videos(
    ids: string[],
    signal: AbortSignal,
  ): Promise<YtVideo[]> {
    const out: YtVideo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await get(
        "videos",
        {
          part: "snippet,status",
          id: ids.slice(i, i + 50).join(","),
          fields:
            "items(id,snippet(channelId,title,liveBroadcastContent),status(privacyStatus,embeddable,madeForKids))",
        },
        signal,
      );
      out.push(...((r.items ?? []) as YtVideo[]));
    }
    return out;
  }

  /**
   * 1 回の確認。`videos.list` が通れば、そこで確かめた時刻を進める (配信中のカメラは出し続ける)。
   * 探し直し (`search.list`) の失敗は、チャンネルごとにログに残して次のチャンネルへ進み、失敗の訳を返す
   * (割り当て切れなどで探し直しだけが失敗しても、ほかのカメラを止めない)
   */
  async function check(signal: AbortSignal): Promise<string[]> {
    const ids = [
      ...new Set([...known.values()].map((v) => v.videoId).filter(isVideoId)),
    ];
    const byId = new Map((await videos(ids, signal)).map((v) => [v.id, v]));
    const lost = new Set<string>();
    for (const c of cams) {
      const cur = known.get(c.id);
      const v = cur ? byId.get(cur.videoId) : undefined;
      const live = v !== undefined && usable(v, c);
      known.set(c.id, { videoId: cur?.videoId ?? c.seed, live });
      if (!live) lost.add(c.channel);
    }
    checkedAt = new Date(now()).toISOString();
    const errors: string[] = [];
    // ライブでなくなったカメラのチャンネルを探し直す (チャンネルごとに 3 時間に 1 回まで)
    for (const ch of lost) {
      const last = searchedAt.get(ch);
      if (last !== undefined && now() - last < YOUTUBE_SEARCH_MIN_MS) continue;
      searchedAt.set(ch, now());
      try {
        await research(ch, signal);
      } catch (err) {
        if (signal.aborted) throw err;
        const why = `${ch} を探し直せませんでした: ${String(err)}`;
        log(`[youtube] ${why}`);
        errors.push(why);
      }
    }
    return errors;
  }

  /** チャンネルのいまのライブを探し、タイトルの合う配信をカメラに当てる */
  async function research(ch: string, signal: AbortSignal): Promise<void> {
    const r = await get(
      "search",
      {
        part: "id",
        channelId: ch,
        eventType: "live",
        type: "video",
        maxResults: "50",
        fields: "items(id(videoId))",
      },
      signal,
    );
    const found = ((r.items ?? []) as { id?: { videoId?: unknown } }[])
      .map((i) => i.id?.videoId)
      .filter(isVideoId);
    const vs = await videos(found, signal);
    for (const c of cams) {
      if (c.channel !== ch || known.get(c.id)?.live) continue;
      const v = vs.find((x) => usable(x, c));
      if (v) {
        known.set(c.id, { videoId: v.id, live: true });
        log(`[youtube] ${c.name} の配信が替わりました (${v.id})`);
      }
    }
  }

  const response = (): LivecamResponse => {
    const fresh =
      checkedAt !== undefined &&
      now() - Date.parse(checkedAt) <= YOUTUBE_STALE_MS;
    return {
      enabled: true,
      cams: Object.fromEntries(
        cams.map((c) => {
          const v = known.get(c.id);
          return [
            c.id,
            { videoId: fresh && v?.live ? v.videoId : undefined, checkedAt },
          ];
        }),
      ),
    };
  };
  current = response;

  return {
    id: "youtube",
    status: () => status.get(),
    response,
    async run(signal) {
      let failures = 0;
      while (!signal.aborted) {
        let delay = YOUTUBE_CHECK_MS;
        try {
          const errors = await check(signal);
          failures = 0;
          status.seen(true);
          if (errors.length > 0) status.set("connected", errors.join(" / "));
          else {
            status.recovered();
            status.set("connected");
          }
        } catch (err) {
          if (signal.aborted) break;
          failures++;
          const why = String(err);
          log(`[youtube] 確かめられませんでした: ${why}`);
          status.set(checkedAt ? "connected" : "retrying", why);
          delay = Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** (failures - 1));
        }
        await wait(delay, signal);
      }
      status.set("stopped");
    },
  };
}
