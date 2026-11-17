/**
 * Wolfx SeisJS (有志の観測点のいまの揺れ)。docs/design.md の 2.10。
 *
 * - 文書: https://wolfx.jp/seisapi ・プライバシー通知 https://seis.wolfx.jp/PrivatePolicy/ja_JP
 * - 2026-11-17 に Wolfx から、家庭のセルフホストで家族の地図に出すのは SeisJS の利用目的の範囲内で、
 *   個別の許諾は要らないと答えをもらった。出典は「Wolfx Project (SeisJS)」(`#lib/notice.ts`)
 * - 接続はサーバーごとに 1 本を使い回し、切れたら間隔を延ばしながら張り直す (Wolfx の頼み)。
 *   張り直しは P2P・Wolfx と同じ `runSocket` (1 秒から倍々、上限 30 秒、full jitter)。90 秒何も来なければ張り直す
 * - 観測点はそれぞれ約 1 秒ごとに送ってくる (2026-11-17 に測ると 7 か所で 1 日 800MB ほど)。
 *   受けた値は 1 秒ごとにまとめて `RtsBoard` に入れ、画面には見た目が変わったときと 5 秒ごとにだけ配る
 * - **知らせには使わない。** DB にも Broker にも入れない (地図の点の色だけ。TREM-RTS と同じ)
 * - 値は気象庁の計測震度の求め方で観測点が計算した `CalcShindo`。非公式で、気象庁の震度ではない
 * - `private` の観測点 (持ち主が位置を隠したいと頼んだもの) は出さない
 */

import type { RtsStation } from "#lib/rts.ts";

import type { RtsBoard } from "../rts-board.ts";
import {
  type Connect,
  runSocket,
  sleep,
  StatusTracker,
  USER_AGENT,
} from "./retry.ts";
import type { Source, SourceContext } from "./types.ts";

const SEISJS_WS = "wss://seisjs.wolfx.jp/all_seis";
const SEISJS_LIST = "https://api.wolfx.jp/seis_list.json";

/** これより古い観測点の値は、まとめに入れない (ミリ秒) */
const VALUE_TTL_MS = 5_000;

/** 位置として使える数か */
const okLonLat = (x: unknown, y: unknown): x is number =>
  typeof x === "number" &&
  typeof y === "number" &&
  Number.isFinite(x) &&
  Number.isFinite(y) &&
  Math.abs(y) <= 90 &&
  Math.abs(x) <= 180;

/** 観測点の一覧 (`seis_list.json`) を読む。使える (`enable`) 観測点だけ。id → [経度, 緯度] */
export function parseSeisList(doc: unknown): Map<string, RtsStation> {
  const out = new Map<string, RtsStation>();
  if (typeof doc !== "object" || doc === null)
    throw new Error("観測点の一覧が読めません");
  for (const [id, v] of Object.entries(doc as Record<string, unknown>)) {
    const s = v as {
      enable?: unknown;
      private?: unknown;
      latitude?: unknown;
      longitude?: unknown;
    } | null;
    if (!s || s.enable === false || s.private === true) continue;
    if (!okLonLat(s.longitude, s.latitude)) continue;
    out.set(id, [s.longitude, s.latitude as number]);
  }
  return out;
}

/** 1 件の観測の値。heartbeat や読めないものは undefined */
export interface SeisReading {
  id: string;
  /** 計測震度 (観測点が計算したもの) */
  i: number;
  /** 位置 (位置を隠した観測点は無し) */
  at?: RtsStation;
  private: boolean;
}

export function parseSeis(doc: unknown): SeisReading | undefined {
  if (typeof doc !== "object" || doc === null) return undefined;
  const m = doc as Record<string, unknown>;
  const id = m.type;
  if (typeof id !== "string" || id === "heartbeat" || id === "pong")
    return undefined;
  const i = m.CalcShindo;
  if (typeof i !== "number" || !Number.isFinite(i)) return undefined;
  const hidden = m.private === true;
  return {
    id,
    i,
    private: hidden,
    at:
      !hidden && okLonLat(m.longitude, m.latitude)
        ? [m.longitude, m.latitude as number]
        : undefined,
  };
}

export interface SeisOptions {
  url?: string;
  listUrl?: string;
  connect?: Connect;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** まとめて配る間隔 (1 秒) */
  flushMs?: number;
  /** 観測点の一覧を取り直す間隔 (1 日) */
  listEveryMs?: number;
  now?: () => number;
  onStatus?: SourceContext["onStatus"];
  log?: (m: string) => void;
}

/** SeisJS の情報源。受けたものは `board` に入れるだけ */
export function seisSource(board: RtsBoard, o: SeisOptions = {}): Source {
  const status = new StatusTracker("seisjs", o.onStatus);
  const doFetch = o.fetch ?? fetch;
  const wait = o.sleep ?? sleep;
  const now = o.now ?? Date.now;
  const log = o.log ?? ((m: string) => console.log(m));
  const listUrl = o.listUrl ?? SEISJS_LIST;
  let etag: string | undefined;
  let stations = new Map<string, RtsStation>();
  const latest = new Map<string, { i: number; at: number }>();

  function setStations(m: Map<string, RtsStation>) {
    stations = m;
    board.setStations(new Map(m));
  }

  /** 観測点の一覧を取る。変わっていなければ (304) 何もしない。取れたら true */
  async function loadList(signal: AbortSignal): Promise<boolean> {
    try {
      const res = await doFetch(listUrl, {
        headers: {
          "user-agent": USER_AGENT,
          ...(etag ? { "if-none-match": etag } : {}),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      if (res.status === 304) return true;
      if (!res.ok) throw new Error(`${listUrl} が ${res.status} を返しました`);
      const m = parseSeisList(await res.json());
      etag = res.headers.get("etag") ?? undefined;
      setStations(m);
      return true;
    } catch (err) {
      if (!signal.aborted)
        log(`[seisjs] 観測点の一覧を取れませんでした: ${err}`);
      return false;
    }
  }

  /** 1 日ごとに観測点の一覧を取り直す。取れなければ 10 分から倍々 (上限 6 時間) で試す */
  async function listLoop(signal: AbortSignal): Promise<void> {
    let fail = 0;
    while (!signal.aborted) {
      const ok = await loadList(signal);
      fail = ok ? 0 : fail + 1;
      await wait(
        ok
          ? (o.listEveryMs ?? 24 * 60 * 60_000)
          : Math.min(6 * 60 * 60_000, 10 * 60_000 * 2 ** (fail - 1)),
        signal,
      );
    }
  }

  /** 受けた値を 1 つ入れる。一覧に無い観測点も、位置が付いていれば足す */
  function take(r: SeisReading) {
    if (r.private) {
      // 位置を隠すよう頼まれた観測点は出さない (一覧に載っていても外す)
      latest.delete(r.id);
      if (stations.has(r.id)) {
        const m = new Map(stations);
        m.delete(r.id);
        setStations(m);
      }
      return;
    }
    if (!stations.has(r.id) && r.at) {
      const m = new Map(stations);
      m.set(r.id, r.at);
      setStations(m);
    }
    latest.set(r.id, { i: r.i, at: now() });
  }

  /** 新しい値だけをまとめて board に入れる */
  function flush() {
    const t = now();
    const i = new Map<string, number>();
    for (const [id, v] of latest) {
      if (t - v.at < VALUE_TTL_MS) i.set(id, v.i);
      else latest.delete(id);
    }
    if (i.size > 0) board.put(i);
  }

  return {
    id: "seisjs",
    status: () => status.get(),
    async run(signal) {
      void listLoop(signal).catch((err: unknown) =>
        log(`[seisjs] 観測点の一覧の取得が止まりました: ${err}`),
      );
      const timer = setInterval(flush, o.flushMs ?? 1_000);
      try {
        await runSocket({
          url: o.url ?? SEISJS_WS,
          signal,
          status,
          connect: o.connect,
          log: o.log,
          onClose() {
            latest.clear();
          },
          onMessage(text) {
            status.seen(false);
            const r = parseSeis(JSON.parse(text));
            if (!r) return;
            status.seen(true);
            take(r);
          },
        });
      } finally {
        clearInterval(timer);
      }
    },
  };
}
