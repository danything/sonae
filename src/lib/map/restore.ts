/**
 * 地図を寄せる前の位置へ戻す決まり (docs/map.md の「詳しい内容を閉じたら戻す」)。
 *
 * - 何も選んでいないところから、選んだもの (詳しい内容) か、出た緊急地震速報へ地図を寄せる直前に、いまの位置
 *   (中心・ズーム・向き・傾き) を控える
 * - 詳しい内容から別の詳しい内容へ移っても、緊急地震速報の続報や別の速報が来ても、控えは最初のまま
 *   (戻る先は、寄せる前の位置)
 * - 控えている間に人が地図を動かしたら (引く・つまむ・ホイール・ダブルクリック・キー・場所の検索・現在地)、
 *   控えを捨てる。人が自分で見に行った所を、勝手に動かさない
 * - 戻すのは、詳しい内容を閉じていて、出ている緊急地震速報 (取消を除く) も無くなったとき (`due`)。
 *   速報が出ている間に閉じたときは、震央を見せたまま控えを持ち続け、速報が終わったら戻す
 * - 戻したら控えを忘れる。寄せていない (地図が動かなかった) ときは何も返さない
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
  /** 詳しい内容か緊急地震速報のために地図を寄せていて、まだ戻していない */
  private active = false;

  /** 寄せる前の位置を控えていて (人が動かして捨てたときも含む)、まだ戻していない */
  get open(): boolean {
    return this.active;
  }

  /**
   * 地図を寄せる直前に呼ぶ。`selected` は詳しい内容を開いているか、`eew` は出た緊急地震速報へ寄せるか。
   * 緊急地震速報は、届いた所ではまだ自動で開いていない (`selected` が偽) ので、`eew` で控える。
   * どちらでもない寄せ方では控えない。もう控えていれば、最初の控えのまま
   */
  focus(current: MapView, selected: boolean, eew = false): void {
    if (!(selected || eew) || this.active) return;
    this.saved = current;
    this.active = true;
  }

  /** 人が地図を動かした。控えている間なら、戻さない */
  moved(): void {
    if (this.active) this.saved = null;
  }

  /**
   * いま戻すときか。控えていて、詳しい内容を閉じていて (`selected` が偽)、出ている緊急地震速報も無い
   * (`eewShown` が偽) とき
   */
  due(selected: boolean, eewShown: boolean): boolean {
    return this.active && !selected && !eewShown;
  }

  /** 戻す。戻す位置 (戻さないなら null) を返し、控えを忘れる */
  close(): MapView | null {
    const out = this.active ? this.saved : null;
    this.saved = null;
    this.active = false;
    return out;
  }
}
