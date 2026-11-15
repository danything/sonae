/**
 * 裏にあるタブを眠らせない (docs/design.md の 2.4「裏のタブで止めない」)。
 *
 * Edge の「スリープ中のタブ」と Chromium の止める仕組み (freezing) は、裏のタブの JavaScript を丸ごと止める。
 * 止まっている間は SSE で届いた報もタブの中に溜まるだけで、音・読み上げ・OS の通知は、タブを前に出して
 * 動き出したときにまとめて鳴る。どちらも **Web Lock を持っているページは止めない** ので、知らせるものが
 * オンの間は、鳴らさない名前のロックを 1 つ持ち続ける。共有 (`shared`) で取るので、タブが幾つあっても
 * 全部が持てる (ほかのタブを待たせない)。
 */

/**
 * パソコンの Edge か (「スリープ中のタブ」の一言を添えるためだけ)。Edge の今の説明は、眠らせないタブに
 * Web Lock を挙げなくなった (前の FAQ にはあった) ので、ロックで足りるとは言い切れない
 */
export const isDesktopEdge = (userAgent: string): boolean =>
  /\bEdg\//.test(userAgent);

/** パソコンの Edge で、知らせるものがオンのときに添える一言 */
export const EDGE_SLEEP_HINT =
  "Edge は使っていない裏のタブを眠らせることがあり、眠ると前に出すまで鳴りません。Edge の設定の「システムとパフォーマンス」→「パフォーマンス」の「これらのサイトを常にアクティブに保つ」に、このサイトを足してください。";

/** 持ち続けるロックの名前 (鳴らす控えの `sonae.alert:` とは別) */
export const AWAKE_LOCK = "sonae.awake";

/** 使う Web Locks の形 (`navigator.locks`。試しでは偽物を渡す) */
export type Locks = Pick<LockManager, "request">;

export class KeepAwake {
  private release: (() => void) | undefined;
  private abort: AbortController | undefined;

  constructor(private readonly locks: Locks | undefined) {}

  /** いま持っている (または取りに行っている) */
  get on(): boolean {
    return this.release !== undefined;
  }

  /** オンなら持ち、オフなら離す。同じ値で何度呼んでもよい */
  set(on: boolean): void {
    if (on === this.on) return;
    if (!on) {
      this.abort?.abort();
      this.release?.();
      this.abort = undefined;
      this.release = undefined;
      return;
    }
    if (!this.locks) return;
    const abort = new AbortController();
    const held = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.abort = abort;
    this.locks
      .request(AWAKE_LOCK, { mode: "shared", signal: abort.signal }, () => held)
      // 取る前に離した (abort)・Web Locks が使えない: 眠らせない手が無いだけで、知らせは続ける
      .catch(() => {});
  }
}
