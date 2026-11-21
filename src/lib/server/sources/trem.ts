/**
 * ExpTech の TREM-RTS (台湾の TREM-net の観測点のいまの揺れ)。docs/design.md の 2.9。
 *
 * - 文書: https://exptech.dev/docs/api/stream/rts/ ・観測点の表 https://exptech.dev/docs/api/stream/station/ ・
 *   SSE のつなぎ方 https://exptech.dev/docs/api/stream/ (どれも 2026-11-16 に読んだ)
 * - 授權頁 (https://exptech.dev/docs/api/start/license/) で RTS は「註明來源・不可商用」。token は要らない。
 *   出典は画面の「出典と注意」の窓 (`#lib/notice.ts`)。商用で立てるなら ExpTech の同意が要る (README)
 * - **知らせには使わない。** 受けたものは DB に入れず、Broker にも流さない (Web Push・Webhook・読み上げに届かない)。
 *   `RtsBoard` に今の値だけを持ち、開いている画面に `event: rts` で配る (地図の点の色だけ)
 * - 既定の sleep のモードでつなぐ (地震の間だけ 0.5 秒ごとに送り、ふだんは 60 秒ごとの `: ping` だけ)。
 *   ExpTech が「地震の間のデータだけ要るなら sleep」と勧めている。ふだんの観測点は灰色の点で置く
 * - 張り直しは文書のとおり 3 秒から倍々、上限 60 秒に揺らぎを足す。429 は 60 秒より短く張り直さない。
 *   90 秒何も来なければ (ping も含めて) 切れたとみなす
 * - 観測点の表は起動したときと 1 日に 1 回、出した所 (ノード) ごとの ETag で `If-None-Match` を付けて取る (CSV)
 * - 壊れても他の情報源に響かない (このアダプターの中で例外を受け、状態に出すだけ)
 */

import type { SourceStatus } from "#lib/model.ts";
import type { RtsStation } from "#lib/rts.ts";

import type { RtsBoard } from "../rts-board.ts";
import { sleep, StatusTracker, USER_AGENT } from "./retry.ts";
import type { Source } from "./types.ts";

const TREM_RTS_URL = "https://api.lb.exptech.dev/api/v1/trem/sse/rts";
/** 観測点の表。2 つのノードは同じ表を返す (ETag はノードごと)。先のほうから取る */
const TREM_STATION_URLS = [
  "https://static.core-tnn1.exptech.dev/resource/station",
  "https://static.core-tyo1.exptech.dev/resource/station",
];

/** 観測点の表 (CSV、見出しの行つき) を読む。使っている (`work` が 1) 観測点だけ。id → [経度, 緯度] */
export function parseStations(text: string): Map<string, RtsStation> {
  const out = new Map<string, RtsStation>();
  const lines = text.trim().split(/\r?\n/);
  const head = (lines.shift() ?? "").split(",").map((s) => s.trim());
  const id = head.indexOf("id");
  const lat = head.indexOf("lat");
  const lon = head.indexOf("lon");
  const work = head.indexOf("work");
  if (id < 0 || lat < 0 || lon < 0)
    throw new Error("観測点の表に id・lat・lon の列がありません");
  for (const line of lines) {
    const f = line.split(",");
    if (work >= 0 && f[work]?.trim() !== "1") continue;
    const key = f[id]?.trim();
    const y = Number(f[lat]);
    const x = Number(f[lon]);
    if (!key || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.abs(y) > 90 || Math.abs(x) > 180) continue;
    out.set(key, [x, y]);
  }
  return out;
}

/** RTS の 1 つのスナップショット (base64 の gzip の JSON) を読む。観測点 id → 計測震度 (`i`) */
export function decodeRts(data: string): Map<string, number> {
  const bytes = Uint8Array.from(atob(data.trim()), (c) => c.charCodeAt(0));
  const doc = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(bytes))) as {
    stations?: unknown;
  };
  if (typeof doc.stations !== "object" || doc.stations === null)
    throw new Error("stations がありません");
  const i = new Map<string, number>();
  for (const [k, v] of Object.entries(
    doc.stations as Record<string, unknown>,
  )) {
    const n = (v as { i?: unknown } | null)?.i;
    if (typeof n === "number" && Number.isFinite(n)) i.set(k, n);
  }
  return i;
}

/** SSE の 1 件 */
export interface SseMessage {
  event: string;
  data: string;
}

/** SSE の字を少しずつ受けて、1 件ずつに分ける (コメント行 `: ping` は数えない) */
export class SseParser {
  private buf = "";
  private event = "";
  private data: string[] = [];
  push(chunk: string): SseMessage[] {
    this.buf += chunk;
    const out: SseMessage[] = [];
    let nl: number;
    while ((nl = this.buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buf.slice(0, nl);
      const sep = this.buf.startsWith("\r\n", nl) ? 2 : 1;
      this.buf = this.buf.slice(nl + sep);
      if (line === "") {
        if (this.data.length > 0)
          out.push({
            event: this.event || "message",
            data: this.data.join("\n"),
          });
        this.event = "";
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const name = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (name === "event") this.event = value;
      else if (name === "data") this.data.push(value);
    }
    return out;
  }
}

/**
 * 張り直すまでの時間。文書のとおり 3 秒から倍々で上限 60 秒、それに 1 秒までの揺らぎを足す。
 * 429 (使いすぎ) のときは 60 秒より短くしない
 */
export function tremDelay(
  attempt: number,
  limited: boolean,
  random: () => number = Math.random,
): number {
  const base = Math.min(60_000, 3_000 * 2 ** Math.min(attempt, 10));
  const d = base + Math.round(random() * 1_000);
  return limited ? Math.max(60_000, d) : d;
}

export interface TremOptions {
  url?: string;
  stationUrls?: string[];
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  /** 何も来なければ切れたとみなす時間 (文書の 90 秒) */
  idleMs?: number;
  /** 観測点の表を取り直す間隔 (1 日) */
  stationsEveryMs?: number;
  onStatus?: (s: SourceStatus) => void;
  log?: (m: string) => void;
}

/** TREM-RTS の情報源。受けたものは `board` に入れるだけ */
export function tremSource(board: RtsBoard, o: TremOptions = {}): Source {
  const status = new StatusTracker("trem", o.onStatus, { kind: "sse" });
  const doFetch = o.fetch ?? fetch;
  const wait = o.sleep ?? sleep;
  const log = o.log ?? ((m: string) => console.log(m));
  const url = o.url ?? TREM_RTS_URL;
  const stationUrls = o.stationUrls ?? TREM_STATION_URLS;
  const idleMs = o.idleMs ?? 90_000;
  const etags = new Map<string, string>();

  /** 観測点の表を取る。変わっていなければ (304) 何もしない。取れたら true */
  async function loadStations(signal: AbortSignal): Promise<boolean> {
    for (const u of stationUrls) {
      try {
        const tag = etags.get(u);
        const res = await doFetch(u, {
          headers: {
            "user-agent": USER_AGENT,
            ...(tag ? { "if-none-match": tag } : {}),
          },
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        });
        if (res.status === 304) return true;
        if (!res.ok) throw new Error(`${u} が ${res.status} を返しました`);
        // 中身は CSV (Content-Type は application/json だが、文書のとおり字として読む)
        const m = parseStations(await res.text());
        if (m.size === 0) throw new Error("使える観測点がありません");
        const next = res.headers.get("etag");
        // ETag は出したノードのものだけを、そのノードに送る
        etags.clear();
        if (next) etags.set(u, next);
        board.setStations(m);
        return true;
      } catch (err) {
        if (signal.aborted) return false;
        log(`[trem] 観測点の表を取れませんでした: ${err}`);
      }
    }
    return false;
  }

  /** 1 日ごとに観測点の表を取り直す。取れなければ 10 分から倍々 (上限 6 時間) で試す */
  async function stationLoop(signal: AbortSignal): Promise<void> {
    let fail = 0;
    while (!signal.aborted) {
      const ok = await loadStations(signal);
      fail = ok ? 0 : fail + 1;
      const next = ok
        ? (o.stationsEveryMs ?? 24 * 60 * 60_000)
        : Math.min(6 * 60 * 60_000, 10 * 60_000 * 2 ** (fail - 1));
      await wait(next, signal);
    }
  }

  /** 1 回つないで、切れるまで読む。つながった時刻と、429 だったかを返す */
  async function once(
    signal: AbortSignal,
  ): Promise<{ openedAt?: number; limited: boolean }> {
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    signal.addEventListener("abort", stop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // つながるまでは 30 秒、つながってからは 90 秒何も来なければ切る
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        log(`[trem] ${ms / 1000} 秒何も来ないので張り直します`);
        status.set("retrying", "無通信");
        ctl.abort();
      }, ms);
    };
    let openedAt: number | undefined;
    try {
      arm(30_000);
      const res = await doFetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "text/event-stream" },
        signal: ctl.signal,
      });
      if (res.status === 429) {
        status.set("retrying", "429 (使いすぎ)");
        return { limited: true };
      }
      if (!res.ok || !res.body) {
        status.set("retrying", `${res.status} が返りました`);
        return { limited: false };
      }
      openedAt = Date.now();
      status.set("connected");
      status.seen(false);
      arm(idleMs);
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      // 読めないスナップショットが続く間 (地震の間は 0.5 秒ごとに来る) は、最初の 1 回だけ知らせる
      let unreadable = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm(idleMs);
        status.seen(false);
        for (const m of parser.push(decoder.decode(value, { stream: true }))) {
          if (m.event !== "message") continue;
          try {
            board.put(decodeRts(m.data));
            status.seen(true);
            if (unreadable) {
              unreadable = false;
              status.recovered();
            }
          } catch (err) {
            if (unreadable) continue;
            unreadable = true;
            status.set("connected", `読めないスナップショット: ${err}`);
          }
        }
      }
      status.set("retrying", "切れました");
    } catch (err) {
      if (!signal.aborted && !ctl.signal.aborted)
        status.set("retrying", String(err));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      ctl.abort();
    }
    return { openedAt, limited: false };
  }

  return {
    id: "trem",
    status: () => status.get(),
    async run(signal) {
      void stationLoop(signal).catch((err: unknown) =>
        log(`[trem] 観測点の表の取得が止まりました: ${err}`),
      );
      let attempt = 0;
      while (!signal.aborted) {
        status.set("connecting");
        const r = await once(signal);
        if (signal.aborted) break;
        // 60 秒つながっていたら間隔を戻す
        if (r.openedAt !== undefined && Date.now() - r.openedAt >= 60_000)
          attempt = 0;
        const delay = tremDelay(attempt, r.limited, o.random);
        attempt += 1;
        status.set("retrying");
        log(`[trem] ${Math.round(delay / 100) / 10} 秒後に張り直します`);
        await wait(delay, signal);
      }
      status.set("stopped");
    },
  };
}
