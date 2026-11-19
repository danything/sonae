/**
 * スマホの形で、一覧を読んでいる間に dock (下のタブのすぐ上の操作の 1 行) を引っ込める決まり (docs/ui.md)。
 * denpa の `+layout.svelte` の `data-retract` と同じ条件にする (2026-11-19。持ち主の声「メニューバーが隠れる条件を denpa と同じにしてほしい」)。
 *
 * - **下のタブはいつも出す。** 引っ込めるのは dock だけ (ほかの所へ移るのに上へ戻させない)
 * - **引っ込めるのは窓の高さが 600px に満たないときだけ** (`RETRACT_SHORT`。横向きのスマホ)。
 *   それより高い画面では、出し入れの動きのほうが空く 1 行より気になる
 * - 先頭から 48px までは出す。下へ 4px より多く送ったら引っ込め、上へ 4px より多く戻したら出す
 * - **スマホの形の一覧は窓ごと巻く** (Android のブラウザは、窓が巻かれたときだけアドレスバーを隠す)。見るのは窓の巻いた量
 * - **人が一覧の中を巻いたときだけ見る** (最後に触った所が一覧の中)。選び直して先頭へ戻したときや、
 *   戻る・進むで見ていた位置へ帰したときの巻き取りは読んでいるのではないので、出し入れしない
 * - 画面を移ったら (選ぶ・戻る) 出し、触った所も忘れる。キーボードで dock の中に触っている間は引っ込めない (CSS)
 *
 * DOM に触らない (試験できるように)。動きは CSS の transform だけ
 */

/** dock を引っ込めてよい窓の高さ。横向きのスマホ (430px 前後まで) を含み、縦向きのスマホ (640px から) を含まない */
export const RETRACT_SHORT = "(max-height: 599.98px)";
/** 先頭からこれだけの間は出す */
export const RETRACT_TOP = 48;
/** これより多く動いたら、向きを変える (指の小さな揺れで出し入れしない) */
export const RETRACT_STEP = 4;

/** 巻いた位置 (`y`) と前の位置 (`before`) から、次に引っ込めるかを決める。`short` は窓が低いか */
export function nextRetract(
  cur: boolean,
  y: number,
  before: number,
  short: boolean,
): boolean {
  if (!short || y < RETRACT_TOP) return false;
  if (y - before > RETRACT_STEP) return true;
  if (before - y > RETRACT_STEP) return false;
  return cur;
}

/**
 * 一覧の巻いた量。スマホの形は窓ごと巻くので窓 (`scrollY`)、広い形は列の箱 (`scrollTop`) の中で巻くので箱の値。
 * 戻る・進むで見ていた位置へ帰すときにも使う
 */
export const listTop = (
  phone: boolean,
  win: { scrollY: number },
  box: { scrollTop: number } | undefined,
): number => (phone ? win.scrollY : (box?.scrollTop ?? 0));

/** 人が自分で巻いたか (最後に触った所が一覧の中か)。触った所の無いときは、巻き取りを見ない */
export const touchedInside = (
  box: { contains(node: Node | null): boolean } | undefined,
  touched: EventTarget | null,
): boolean =>
  box !== undefined &&
  touched !== null &&
  // window は Node でないので contains に渡せない
  "nodeType" in touched &&
  box.contains(touched as Node);
