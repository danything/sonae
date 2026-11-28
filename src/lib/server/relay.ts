/**
 * 外のもの (地図のタイル・時刻の表など) を、sonae のサーバーが配信元から取って覚え、家の中の端末へ配る中継
 * (docs/design.md の 2.14)。ブラウザは配信元へ直接つながず `/relay/<源>/<道>` を読む (`#lib/relay.ts`)。
 *
 * 配信元への負荷を減らすための作り:
 * - 同じものを家族の何台が読んでも、配信元へは 1 回だけ取りに行き、期限の間は覚えたものを返す
 * - 同時に来た同じ要求は 1 つにまとめる (取りに行っている間に来た要求は、その答えを待つ)
 * - 期限は配信元の `Cache-Control: max-age` (無ければ源ごとの既定) で、源ごとの下限と全体の上限で挟む。
 *   期限が切れたら `If-None-Match`・`If-Modified-Since` を付けて取り直す (変わっていなければ 304 で本体を運ばない)
 * - 先読みはしない。見る人がいないときは何も取らない (要求が来たときだけ取る)
 * - 配信元が 429・503 を返したら、`Retry-After` (無ければ 60 秒、上限 10 分) の間はそのホストへ取りに行かない
 * - 配信元のホストごとに同時に取りに行く数を絞る (同じホストの源は枠と控えを分け合う)
 * - 見る人が要求を取り消し、同じものを待つ人がいなくなったら、枠を待っている取りに行きはやめる
 * - User-Agent に sonae と分かる名前を付ける。Cookie・Referer・使う人の IP は送らない
 *
 * 失敗したとき: 古くても覚えたものがあれば、源ごとに決めた長さ (`staleFor`) まで返す (`x-relay: stale` と、取った時刻の
 * `x-relay-fetched-at`)。無ければ 502 (配信元が落ちた・返らない。同じものは 15 秒取りに行かない) か 503 (`Retry-After` つき。
 * 配信元に断られたか、続けて失敗したので待っている間)。どちらも覚えず、ブラウザにも覚えさせない。
 * 源ごとの配信元との様子 (`statuses()`) は、受信の状態と地図の凡例に出す (`#lib/relay.ts` の `RelayStatus`)。
 *
 * 中身は変えない (色も値も。docs/design.md の 5 章)。配信元が gzip で返したものは gzip のまま覚えて返す。
 * 覚える置き場は差し替えられる (`#lib/server/relay-store.ts`)。いまはプロセスのメモリだけで、上限 (`SONAE_RELAY_CACHE_MB`)
 * を超えたら、災害時に要る層を後に回して、長く使っていないものから捨てる。起動し直すと空になる。
 * 地名検索のように覚えない源 (`store: false`) は、覚えず、ログにも中身を出さない。
 */

import { gunzipSync } from "node:zlib";

import {
  RELAY_FETCHED_HEADER,
  RELAY_HEADER,
  type RelaySourceId,
  type RelayStatus,
} from "#lib/relay.ts";
import {
  MemoryRelayStore,
  type RelayEntry,
  type RelayPriority,
  type RelayStore,
} from "#lib/server/relay-store.ts";
import { USER_AGENT } from "#lib/server/sources/retry.ts";

/** 源ごとの決まり */
export interface RelaySource {
  /** 配信元の頭 (末尾は `/`)。後ろに要求の道を足す */
  upstream: string;
  /** 通してよい道 (頭の `/relay/<源>/` の後ろ) */
  path: RegExp;
  /** 通してよい問い合わせ (`?` の後ろ)。整えた問い合わせ (`""` は無し) か、断るなら null。無ければ問い合わせは断る */
  query?: (q: URLSearchParams, path: string) => string | null;
  /** 配信元が max-age を書かないときの期限 (秒) */
  ttl: number;
  /** 期限の下限 (秒)。配信元の max-age がこれより短くても、これより早くは取り直さない */
  minTtl?: number;
  /**
   * 期限が切れた後も、配信元が落ちている・混んでいる間は覚えたものを返してよい長さ (秒。stale-if-error)。
   * 古いと危ないもの (雨雲) は短く、地図の下地は長く (docs/design.md の 2.14 の源の表)
   */
  staleFor: number;
  /** 上限を超えたときに残す順 (`#lib/server/relay-store.ts` の `RelayPriority`)。道で分けるなら関数 */
  priority: RelayPriority | ((path: string) => RelayPriority);
  /** 覚えるか (既定は覚える)。覚えない源はブラウザにも覚えさせない */
  store?: boolean;
  /** `Range: bytes=a-b` を通すか (PMTiles)。`"required"` は Range の無い要求を断る (ファイルが大きく、まるごと取らせない) */
  range?: boolean | "required";
  /** 同時に配信元へ取りに行く数 (既定 6) */
  concurrency?: number;
}

/** 返す見出しに写すもの */
const PASS_HEADERS = [
  "content-type",
  "content-encoding",
  "content-range",
  "etag",
  "last-modified",
] as const;

/** Range で 1 回に取ってよい大きさ */
const MAX_RANGE_BYTES = 4 * 1024 * 1024;
/**
 * 1 つの応答の大きさの上限 (覚える上限と同じ。これより大きいものは覚えられないので、読まずに 502 にする)。
 * Content-Length がこれより大きければ読まずに断る。gzip を受けない要求に開いて返すときも、開いた後でこれまで
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** 置き換えられた ETag を、ファイルごとにいくつまで覚えるか (CDN の節で ETag が行き来しても、覚えた範囲を毎回捨てない) */
const RETIRED_ETAGS = 4;
/** 配信元が返らないときに諦めるまで */
const UPSTREAM_TIMEOUT_MS = 15_000;
/** 断られたときに待つ秒数の既定と上限 */
const COOLDOWN_DEFAULT_S = 60;
const COOLDOWN_MAX_S = 600;
/** 中継の応答に付ける CSP。何も読まず、何も動かさない */
const RELAY_CSP = "default-src 'none'; sandbox";
/** 404・410 を覚える期限の上限 (海の上の避難場所のタイルなど、無いものを何度も聞かない) */
const MISSING_TTL_S = 300;
/** 落ちた・返らない・5xx のあと、同じものを取り直すまで待つ長さ */
const FAILED_WAIT_MS = 15_000;
/** 続けてこの回数だけ落ちた・返らない・5xx なら、その源へ取りに行くのをしばらく控える (回路を開く) */
const BREAK_AFTER = 3;
/** 回路を開く長さ。最初は 15 秒で、続けて失敗するたびに倍、上限 2 分 */
const BREAK_FIRST_MS = 15_000;
const BREAK_MAX_MS = 120_000;

export interface RelayOptions {
  sources: Record<string, RelaySource>;
  fetch?: typeof fetch;
  now?: () => number;
  /** 覚える量の上限 (バイト) */
  maxBytes?: number;
  /** 期限の上限 (秒)。配信元がもっと長い max-age を書いても、これより長くは覚えない */
  maxTtl?: number;
  /** 置き場 (既定はプロセスのメモリ。`maxBytes` はそのときだけ使う) */
  store?: RelayStore;
}

/** 源ごとの、配信元との様子 */
interface Health {
  /** 続けて落ちた・返らない・5xx の数 */
  streak: number;
  /** 失敗が続き始めた時刻・断られた時刻 */
  since?: number;
  lastOkAt?: number;
  /** いまの失敗の間に、最後に古いものを返した時刻 */
  staleAt?: number;
  /** 回路を開いた回数 (取れたら 0 に戻す)。待つ長さはこれで倍々にする */
  opens: number;
  /** 回路を開いている終わり (ミリ秒) */
  breakUntil?: number;
  /** 回路を開いた後に、1 本だけ試している最中か (その間、ほかの要求は取りに行かない) */
  probing: boolean;
}

/** 環境変数の数 (正の数でなければ既定。書いてあるのに読めないときは、そう知らせる) */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (Number.isFinite(v) && v > 0) return v;
  console.warn(
    `[relay] ${name} は正の数ではないので、既定の ${fallback} を使います`,
  );
  return fallback;
}

/** `Cache-Control` の max-age (秒)。no-store・no-cache は 0 とみなす。書いていなければ undefined */
export function maxAgeOf(cc: string | null): number | undefined {
  if (!cc) return undefined;
  const v = cc.toLowerCase();
  if (/(^|,)\s*(no-store|no-cache)\b/.test(v)) return 0;
  const m = /(?:^|,)\s*max-age\s*=\s*(\d+)/.exec(v);
  return m ? Number(m[1]) : undefined;
}

/** `Retry-After` (秒か日付) を秒に。読めなければ既定 */
export function retryAfterSeconds(v: string | null, now: number): number {
  let s = COOLDOWN_DEFAULT_S;
  if (v) {
    if (/^\d+$/.test(v.trim())) s = Number(v.trim());
    else {
      const t = Date.parse(v);
      if (Number.isFinite(t)) s = Math.ceil((t - now) / 1000);
    }
  }
  return Math.min(Math.max(s, 1), COOLDOWN_MAX_S);
}

/** 道に、上へ戻る所・空の段・逃がし文字が無いか */
function safePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (/[\\%?#\s]/.test(path)) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/**
 * 本体を `max` バイトまで読む。Content-Length がそれより大きいか、読んでいる途中で超えたら、読むのをやめて null
 */
export async function readCapped(
  res: Response,
  max: number,
): Promise<Uint8Array | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    void res.body?.cancel();
    return null;
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** 小さなセマフォ (配信元のホストごとに同時に取りに行く数を絞る) */
class Gate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(f: () => Promise<T>): Promise<T> {
    // 空きが無ければ待つ。終わった人は、待っている人に自分の枠をそのまま渡す (数え直す間に横から入られない)
    if (this.running >= this.limit)
      await new Promise<void>((r) => this.waiting.push(r));
    else this.running++;
    try {
      return await f();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

const noStore = (status: number, text: string, extra: HeadersInit = {}) =>
  new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": RELAY_CSP,
      ...extra,
    },
  });

export class Relay {
  private readonly sources: Record<string, RelaySource>;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly maxTtl: number;
  private readonly store: RelayStore;
  /** 取りに行っている最中のもの (同じ鍵の要求をまとめる) */
  private readonly inflight = new Map<string, Flight>();
  /** 配信元のホストごとの、断られたので待つ終わり (ミリ秒)。同じホストの源 (地理院タイルと地理院地図Vector) は一緒に控える */
  private readonly blockedUntil = new Map<string, number>();
  /** 配信元のホストごとの、いまの控えの始まり (同じホストのほかの源の様子にも「いつから」を出す) */
  private readonly blockedSince = new Map<string, number>();
  /** 源の名前から配信元のホストへ (先に作る) */
  private readonly hosts = new Map<string, string>();
  /** ホストごとの、同時に取りに行く数 (そのホストの源のうち、いちばん小さいもの) */
  private readonly hostLimits = new Map<string, number>();
  private readonly health = new Map<string, Health>();
  /** 源の様子が変わったときに呼ぶもの (SSE の `event: relay`) */
  private readonly listeners = new Set<() => void>();
  /** 最後に知らせた様子の形 (変わったときだけ知らせる) */
  private lastShape = "";
  private readonly gates = new Map<string, Gate>();
  /** Range の源で、ファイルごとに最後に見た ETag (変わったら、そのファイルの覚えた分を捨てる)。Range の源のファイルの数だけで、小さい */
  private readonly fileEtags = new Map<string, string>();
  /** Range の源で、ファイルごとに置き換えられた ETag (新しいものから `RETIRED_ETAGS` まで) */
  private readonly retiredEtags = new Map<string, string[]>();
  /** 失敗した鍵と、取り直してよくなる時刻 (落ちている間に、要求のたびに配信元へ行かない) */
  private readonly failedUntil = new Map<string, number>();

  constructor(o: RelayOptions) {
    this.sources = o.sources;
    this.fetcher = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.maxTtl = o.maxTtl ?? 86_400;
    this.store =
      o.store ?? new MemoryRelayStore(o.maxBytes ?? 64 * 1024 * 1024, this.now);
    for (const [id, s] of Object.entries(this.sources)) {
      const host = new URL(s.upstream).host;
      this.hosts.set(id, host);
      this.hostLimits.set(
        host,
        Math.min(this.hostLimits.get(host) ?? Infinity, s.concurrency ?? 6),
      );
    }
  }

  /** いま覚えている量 (バイト・数)。試験と見積もり用 */
  async stats(): Promise<{ bytes: number; entries: number }> {
    return this.store.stats();
  }

  /** 源ごとの、配信元との様子 (受信の状態と地図の凡例に出す) */
  statuses(): RelayStatus[] {
    const now = this.now();
    const iso = (t: number) => new Date(t).toISOString();
    return Object.keys(this.sources).map((id) => {
      const h = this.health.get(id);
      const blocked = this.holdUntil(id);
      const state: RelayStatus["state"] =
        blocked > now
          ? "blocked"
          : h && h.streak > 0
            ? "failing"
            : h?.lastOkAt !== undefined
              ? "ok"
              : "idle";
      const trouble = state === "blocked" || state === "failing";
      const s: RelayStatus = { id: id as RelaySourceId, state };
      // 同じホストのほかの源が断られて控えているときは、その源は自分では失敗していないので、控えの始まりを使う
      const since =
        h?.since ??
        (state === "blocked"
          ? this.blockedSince.get(this.hostOf(id))
          : undefined);
      if (trouble && since !== undefined) s.since = iso(since);
      if (h?.lastOkAt !== undefined) s.lastOkAt = iso(h.lastOkAt);
      if (state === "blocked") s.retryAt = iso(blocked);
      if (trouble && h?.staleAt !== undefined) s.staleAt = iso(h.staleAt);
      return s;
    });
  }

  /** 源の様子 (状態・始まった時刻・古いものを返したか) が変わったら `fn` を呼ぶ。止める関数を返す */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private healthOf(id: string): Health {
    let h = this.health.get(id);
    if (!h) {
      h = { streak: 0, opens: 0, probing: false };
      this.health.set(id, h);
    }
    return h;
  }

  /** 取りに行くのを控える終わり (断られた `Retry-After` か、回路を開いている間。ミリ秒) */
  private holdUntil(id: string): number {
    return Math.max(
      this.blockedUntil.get(this.hostOf(id)) ?? 0,
      this.health.get(id)?.breakUntil ?? 0,
    );
  }

  /** 配信元が答えた (304・404 も、配信元が答えたので取れたうち)。回路も閉じる */
  private markOk(id: string): void {
    const h = this.healthOf(id);
    h.streak = 0;
    h.since = undefined;
    h.staleAt = undefined;
    h.opens = 0;
    h.breakUntil = undefined;
    h.probing = false;
    h.lastOkAt = this.now();
    this.changed();
  }

  /**
   * 落ちた・返らない・5xx。3 回続けば、その源へ取りに行くのを控える (回路を開く)。開いた後に試した 1 本も
   * 落ちたら、待つ長さを倍にして開き直す。同時に取りに行っていたものが一度に落ちても、開くのは 1 回に数える
   */
  private markDown(id: string): void {
    const now = this.now();
    const h = this.healthOf(id);
    h.streak++;
    h.since ??= now;
    if (h.probing || (h.opens === 0 && h.streak >= BREAK_AFTER)) {
      h.probing = false;
      const ms = Math.min(BREAK_FIRST_MS * 2 ** h.opens, BREAK_MAX_MS);
      h.opens++;
      h.breakUntil = now + ms;
      console.warn(
        `[relay] ${id}: 配信元から続けて取れないので、${Math.round(ms / 1000)} 秒は取りに行きません`,
      );
    }
    this.changed();
  }

  /** 配信元に断られた (429・503) */
  private markBlocked(id: string, until: number): void {
    // 同じホストのほかの源が受けた長い控えを、短い Retry-After で縮めない
    const host = this.hostOf(id);
    const now = this.now();
    const prev = this.blockedUntil.get(host) ?? 0;
    // 控えが切れた後の新しい控えなら、始まりを付け直す
    if (prev <= now) this.blockedSince.set(host, now);
    this.blockedUntil.set(host, Math.max(until, prev));
    const h = this.healthOf(id);
    h.since ??= now;
    h.probing = false;
    this.changed();
  }

  /** 覚えた古いものを返した */
  private markStale(id: string): void {
    const h = this.healthOf(id);
    const first = h.staleAt === undefined;
    h.staleAt = this.now();
    if (first) this.changed();
  }

  /** 様子の形が前に知らせたものと違えば知らせる */
  private changed(): void {
    const shape = JSON.stringify(
      this.statuses().map((s) => [
        s.id,
        s.state,
        s.since,
        s.staleAt !== undefined,
      ]),
    );
    if (shape === this.lastShape) return;
    this.lastShape = shape;
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        console.warn(`[relay] 様子を知らせられませんでした: ${e}`);
      }
    }
  }

  /** `/relay/<source>/<path>?<search>` への GET に答える */
  async handle(
    sourceId: string,
    path: string,
    search: URLSearchParams,
    reqHeaders: Headers,
    /** 見る人の要求の取り消し (地図を動かして要らなくなったタイルなど) */
    signal?: AbortSignal,
  ): Promise<Response> {
    const source = Object.hasOwn(this.sources, sourceId)
      ? this.sources[sourceId]
      : undefined;
    if (!source) return noStore(404, "中継しない源です");
    if (!safePath(path) || !source.path.test(path))
      return noStore(400, "中継しない道です");
    let query = "";
    if (source.query) {
      const q = source.query(search, path);
      if (q === null) return noStore(400, "中継しない問い合わせです");
      query = q;
    } else if ([...search.keys()].length > 0)
      return noStore(400, "問い合わせは付けられません");

    let range: string | undefined;
    const rawRange = reqHeaders.get("range");
    if (rawRange !== null) {
      const m = /^bytes=(\d{1,15})-(\d{1,15})$/.exec(rawRange.trim());
      if (!source.range || !m) return noStore(416, "Range は受けません");
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (b < a || b - a + 1 > MAX_RANGE_BYTES)
        return noStore(416, "Range が大きすぎます");
      range = `bytes=${a}-${b}`;
    } else if (source.range === "required")
      return noStore(416, "Range が要ります");

    const url = `${source.upstream}${path}${query ? `?${query}` : ""}`;
    const store = source.store !== false;
    const key = `${url}|${range ?? ""}`;
    const now = this.now();

    const cached = store ? await this.store.get(key) : undefined;
    if (cached && cached.freshUntil > now)
      return this.respond(cached, reqHeaders, "hit", store);
    /** 配信元から取れないときに、まだ返してよい古いものがあれば返す */
    const stale = (t: number) => {
      if (!cached || cached.staleUntil <= t) return undefined;
      this.markStale(sourceId);
      return this.respond(cached, reqHeaders, "stale", store);
    };

    // 覚えない源 (打った文字を運ぶ地名検索) は、失敗した鍵も残さない (源ごとの回路と Retry-After だけで控える)
    const failed = store ? (this.failedUntil.get(key) ?? 0) : 0;
    if (failed > 0 && failed <= now) this.failedUntil.delete(key);
    if (failed > now)
      return (
        stale(now) ??
        noStore(502, "配信元から取れませんでした", {
          "retry-after": String(Math.ceil((failed - now) / 1000)),
        })
      );

    const held = this.holdUntil(sourceId);
    const busy = (retry: number) =>
      stale(now) ??
      noStore(503, "配信元が混んでいるので、待っています", {
        [RELAY_HEADER]: "busy",
        "retry-after": String(retry),
      });
    if (held > now) return busy(Math.ceil((held - now) / 1000));

    if (signal?.aborted) return cancelled();
    let flight = store ? this.inflight.get(key) : undefined;
    // 回路を開いた後は、1 本だけ試す。試している間に来たほかの要求は取りに行かない (同じものの要求は、試している 1 本を待つ)
    const h = this.health.get(sourceId);
    let probe = false;
    if (!flight && h && h.opens > 0) {
      if (h.probing) return busy(Math.ceil(FAILED_WAIT_MS / 1000));
      h.probing = probe = true;
    }
    if (!flight) {
      const f: Flight = {
        promise: Promise.resolve(undefined as unknown as RelayEntry),
        waiters: 0,
        started: false,
        cancelled: false,
      };
      f.promise = this.gate(sourceId).run(() => {
        // 枠を待っている間に、待っていた人が全員取り消したなら、取りに行かない
        if (f.cancelled) throw new Cancelled();
        f.started = true;
        // 枠を待っている間に断られた (Retry-After) か回路が開いたなら、取りに行かない
        // (地図は 20〜40 枚を一度に読むので、待っていた分を控えの間に配信元へ流さない)
        const t = this.now();
        const hold = this.holdUntil(sourceId);
        if (hold > t) throw new Blocked(Math.ceil((hold - t) / 1000));
        const hh = this.health.get(sourceId);
        if (!probe && hh && hh.opens > 0)
          throw new Blocked(Math.ceil(FAILED_WAIT_MS / 1000));
        return this.fetchUpstream(sourceId, source, url, range, cached);
      });
      flight = f;
      if (store) {
        this.inflight.set(key, f);
        void f.promise.finally(() => this.inflight.delete(key)).catch(() => {});
      }
    }
    // 見る人が取り消したら、待つ人から外す。待つ人がいなくなり、まだ枠を待っている (取りに行き始めていない) なら、
    // 取りに行くのをやめる。始まった後は止めずに覚えさせる (取り消した人も、ほかの人のために覚えた後で答える)
    const fl = flight;
    fl.waiters++;
    // 全員が取り消した後、まだ枠を待っている間に同じものの要求が来たら、取りに行くのに戻す
    if (!fl.started) fl.cancelled = false;
    const onAbort = () => {
      if (--fl.waiters === 0 && !fl.started) fl.cancelled = true;
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let entry: RelayEntry;
    try {
      entry = await fl.promise;
    } catch (e) {
      // 配信元の不調でない失敗 (大きすぎる・取り消した) で試しが終わったときも、次の要求で試せるようにする
      if (probe && h) h.probing = false;
      if (e instanceof Cancelled) return cancelled();
      const t = this.now();
      if (!(e instanceof Blocked) && store) this.markFailed(key, t);
      const old = stale(t);
      if (old) return old;
      if (e instanceof Blocked)
        return noStore(503, "配信元が混んでいるので、待っています", {
          [RELAY_HEADER]: "busy",
          "retry-after": String(e.seconds),
        });
      return noStore(502, "配信元から取れませんでした");
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    this.failedUntil.delete(key);
    if (store) await this.put(key, entry, url, source, path);
    return this.respond(entry, reqHeaders, "miss", store);
  }

  /** 落ちた・返らない・5xx のあと、その鍵は FAILED_WAIT_MS の間は取りに行かない */
  private markFailed(key: string, now: number): void {
    if (this.failedUntil.size > 1000) this.failedUntil.clear();
    this.failedUntil.set(key, now + FAILED_WAIT_MS);
  }

  /** 配信元のホスト (同時に取りに行く数の枠と、断られたときの控えはホストごと)。表はコンストラクタで作る */
  private hostOf(id: string): string {
    return this.hosts.get(id) ?? id;
  }

  /** 同時に取りに行く数の枠。同じホストの源は 1 つの枠を分け合う (枠の大きさは、そのホストの源のうちいちばん小さいもの) */
  private gate(id: string): Gate {
    const host = this.hostOf(id);
    let g = this.gates.get(host);
    if (!g) {
      g = new Gate(this.hostLimits.get(host) ?? 6);
      this.gates.set(host, g);
    }
    return g;
  }

  private async fetchUpstream(
    sourceId: string,
    source: RelaySource,
    url: string,
    range: string | undefined,
    cached: RelayEntry | undefined,
  ): Promise<RelayEntry> {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      "accept-encoding": "gzip",
    };
    if (range) headers.range = range;
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    if (cached?.lastModified)
      headers["if-modified-since"] = cached.lastModified;
    let res: Response;
    try {
      res = await this.fetcher(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        // gzip のまま受けて、そのまま覚えて返す (Bun の fetch の決まり)
        decompress: false,
      } as RequestInit);
    } catch (e) {
      console.warn(
        `[relay] ${sourceId}: 配信元につながりません (${e instanceof Error ? e.name : "error"})`,
      );
      this.markDown(sourceId);
      throw e;
    }
    const now = this.now();
    if (res.status === 429 || res.status === 503) {
      const s = retryAfterSeconds(res.headers.get("retry-after"), now);
      this.markBlocked(sourceId, now + s * 1000);
      console.warn(
        `[relay] ${sourceId}: 配信元が ${res.status} を返したので、${s} 秒は取りに行きません`,
      );
      void res.body?.cancel();
      throw new Blocked(s);
    }
    // 5xx と、断る 4xx (401・403・451。CDN や WAF が断るときの形) は、配信元の不調として数える。
    // 覚えた古いものは消さずに返し、断られている間は要求のたびに配信元へ行かない
    if (res.status >= 500 || [401, 403, 451].includes(res.status)) {
      void res.body?.cancel();
      console.warn(`[relay] ${sourceId}: 配信元が ${res.status} を返しました`);
      this.markDown(sourceId);
      throw new Error(`upstream ${res.status}`);
    }
    const ttl = this.ttlOf(source, res);
    const staleMs = source.staleFor * 1000;
    if (res.status === 304 && cached) {
      void res.body?.cancel();
      this.markOk(sourceId);
      return {
        ...cached,
        freshUntil: now + ttl * 1000,
        staleUntil: now + ttl * 1000 + staleMs,
        fetchedAt: now,
      };
    }
    // 大きすぎるものは断る (中継するのはタイルや表で、ふつうは数百 KB まで)。Content-Length が無くても、読みながら数えて切る。
    // 見出しだけ返して本体の途中で切れた・返らなくなったものは、落ちたのと同じに数える
    let body: Uint8Array | null;
    try {
      body = await readCapped(res, MAX_BODY_BYTES);
    } catch (e) {
      console.warn(
        `[relay] ${sourceId}: 配信元の本体を読み切れません (${e instanceof Error ? e.name : "error"})`,
      );
      this.markDown(sourceId);
      throw e;
    }
    if (!body) {
      console.warn(`[relay] ${sourceId}: 配信元の応答が大きすぎます`);
      throw new Error("too large");
    }
    this.markOk(sourceId);
    const out: Record<string, string> = {};
    for (const h of PASS_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) out[h] = v;
    }
    const ok = res.status === 200 || res.status === 206;
    const missing = res.status === 404 || res.status === 410;
    // 404・410 は短く覚え、ほかの 4xx は覚えない (期限 0)
    const keep = ok ? ttl : missing ? Math.min(ttl, MISSING_TTL_S) : 0;
    return {
      status: res.status,
      body,
      headers: out,
      freshUntil: now + keep * 1000,
      staleUntil: ok ? now + keep * 1000 + staleMs : now + keep * 1000,
      fetchedAt: now,
      etag: ok ? (out.etag ?? undefined) : undefined,
      lastModified: ok ? (out["last-modified"] ?? undefined) : undefined,
    };
  }

  private ttlOf(source: RelaySource, res: Response): number {
    const ma = maxAgeOf(res.headers.get("cache-control"));
    // CDN が覚えていた分 (`Age`) は引く (CDN とここで期限を重ねて、古いものを長く返さない)
    const age = Number(res.headers.get("age") ?? 0);
    const left =
      ma === undefined
        ? source.ttl
        : ma - (Number.isFinite(age) && age > 0 ? age : 0);
    const t = Math.max(left, source.minTtl ?? 0);
    return Math.min(t, this.maxTtl);
  }

  private async put(
    key: string,
    e: RelayEntry,
    url: string,
    source: RelaySource,
    path: string,
  ): Promise<void> {
    if (e.freshUntil <= this.now() && e.status !== 200 && e.status !== 206)
      return this.store.delete(key);
    if (source.range && e.etag) {
      // 置き換えられた版の範囲 (CDN の節で ETag が行き来する・差し替えの前に出た遅い応答) は、ブラウザへは返すが
      // 覚えず、いまの版の範囲も捨てない (行き来のたびに覚えた範囲を全部捨てて、配信元へ取りに行き直さない)
      const retired = this.retiredEtags.get(url) ?? [];
      if (retired.includes(e.etag)) return;
      // ファイルが差し替わったら、前の版の範囲を混ぜて返さない (PMTiles は ETag が揃わないと読み直す)
      const before = this.fileEtags.get(url);
      if (before !== undefined && before !== e.etag) {
        this.retiredEtags.set(
          url,
          [before, ...retired].slice(0, RETIRED_ETAGS),
        );
        await this.store.deletePrefix(`${url}|`);
      }
      this.fileEtags.set(url, e.etag);
    }
    const priority =
      typeof source.priority === "function"
        ? source.priority(path)
        : source.priority;
    await this.store.set(key, e, priority);
  }

  private respond(
    e: RelayEntry,
    reqHeaders: Headers,
    how: "hit" | "miss" | "stale",
    store: boolean,
  ): Response {
    const now = this.now();
    const headers = new Headers(e.headers);
    headers.set(RELAY_HEADER, how);
    headers.set(RELAY_FETCHED_HEADER, new Date(e.fetchedAt).toISOString());
    // 配信元の中身を sonae と同じオリジンで返すので、HTML (火山カメラのページ) が開かれても script を動かさず、
    // 型を推し量らせない (どの源でも、画面は fetch か <img> で読むだけなので困らない)
    headers.set("x-content-type-options", "nosniff");
    headers.set("content-security-policy", RELAY_CSP);
    // ブラウザには、サーバーが覚えている残りの間だけ覚えさせる。古いものを返したときと、覚えない源では覚えさせない
    const left = Math.floor((e.freshUntil - now) / 1000);
    headers.set(
      "cache-control",
      store && how !== "stale" && left > 0
        ? `private, max-age=${left}`
        : "no-store",
    );
    let body: Uint8Array | null = e.body;
    if (e.headers["content-encoding"] === "gzip") {
      headers.set("vary", "accept-encoding");
      if (!/\bgzip\b/.test(reqHeaders.get("accept-encoding") ?? "")) {
        try {
          // 開いた後の大きさも上限まで (小さな gzip が大きく膨らむものを、要求のたびに開かない)
          body = gunzipSync(e.body, { maxOutputLength: MAX_BODY_BYTES });
        } catch {
          return noStore(502, "配信元の gzip を開けませんでした");
        }
        headers.delete("content-encoding");
      }
    }
    const inm = reqHeaders.get("if-none-match");
    if (
      e.status === 200 &&
      e.etag !== undefined &&
      inm !== null &&
      inm.split(",").some((t) => weak(t) === weak(e.etag ?? ""))
    ) {
      headers.delete("content-encoding");
      return new Response(null, { status: 304, headers });
    }
    return new Response(body as Uint8Array<ArrayBuffer>, {
      status: e.status,
      headers,
    });
  }
}

/** 弱い ETag (`W/"…"`) も同じものとして比べる (If-None-Match は弱い比較) */
const weak = (t: string) => t.trim().replace(/^W\//, "");

/** 配信元に断られて待っている間 */
class Blocked extends Error {
  constructor(readonly seconds: number) {
    super("blocked");
  }
}

/** 待っていた人が全員取り消したので、取りに行かなかった (配信元の不調ではない) */
class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/** 取りに行っている最中のもの。待っている人の数と、取りに行き始めたか・取り消したか */
interface Flight {
  promise: Promise<RelayEntry>;
  waiters: number;
  started: boolean;
  cancelled: boolean;
}

/** 取り消した要求への応答 (受け取る人はいないが、何かは返す) */
const cancelled = () => noStore(503, "要求が取り消されました");

// ---- 源の表 ----

/** 段の名前 (英数・下線・点・ハイフン) */
const SEG = "[A-Za-z0-9_.-]+";

/**
 * 中継する源。鍵は `/relay/<源>` の名前 (`#lib/relay.ts` の `RelaySourceId`)。
 * どれも docs/design.md の 1 章の「地図と声」の規約を読んで、サーバーが取って家の中で使い回してよいと決めたもの
 */
export const RELAY_SOURCES = {
  // 気象庁ホームページの雨雲・今後の雨・雷・竜巻・線状降水帯・キキクル・今後の雪のタイルと時刻の表 (docs/map.md)。
  // 時刻の表は max-age=60、タイルは max-age=86400 (時刻ごとに URL が替わる)
  jmatile: {
    upstream: "https://www.jma.go.jp/bosai/jmatile/data/",
    path: new RegExp(
      `^(?:nowc|rasrf|risk|map|snow)/(?:${SEG}/)*${SEG}\\.(?:png|pbf|json|geojson)$`,
    ),
    ttl: 60,
    minTtl: 30,
    // 古い雨雲・危険度はいまのものと取り違えると危ない。画面はいつの観測かを出し、古ければそう書くが、キキクルの予測の
    // いちばん先 (洪水の 3 時間) を過ぎたものは、もう何も言えないので返さない
    staleFor: 3 * 3600,
    priority: 2,
  },
  // 地理院タイル: 写真・活断層図・指定緊急避難場所と指定避難所 (docs/map.md)。max-age は無い。
  // 一覧は「リアルタイムに読み込んで利用する場合」は出典だけで申請が要らないとする。見る人の要求のたびに取り、
  // 覚えるのは期限の 1 日までなので、その使い方に収まると読んだ (docs/design.md の 2.14)
  gsi: {
    upstream: "https://cyberjapandata.gsi.go.jp/xyz/",
    path: /^(?:seamlessphoto\/\d{1,2}\/\d{1,6}\/\d{1,6}\.jpg|afm\/\d{1,2}\/\d{1,6}\/\d{1,6}\.png|(?:skhb0[1-8]|sih|sfh)\/10\/\d{1,4}\/\d{1,4}\.geojson)$/,
    ttl: 86_400,
    // 配信元が落ちている間も、返すのは期限の後 1 日まで (前からの読みのまま。「リアルタイムに読み込んで」の範囲に収める)
    staleFor: 86_400,
    // 避難場所は災害時に要るので残し、写真と活断層図は先に捨てる
    priority: (path) => (/^(?:skhb|sih|sfh)/.test(path) ? 1 : 0),
  },
  // 地理院地図Vector の PMTiles (約 16.9GB の 1 ファイル)。範囲で読むだけにし、まるごとは取らせない
  "gsi-vector": {
    upstream: "https://cyberjapandata.gsi.go.jp/xyz/",
    path: /^optimal_bvmap-v1\/optimal_bvmap-v1\.pmtiles$/,
    ttl: 86_400,
    // 下地。地理院タイルと同じく、落ちている間も 1 日まで
    staleFor: 86_400,
    priority: 1,
    range: "required",
  },
  // 重ねるハザードマップのタイル (max-age 3 日) と、公式の凡例の画像。オープンデータは「URL からリアルタイムに
  // 読み込み」アプリで使ってよいとする
  disaportal: {
    upstream: "https://disaportaldata.gsi.go.jp/raster/",
    path: /^[0-9a-z_]{1,64}\/\d{1,2}\/\d{1,6}\/\d{1,6}\.png$/,
    ttl: 86_400,
    staleFor: 86_400,
    priority: 1,
  },
  "disaportal-legend": {
    upstream: "https://disaportal.gsi.go.jp/hazardmap/copyright/img/",
    path: /^[0-9a-z_]{1,64}\.png$/,
    ttl: 86_400,
    staleFor: 86_400,
    priority: 1,
  },
  // 気象庁ホームページの火山の監視カメラ。カメラのページ (`volcam.php?VC=<5 桁>`。いちばん新しい画像の名前を読む) と、
  // 撮った時刻の名前の画像。どちらも max-age 600 (docs/map.md の「火山の監視カメラ」)
  volcam: {
    upstream: "https://www.data.jma.go.jp/vois/data/obs/",
    path: /^(?:volcam\/volcam\.php|camera\/\d{3}_[0-9A-Fa-f]{8}\/\d{14}\.jpg)$/,
    query: (q, path) => {
      const keys = [...q.keys()];
      if (!path.endsWith(".php")) return keys.length === 0 ? "" : null;
      const vc = q.get("VC") ?? "";
      return keys.length === 1 && /^\d{5}$/.test(vc) ? `VC=${vc}` : null;
    },
    ttl: 600,
    // 画像の名前が撮った時刻なので、画面は何時の画像かを出せる。噴火の様子は時間で変わるので、6 時間まで
    staleFor: 6 * 3600,
    priority: 2,
  },
  // 国土地理院の地名検索 API (住所検索)。打った文字を運ぶので、覚えず (`store: false`)、ブラウザにも覚えさせない。
  // 通すのは `q` (100 文字まで) だけ。中継はどの要求もログに道や問い合わせを出さない (docs/map.md の「場所の検索」)
  "gsi-search": {
    upstream: "https://msearch.gsi.go.jp/address-search/",
    path: /^AddressSearch$/,
    query: (q) => {
      const v = q.get("q") ?? "";
      return [...q.keys()].length === 1 && v.length > 0 && v.length <= 100
        ? `q=${encodeURIComponent(v)}`
        : null;
    },
    ttl: 0,
    store: false,
    staleFor: 0,
    priority: 0,
    concurrency: 2,
  },
  // NASA GIBS の Blue Marble (陰影つき。max-age 3 日)。引いたときの下地
  gibs: {
    upstream:
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief/default/GoogleMapsCompatible_Level8/",
    path: /^\d\/\d{1,3}\/\d{1,3}\.jpeg$/,
    ttl: 86_400,
    // 絵が変わらない下地で、使い方の制限も無い (CC0) ので長く。あると助かる層なので、上限を超えたら先に捨てる
    staleFor: 7 * 86_400,
    priority: 0,
  },
} satisfies Record<string, RelaySource>;

let shared: Relay | undefined;

/** プロセスで 1 つの中継 (上限は `SONAE_RELAY_CACHE_MB`・`SONAE_RELAY_MAX_TTL`) */
export function relay(): Relay {
  shared ??= new Relay({
    sources: RELAY_SOURCES,
    maxBytes: envNumber("SONAE_RELAY_CACHE_MB", 64) * 1024 * 1024,
    maxTtl: envNumber("SONAE_RELAY_MAX_TTL", 86_400),
  });
  return shared;
}
