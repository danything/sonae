/**
 * 自動で詳しい内容を開くかの判定 (docs/ui.md の「自動で開く」)。開くのは 2 つ。
 *
 * - 開いているときの読み上げが読み始めた報 (`alerter.onread`)。読み上げがオンのときだけ
 * - 出た緊急地震速報 (取消を除く)。読み上げがオフでも開く
 *
 * 人がほかの詳しい内容を見ている・窓を開いているときは、命に関わるもの (`isGrave`) だけが切り替える。
 * 履歴は、自動で開いたものを自動で替えるときは置き換え (replaceState)、人が見ていた所から開くときは積む
 * (pushState。戻るで元の所へ戻れる)。続けて幾つ読んでも、積むのは 1 つだけ
 */

import type { Notice } from "./notify.ts";
import { readView, selectHref, type View } from "./view.ts";

type Selected = NonNullable<View["selected"]>;

/**
 * 命に関わるもの。一覧の先頭にチップにかかわらずいつも貼るものと同じ (緊急地震速報 (取消を除く)・
 * 大津波警報と津波警報・気象の特別警報)。これだけは、人が見ているものや開いている窓より先に開く
 */
export function isGrave(n: Notice): boolean {
  if (n.closing) return false;
  switch (n.event.type) {
    case "eew":
      return !n.event.data.cancelled;
    case "tsunami":
      // 通知の重さは 津波注意報 2・津波警報 3・大津波警報 4
      return n.level >= 3;
    case "warning":
      return n.level >= 5;
    default:
      return false;
  }
}

/** 通知の開く所 (`Notice.url`。`/?q=<id>` など) から、選ぶものを読む。選ぶものが無ければ null */
export function targetOf(url: string): Selected | null {
  try {
    return readView(new URL(url, "http://sonae.invalid").searchParams).selected;
  } catch {
    return null;
  }
}

/** いまの画面のようす */
export interface OpenState {
  /** いま選んでいるもの */
  selected: View["selected"];
  /** いま選んでいるものは自動で開いたもので、人はまだ動かしていない */
  auto: boolean;
  /** いま選んでいるものは、出ている緊急地震速報 (取消を除く) */
  holdingEew: boolean;
  /** 窓 (通知・出典と注意) が開いている */
  dialog: boolean;
}

/** 開くときのやり方。`replace` は履歴を置き換える、`closeDialog` は開いている窓を閉じる */
export interface OpenPlan {
  replace: boolean;
  closeDialog: boolean;
}

/**
 * `target` を自動で開くか。開かないときは null。
 *
 * - もう開いているものは開き直さない (命に関わるもので窓が開いていれば、窓だけ閉じる)
 * - 出ている緊急地震速報を見ている間は、ほかの緊急地震速報でなければ替えない
 * - 命に関わらないものは、窓が開いているとき・人がほかのものを選んで見ているときは開かない。
 *   何も選んでいないときと、前に自動で開いたものを見ているときだけ開く
 * - 命に関わるものは、窓を閉じて開く
 */
export function planOpen(
  target: Selected,
  grave: boolean,
  s: OpenState,
): OpenPlan | null {
  const same = s.selected?.kind === target.kind && s.selected.id === target.id;
  if (same)
    return grave && s.dialog ? { replace: true, closeDialog: true } : null;
  if (s.holdingEew && target.kind !== "eew") return null;
  if (!grave && (s.dialog || (s.selected !== null && !s.auto))) return null;
  return { replace: s.auto, closeDialog: grave && s.dialog };
}

/** 開くリンク。いまの query (訓練・試験を出すか) は残し、窓を閉じるときは「出典と注意」も外す */
export function openHref(
  params: Pick<URLSearchParams, "toString">,
  target: Selected,
  closeDialog: boolean,
): string {
  const next = new URLSearchParams(params.toString());
  if (closeDialog) next.delete("about");
  return selectHref(next, target.kind, target.id);
}
