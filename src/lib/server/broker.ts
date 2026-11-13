import type { SonaeEvent } from "#lib/model.ts";

type Listener = (e: SonaeEvent) => void;

/** 受けて DB に入れたイベントを、開いている SSE に配る (1 プロセスの中だけ) */
export class Broker {
  private listeners = new Set<Listener>();
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  publish(e: SonaeEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        console.warn(`[broker] 配れませんでした: ${err}`);
      }
    }
  }
  get size(): number {
    return this.listeners.size;
  }
}
