/**
 * 避難情報 (高齢者等避難・避難指示・緊急安全確保) と避難所の開設を見るための、都道府県の防災ポータルへのリンク。
 * sonae はページを読まない (取らず、埋め込まない)。リンクを置くだけ (docs/design.md 1 章の「入れない」の避難情報)。
 *
 * 神奈川県は 2026-11-27 に、災害情報ポータルの機械での取得 (スクレイピングなど) は控えてほしい、
 * 代わりにリンクを置いてほしいと答えた (危機管理防災課、整理番号 396262369981)。
 * ほかの都道府県は、聞いて答えをもらってから足す
 */

import { prefectureOf } from "./home.ts";

export interface EvacPortal {
  /** 都道府県の名前 */
  pref: string;
  /** ポータルの名前 */
  name: string;
  href: string;
}

export const EVAC_PORTALS: EvacPortal[] = [
  {
    pref: "神奈川県",
    name: "神奈川県 災害情報ポータル",
    href: "https://www.bousai.pref.kanagawa.jp/",
  },
];

/** 住んでいる地域 (市町村等のコード) の都道府県のポータル。地域を選んでいないか、表に無い都道府県なら null */
export function evacPortalFor(
  code: string | null | undefined,
): EvacPortal | null {
  if (!code) return null;
  const pref = prefectureOf(code);
  return EVAC_PORTALS.find((p) => p.pref === pref) ?? null;
}
