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
 * - 配信元が 429・503 を返したら、`Retry-After` (無ければ 60 秒、上限 10 分) の間はその源へ取りに行かない
 * - 源ごとに同時に取りに行く数を絞る
 * - User-Agent に sonae と分かる名前を付ける。Cookie・Referer・使う人の IP は送らない
 *
 * 失敗したとき: 古くても覚えたものがあれば返す (`x-relay: stale`)。無ければ 502 (配信元が落ちた・返らない。同じものは 15 秒
 * 取りに行かない) か 503 (`Retry-After` つき。配信元に断られて待っている間)。どちらも覚えず、ブラウザにも覚えさせない。
 *
 * 中身は変えない (色も値も。docs/design.md の 5 章)。配信元が gzip で返したものは gzip のまま覚えて返す。
 * 覚えるのはプロセスのメモリだけで、上限 (`SONAE_RELAY_CACHE_MB`) を超えたら長く使っていないものから捨てる。
 * 起動し直すと空になる。地名検索のように覚えない源 (`store: false`) は、覚えず、ログにも中身を出さない。
 */

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
  /** 覚えるか (既定は覚える)。覚えない源はブラウザにも覚えさせない */
  store?: boolean;
  /** `Range: bytes=a-b` を通すか (PMTiles)。`"required"` は Range の無い要求を断る (ファイルが大きく、まるごと取らせない) */
  range?: boolean | "required";
  /** 同時に配信元へ取りに行く数 (既定 6) */
  concurrency?: number;
}

/** 覚えた 1 つ */
interface Entry {
  status: number;
  body: Uint8Array;
  headers: Record<string, string>;
  /** これより前は取り直さない (ミリ秒) */
  freshUntil: number;
  /** 配信元が落ちたときに返してよい最後 (ミリ秒) */
  staleUntil: number;
  etag?: string;
  lastModified?: string;
}

/** 返す見出しに写すもの */
const PASS_HEADERS = [
  "content-type",
  "content-encoding",
  "content-range",
  "etag",
  "last-modified",
] as const;

/** 1 つの大きさの上限。これより大きいものは覚えずに返す */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
/** Range で 1 回に取ってよい大きさ */
const MAX_RANGE_BYTES = 4 * 1024 * 1024;
/** 1 つの応答の大きさの上限。Content-Length がこれより大きければ読まずに断る */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** 配信元が返らないときに諦めるまで */
const UPSTREAM_TIMEOUT_MS = 15_000;
/** 断られたときに待つ秒数の既定と上限 */
const COOLDOWN_DEFAULT_S = 60;
const COOLDOWN_MAX_S = 600;
/** 404・410 を覚える期限の上限 (海の上の避難場所のタイルなど、無いものを何度も聞かない) */
const MISSING_TTL_S = 300;
/** 落ちた・返らない・5xx のあと、同じものを取り直すまで待つ長さ */
const FAILED_WAIT_MS = 15_000;
/** 期限が切れた後も、配信元が落ちていれば返してよい長さ */
const STALE_FOR_MS = 24 * 3600_000;

export interface RelayOptions {
  sources: Record<string, RelaySource>;
  fetch?: typeof fetch;
  now?: () => number;
  /** 覚える量の上限 (バイト) */
  maxBytes?: number;
  /** 期限の上限 (秒)。配信元がもっと長い max-age を書いても、これより長くは覚えない */
  maxTtl?: number;
}

/** 環境変数の数 (正の数でなければ既定) */
function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
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

/** 小さなセマフォ (源ごとに同時に取りに行く数を絞る) */
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
      ...extra,
    },
  });

export class Relay {
  private readonly sources: Record<string, RelaySource>;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly maxTtl: number;
  /** 覚えたもの (挿した順が古い順。使ったら後ろへ回す) */
  private readonly cache = new Map<string, Entry>();
  private bytes = 0;
  /** 取りに行っている最中のもの (同じ鍵の要求をまとめる) */
  private readonly inflight = new Map<string, Promise<Entry>>();
  /** 源ごとの、断られて待つ終わり (ミリ秒) */
  private readonly blockedUntil = new Map<string, number>();
  private readonly gates = new Map<string, Gate>();
  /** Range の源で、ファイルごとに最後に見た ETag (変わったら、そのファイルの覚えた分を捨てる)。Range の源のファイルの数だけで、小さい */
  private readonly fileEtags = new Map<string, string>();
  /** 失敗した鍵と、取り直してよくなる時刻 (落ちている間に、要求のたびに配信元へ行かない) */
  private readonly failedUntil = new Map<string, number>();

  constructor(o: RelayOptions) {
    this.sources = o.sources;
    this.fetcher = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.maxBytes = o.maxBytes ?? 64 * 1024 * 1024;
    this.maxTtl = o.maxTtl ?? 86_400;
  }

  /** いま覚えている量 (バイト・数)。試験と見積もり用 */
  stats(): { bytes: number; entries: number } {
    return { bytes: this.bytes, entries: this.cache.size };
  }

  /** `/relay/<source>/<path>?<search>` への GET に答える */
  async handle(
    sourceId: string,
    path: string,
    search: URLSearchParams,
    reqHeaders: Headers,
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
      const m = /^bytes=(\d+)-(\d+)$/.exec(rawRange.trim());
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

    const cached = store ? this.cache.get(key) : undefined;
    if (cached && cached.freshUntil > now) {
      this.touch(key, cached);
      return this.respond(cached, reqHeaders, "hit", store);
    }

    const failed = this.failedUntil.get(key) ?? 0;
    if (failed > now) {
      if (cached && cached.staleUntil > now)
        return this.respond(cached, reqHeaders, "stale", store);
      return noStore(502, "配信元から取れませんでした", {
        "retry-after": String(Math.ceil((failed - now) / 1000)),
      });
    }

    const blocked = this.blockedUntil.get(sourceId) ?? 0;
    if (blocked > now) {
      if (cached && cached.staleUntil > now)
        return this.respond(cached, reqHeaders, "stale", store);
      return noStore(503, "配信元に断られたので、待っています", {
        "retry-after": String(Math.ceil((blocked - now) / 1000)),
      });
    }

    let p = store ? this.inflight.get(key) : undefined;
    if (!p) {
      p = this.gate(sourceId, source).run(() =>
        this.fetchUpstream(sourceId, source, url, range, cached),
      );
      if (store) {
        this.inflight.set(key, p);
        void p.finally(() => this.inflight.delete(key)).catch(() => {});
      }
    }
    try {
      const entry = await p;
      this.failedUntil.delete(key);
      if (store) this.put(key, entry, url, source);
      return this.respond(entry, reqHeaders, "miss", store);
    } catch (e) {
      const t = this.now();
      if (!(e instanceof Blocked)) this.markFailed(key, t);
      if (cached && cached.staleUntil > t)
        return this.respond(cached, reqHeaders, "stale", store);
      if (e instanceof Blocked)
        return noStore(503, "配信元に断られたので、待っています", {
          "retry-after": String(e.seconds),
        });
      return noStore(502, "配信元から取れませんでした");
    }
  }

  /** 落ちた・返らない・5xx のあと、その鍵は FAILED_WAIT_MS の間は取りに行かない */
  private markFailed(key: string, now: number): void {
    if (this.failedUntil.size > 1000) this.failedUntil.clear();
    this.failedUntil.set(key, now + FAILED_WAIT_MS);
  }

  private gate(id: string, source: RelaySource): Gate {
    let g = this.gates.get(id);
    if (!g) {
      g = new Gate(source.concurrency ?? 6);
      this.gates.set(id, g);
    }
    return g;
  }

  private async fetchUpstream(
    sourceId: string,
    source: RelaySource,
    url: string,
    range: string | undefined,
    cached: Entry | undefined,
  ): Promise<Entry> {
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
      throw e;
    }
    const now = this.now();
    if (res.status === 429 || res.status === 503) {
      const s = retryAfterSeconds(res.headers.get("retry-after"), now);
      this.blockedUntil.set(sourceId, now + s * 1000);
      console.warn(
        `[relay] ${sourceId}: 配信元が ${res.status} を返したので、${s} 秒は取りに行きません`,
      );
      void res.body?.cancel();
      throw new Blocked(s);
    }
    const ttl = this.ttlOf(source, res);
    if (res.status === 304 && cached) {
      void res.body?.cancel();
      return {
        ...cached,
        freshUntil: now + ttl * 1000,
        staleUntil: now + ttl * 1000 + STALE_FOR_MS,
      };
    }
    if (res.status >= 500) {
      void res.body?.cancel();
      console.warn(`[relay] ${sourceId}: 配信元が ${res.status} を返しました`);
      throw new Error(`upstream ${res.status}`);
    }
    // 大きすぎるものは断る (中継するのはタイルや表で、ふつうは数百 KB まで)。Content-Length が無くても、読みながら数えて切る
    const body = await readCapped(res, MAX_BODY_BYTES);
    if (!body) {
      console.warn(`[relay] ${sourceId}: 配信元の応答が大きすぎます`);
      throw new Error("too large");
    }
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
      staleUntil: ok ? now + keep * 1000 + STALE_FOR_MS : now + keep * 1000,
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

  private put(key: string, e: Entry, url: string, source: RelaySource): void {
    if (e.freshUntil <= this.now() && e.status !== 200 && e.status !== 206)
      return this.drop(key);
    if (e.body.byteLength > MAX_ENTRY_BYTES) return this.drop(key);
    if (source.range && e.etag) {
      // ファイルが差し替わったら、前の版の範囲を混ぜて返さない (PMTiles は ETag が揃わないと読み直す)
      const before = this.fileEtags.get(url);
      if (before !== undefined && before !== e.etag) {
        for (const k of this.cache.keys())
          if (k.startsWith(`${url}|`)) this.drop(k);
      }
      this.fileEtags.set(url, e.etag);
    }
    this.drop(key);
    this.cache.set(key, e);
    this.bytes += e.body.byteLength;
    for (const [k, v] of this.cache) {
      if (this.bytes <= this.maxBytes) break;
      this.cache.delete(k);
      this.bytes -= v.body.byteLength;
    }
  }

  private drop(key: string): void {
    const old = this.cache.get(key);
    if (!old) return;
    this.cache.delete(key);
    this.bytes -= old.body.byteLength;
  }

  private touch(key: string, e: Entry): void {
    this.cache.delete(key);
    this.cache.set(key, e);
  }

  private respond(
    e: Entry,
    reqHeaders: Headers,
    how: "hit" | "miss" | "stale",
    store: boolean,
  ): Response {
    const now = this.now();
    const headers = new Headers(e.headers);
    headers.set("x-relay", how);
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
          body = Bun.gunzipSync(e.body as Uint8Array<ArrayBuffer>);
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

// ---- 源の表 ----

/** 段の名前 (英数・下線・点・ハイフン) */
const SEG = "[A-Za-z0-9_.-]+";

/**
 * 中継する源。鍵は `/relay/<源>` の名前 (`#lib/relay.ts` の `RelaySourceId`)。
 * どれも docs/design.md の 1 章の「地図と声」の規約を読んで、サーバーが取って家の中で使い回してよいと決めたもの
 */
export const RELAY_SOURCES = {
  // 気象庁ホームページの雨雲・今後の雨・雷・竜巻・線状降水帯・キキクルのタイルと時刻の表 (docs/map.md)。
  // 時刻の表は max-age=60、タイルは max-age=86400 (時刻ごとに URL が替わる)
  jmatile: {
    upstream: "https://www.jma.go.jp/bosai/jmatile/data/",
    path: new RegExp(
      `^(?:nowc|rasrf|risk|map)/(?:${SEG}/)*${SEG}\\.(?:png|pbf|json|geojson)$`,
    ),
    ttl: 60,
    minTtl: 30,
  },
  // 地理院タイル: 写真・活断層図・指定緊急避難場所と指定避難所 (docs/map.md)。max-age は無い。
  // 一覧は「リアルタイムに読み込んで利用する場合」は出典だけで申請が要らないとする。見る人の要求のたびに取り、
  // 覚えるのは期限の 1 日までなので、その使い方に収まると読んだ (docs/design.md の 2.14)
  gsi: {
    upstream: "https://cyberjapandata.gsi.go.jp/xyz/",
    path: /^(?:seamlessphoto\/\d{1,2}\/\d{1,6}\/\d{1,6}\.jpg|afm\/\d{1,2}\/\d{1,6}\/\d{1,6}\.png|(?:skhb0[1-8]|sih|sfh)\/10\/\d{1,4}\/\d{1,4}\.geojson)$/,
    ttl: 86_400,
  },
  // 地理院地図Vector の PMTiles (約 16.9GB の 1 ファイル)。範囲で読むだけにし、まるごとは取らせない
  "gsi-vector": {
    upstream: "https://cyberjapandata.gsi.go.jp/xyz/",
    path: /^optimal_bvmap-v1\/optimal_bvmap-v1\.pmtiles$/,
    ttl: 86_400,
    range: "required",
  },
  // 重ねるハザードマップのタイル (max-age 3 日) と、公式の凡例の画像。オープンデータは「URL からリアルタイムに
  // 読み込み」アプリで使ってよいとする
  disaportal: {
    upstream: "https://disaportaldata.gsi.go.jp/raster/",
    path: /^[0-9a-z_]{1,64}\/\d{1,2}\/\d{1,6}\/\d{1,6}\.png$/,
    ttl: 86_400,
  },
  "disaportal-legend": {
    upstream: "https://disaportal.gsi.go.jp/hazardmap/copyright/img/",
    path: /^[0-9a-z_]{1,64}\.png$/,
    ttl: 86_400,
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
  },
  // NASA GIBS の Blue Marble (陰影つき。max-age 3 日)。引いたときの下地
  gibs: {
    upstream:
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief/default/GoogleMapsCompatible_Level8/",
    path: /^\d\/\d{1,3}\/\d{1,3}\.jpeg$/,
    ttl: 86_400,
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
