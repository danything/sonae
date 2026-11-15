import { describe, expect, test } from "bun:test";

import {
  AWAKE_LOCK,
  isDesktopEdge,
  KeepAwake,
  type Locks,
} from "#lib/awake.ts";

/** 取ったロックを数える偽の Web Locks (いつもすぐ渡す。取る前に離したら投げる) */
function fakeLocks() {
  const held = new Set<number>();
  const calls: { name: string; mode: string | undefined }[] = [];
  let next = 0;
  const locks: Locks = {
    request: ((
      name: string,
      options: LockOptions,
      callback: (lock: Lock | null) => unknown,
    ) => {
      calls.push({ name, mode: options.mode });
      if (options.signal?.aborted)
        return Promise.reject(new DOMException("aborted", "AbortError"));
      const id = next++;
      held.add(id);
      return Promise.resolve(
        callback({ name, mode: options.mode ?? "exclusive" }),
      ).finally(() => held.delete(id));
    }) as Locks["request"],
  };
  return { locks, held, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("裏のタブを眠らせない", () => {
  test("オンの間は共有のロックを 1 つ持ち、オフで離す", async () => {
    const f = fakeLocks();
    const a = new KeepAwake(f.locks);
    a.set(true);
    a.set(true);
    await tick();
    expect(a.on).toBe(true);
    expect(f.held.size).toBe(1);
    expect(f.calls).toEqual([{ name: AWAKE_LOCK, mode: "shared" }]);

    a.set(false);
    await tick();
    expect(a.on).toBe(false);
    expect(f.held.size).toBe(0);

    a.set(true);
    await tick();
    expect(f.held.size).toBe(1);
    expect(f.calls).toHaveLength(2);
    a.set(false);
    await tick();
    expect(f.held.size).toBe(0);
  });

  test("タブが幾つあっても全部が持てる (ほかのタブを待たせない)", async () => {
    const f = fakeLocks();
    const tabs = [new KeepAwake(f.locks), new KeepAwake(f.locks)];
    for (const t of tabs) t.set(true);
    await tick();
    expect(f.held.size).toBe(2);
    expect(f.calls.every((c) => c.mode === "shared")).toBe(true);
  });

  test("Web Locks が無いブラウザでは何もしない", () => {
    const a = new KeepAwake(undefined);
    a.set(true);
    expect(a.on).toBe(false);
    a.set(false);
    expect(a.on).toBe(false);
  });

  test("取る前に離しても投げない", async () => {
    let signal: AbortSignal | undefined;
    const locks: Locks = {
      // 渡さないまま、離されたら (abort) 断る
      request: ((_: string, options: LockOptions) =>
        new Promise((_, reject) => {
          signal = options.signal;
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as Locks["request"],
    };
    const a = new KeepAwake(locks);
    a.set(true);
    expect(signal?.aborted).toBe(false);
    a.set(false);
    expect(signal?.aborted).toBe(true);
    await tick();
    expect(a.on).toBe(false);
  });
});

describe("Edge の一言", () => {
  test("パソコンの Edge だけに添える", () => {
    const win =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0";
    const android =
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36 EdgA/142.0.0.0";
    const chrome =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
    expect(isDesktopEdge(win)).toBe(true);
    expect(isDesktopEdge(android)).toBe(false);
    expect(isDesktopEdge(chrome)).toBe(false);
  });
});
