/**
 * 詳しい内容を閉じたときに、地図を開く前の位置へ戻す決まり (docs/map.md の「詳しい内容を閉じたら戻す」)。
 *
 * - 何も選んでいないところから、選んだものへ地図を寄せる直前に、いまの位置 (中心・ズーム・向き・傾き) を控える
 * - 詳しい内容から別の詳しい内容へ移っても、控えは最初のまま (戻る先は、一覧から開く前の位置)
 * - 詳しい内容を開いている間に人が地図を動かしたら (引く・つまむ・ホイール・ダブルクリック・キー・場所の検索)、控えを捨てる。
 *   人が自分で見に行った所を、閉じたときに勝手に動かさない
 * - 閉じたら控えを返して忘れる。寄せていない (地図が動かなかった) ときは何も返さない
 */

/** 地図の位置 */
export interface MapView {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

export class ViewKeeper {
  private saved: MapView | null = null;
  /** 詳しい内容を開いていて、そのために地図を寄せた */
  private active = false;

  /** 詳しい内容のために地図を寄せていて、まだ閉じていない */
  get open(): boolean {
    return this.active;
  }

  /**
   * 選んだものへ地図を寄せる直前に呼ぶ。`selected` は詳しい内容を開いているか (緊急地震速報が出ている間は、
   * 何も選んでいなくても寄せるので、そのときは控えない)
   */
  focus(current: MapView, selected: boolean): void {
    if (!selected || this.active) return;
    this.saved = current;
    this.active = true;
  }

  /** 人が地図を動かした。開いている間なら、閉じても戻さない */
  moved(): void {
    if (this.active) this.saved = null;
  }

  /** 詳しい内容を閉じた。戻す位置 (戻さないなら null) を返し、控えを忘れる */
  close(): MapView | null {
    const out = this.active ? this.saved : null;
    this.saved = null;
    this.active = false;
    return out;
  }
}
