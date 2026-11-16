/**
 * 通知の条件をサーバーへ送る仕事を 1 つずつ順に並べる列 (`#lib/push-client.ts`)。
 * 続けて変えたときに前の送信と追い越さないように。結果は最後の 1 つが終わったときだけ返す
 * (途中の「保存しました」で終わったと思わせない)
 */

import { failureText } from "./failure.ts";

export function createQueue(): {
  /** 並べる。返すのは、それが最後の 1 つだったときの結果 (後ろにまだ並んでいれば null) */
  push(send: () => Promise<string>): Promise<string | null>;
  /** 並んでいる仕事が全部終わるのを待つ */
  settled(): Promise<void>;
} {
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return {
    push(send) {
      pending++;
      const run = chain.then(send).then(
        (r) => (--pending === 0 ? r : null),
        (err: unknown) =>
          --pending === 0 ? failureText("保存できませんでした", err) : null,
      );
      chain = run;
      return run;
    },
    settled: () => chain.then(() => undefined),
  };
}
