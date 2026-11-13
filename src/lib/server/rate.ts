/**
 * 回数の制限 (人ごと、メモリに持つ)。窓の長さの間に `max` 回まで。
 * 1 プロセス (レプリカ 1 つ) なのでメモリで足りる。再起動すると数え直す。
 */
export class RateLimit {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 1 回使う。使えたら 0、超えていたら使えるようになるまでの秒数 */
  take(key: string): number {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter(
      (t) => now - t < this.windowMs,
    );
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
    }
    recent.push(now);
    this.hits.set(key, recent);
    // 使われなくなった人の記録を残し続けない
    if (this.hits.size > 1000) {
      for (const [k, v] of this.hits)
        if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
    return 0;
  }
}

/**
 * 試しの通知 (`POST /api/push/test`) は 1 人 10 分に 5 回まで。配信サービスに続けて送らせない
 * (押し間違いや、画面の不具合で繰り返したときの歯止め)
 */
export const pushTestLimit = new RateLimit(5, 10 * 60_000);
