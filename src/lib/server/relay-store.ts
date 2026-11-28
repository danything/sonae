/**
 * 中継 (`#lib/server/relay.ts`) が覚えたものの置き場 (docs/design.md の 2.14 の「置き場と上限」)。
 *
 * 置き場は差し替えられる形にしておく (`RelayStore`)。いまはプロセスのメモリ (`MemoryRelayStore`) だけで、
 * 公開のサービスで台数を増やすときは、同じ形で外の置き場 (Redis・ディスク・CDN の前の置き場など) に替える。
 * そのため、どの操作も Promise を返してよい形にしてある。
 *
 * メモリの置き場の追い出しの順 (上限を超えたとき):
 * 1. 配信元が落ちていても返してよい期限 (`staleUntil`) を過ぎたもの (もう返さない)
 * 2. 残りは、長く使っていないものから。ただし災害時に要る層 (`priority` が高い) は、使った時刻に猶予を足して比べ、
 *    下地の写真などより後に捨てる (猶予を過ぎるほど使っていなければ、高い層でも先に捨てる。時刻ごとに URL が替わる
 *    雨雲のタイルが溜まって、いま見ている地図の下地を押し出さないように)
 */

/** 覚えた 1 つ */
export interface RelayEntry {
  status: number;
  body: Uint8Array;
  headers: Record<string, string>;
  /** これより前は取り直さない (ミリ秒) */
  freshUntil: number;
  /** 配信元が落ちたときに返してよい最後 (ミリ秒) */
  staleUntil: number;
  /** 配信元から最後に取れた (304 で確かめた時も含む) 時刻 (ミリ秒) */
  fetchedAt: number;
  etag?: string;
  lastModified?: string;
}

/**
 * 残す順の段。高いほど後まで残す。
 * - 2: 災害の最中に見る層 (気象庁のタイルと時刻の表・火山カメラ)
 * - 1: 地図を読むのに要る層 (地理院地図Vector の下地・ハザードマップ・避難場所)
 * - 0: あると助かる層 (写真・活断層図・Blue Marble)
 */
export type RelayPriority = 0 | 1 | 2;

/** 段ごとの猶予 (ミリ秒)。使った時刻にこれを足して、長く使っていない順を比べる */
export const PRIORITY_GRACE_MS: Record<RelayPriority, number> = {
  0: 0,
  1: 30 * 60_000,
  2: 2 * 3600_000,
};

type MaybePromise<T> = T | Promise<T>;

/** 中継の置き場 */
export interface RelayStore {
  get(key: string): MaybePromise<RelayEntry | undefined>;
  /** 置く (同じ鍵の前のものは置き換える)。上限を超えたら追い出す */
  set(
    key: string,
    entry: RelayEntry,
    priority: RelayPriority,
  ): MaybePromise<void>;
  delete(key: string): MaybePromise<void>;
  /** 鍵が `prefix` で始まるものを全部捨てる (PMTiles のファイルが差し替わったとき) */
  deletePrefix(prefix: string): MaybePromise<void>;
  /** いま覚えている量。試験と見積もり用 */
  stats(): MaybePromise<{ bytes: number; entries: number }>;
}

interface Slot {
  entry: RelayEntry;
  usedAt: number;
}

/** プロセスのメモリの置き場。段ごとに、使った順の Map を持つ (Map は足した順に並ぶ。使ったら後ろへ回す) */
export class MemoryRelayStore implements RelayStore {
  private readonly tiers: [
    Map<string, Slot>,
    Map<string, Slot>,
    Map<string, Slot>,
  ] = [new Map(), new Map(), new Map()];
  private bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly now: () => number = Date.now,
    /** 1 つの大きさの上限。これより大きいものは覚えない */
    private readonly maxEntryBytes = 4 * 1024 * 1024,
  ) {}

  get(key: string): RelayEntry | undefined {
    for (const tier of this.tiers) {
      const s = tier.get(key);
      if (!s) continue;
      tier.delete(key);
      s.usedAt = this.now();
      tier.set(key, s);
      return s.entry;
    }
    return undefined;
  }

  set(key: string, entry: RelayEntry, priority: RelayPriority): void {
    this.delete(key);
    if (entry.body.byteLength > this.maxEntryBytes) return;
    this.tiers[priority].set(key, { entry, usedAt: this.now() });
    this.bytes += entry.body.byteLength;
    if (this.bytes > this.maxBytes) this.evict();
  }

  delete(key: string): void {
    for (const tier of this.tiers) {
      const s = tier.get(key);
      if (!s) continue;
      tier.delete(key);
      this.bytes -= s.entry.body.byteLength;
      return;
    }
  }

  deletePrefix(prefix: string): void {
    for (const tier of this.tiers)
      for (const [k, s] of tier)
        if (k.startsWith(prefix)) {
          tier.delete(k);
          this.bytes -= s.entry.body.byteLength;
        }
  }

  stats(): { bytes: number; entries: number } {
    return {
      bytes: this.bytes,
      entries: this.tiers.reduce((n, t) => n + t.size, 0),
    };
  }

  private evict(): void {
    // 1. もう返さないもの (配信元が落ちていても返してよい期限を過ぎたもの) から
    const now = this.now();
    for (const tier of this.tiers)
      for (const [k, s] of tier)
        if (s.entry.staleUntil <= now) {
          tier.delete(k);
          this.bytes -= s.entry.body.byteLength;
        }
    // 2. 段ごとのいちばん長く使っていないものを、猶予を足した時刻で比べて捨てる
    while (this.bytes > this.maxBytes) {
      let pick:
        { tier: Map<string, Slot>; key: string; slot: Slot } | undefined;
      let oldest = Infinity;
      this.tiers.forEach((tier, p) => {
        const head = tier.entries().next();
        if (head.done) return;
        const [key, slot] = head.value;
        const t = slot.usedAt + PRIORITY_GRACE_MS[p as RelayPriority];
        if (t < oldest) {
          oldest = t;
          pick = { tier, key, slot };
        }
      });
      if (!pick) break;
      pick.tier.delete(pick.key);
      this.bytes -= pick.slot.entry.body.byteLength;
    }
  }
}
