/**
 * 張り直しの間隔。サーバーの情報源 (`server/sources/retry.ts`) と、画面の SSE (`live.svelte.ts`) で同じものを使う。
 * 指数のバックオフに揺らぎを足す (既定は 1 秒から倍々、上限 30 秒、full jitter)。
 * どこからでも読むので、Bun や DOM にしか無いものは使わない。
 */
export class Backoff {
  private attempt = 0;
  constructor(
    private readonly min = 1_000,
    private readonly max = 30_000,
    private readonly random: () => number = Math.random,
  ) {}
  /** 次に待つ時間 (ミリ秒) */
  next(): number {
    const cap = Math.min(this.max, this.min * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    return Math.round(this.random() * cap);
  }
  reset(): void {
    this.attempt = 0;
  }
}
