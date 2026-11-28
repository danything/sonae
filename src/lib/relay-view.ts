/**
 * 中継の源の様子 (`#lib/relay.ts` の `RelayStatus`) の、画面での言い方 (docs/design.md の 2.14 の「失敗したとき」)。
 * 受信の状態の行と、地図の注 (古いものを出していること) に使う。
 *
 * 古いものを今のものと取り違えさせないよう (docs/design.md の 5 章)、取れていないことと、いつまでに取ったものかを書く
 */

import { jst, jstSeconds } from "#lib/format.ts";
import type { RelaySourceId, RelayStatus } from "#lib/relay.ts";

/** 受信の状態の行の名前 */
export const RELAY_LABEL: Record<RelaySourceId, string> = {
  jmatile: "気象庁 (雨雲などの図)",
  volcam: "気象庁 (火山の監視カメラ)",
  gsi: "国土地理院 (写真・避難場所など)",
  "gsi-vector": "国土地理院 (地図の下地)",
  "gsi-search": "国土地理院 (住所の検索)",
  disaportal: "ハザードマップポータルサイト",
  "disaportal-legend": "ハザードマップポータルサイト (凡例)",
  gibs: "NASA GIBS (引いたときの下地)",
};

/** 地図の注の配信元と、何が新しくならないか */
const NOTE: Record<RelaySourceId, { from: string; what: string }> = {
  jmatile: { from: "気象庁", what: "雨雲などの図" },
  volcam: { from: "気象庁", what: "火山の監視カメラの画像" },
  gsi: { from: "国土地理院", what: "写真・活断層図・避難場所" },
  "gsi-vector": { from: "国土地理院", what: "地図の下地" },
  "gsi-search": { from: "国土地理院", what: "住所の検索" },
  disaportal: { from: "ハザードマップポータルサイト", what: "ハザードマップ" },
  "disaportal-legend": {
    from: "ハザードマップポータルサイト",
    what: "ハザードマップの凡例",
  },
  gibs: { from: "NASA GIBS ", what: "下地 (引いたとき)" },
};

/** 受信の状態の行の、中継のつなぎ方の一言 */
export const RELAY_VIA = "サーバーで中継";

/** 配信元から取れていないか (取れない・控えている)。まだ誰も読んでいない (`idle`) は問題にしない */
export const relayInTrouble = (s: RelayStatus) =>
  s.state === "failing" || s.state === "blocked";

/**
 * 受信の状態の行の右の一言。
 * 「取得できています・11/28 10:00:23」「取れません (11/28 10:05 から)・古いものを出しています」
 * 「混んでいるので控えています (11/28 10:12:00 まで)」
 */
export function relayStateText(s: RelayStatus): string {
  const stale = s.staleAt ? "・古いものを出しています" : "";
  switch (s.state) {
    case "idle":
      return "まだ読んでいません";
    case "ok":
      return s.lastOkAt
        ? `取得できています・${jstSeconds(s.lastOkAt)}`
        : "取得できています";
    case "failing":
      return `取れません${s.since ? ` (${jst(s.since)} から)` : ""}${stale}`;
    case "blocked":
      return `混んでいるので控えています${s.retryAt ? ` (${jstSeconds(s.retryAt)} まで)` : ""}${stale}`;
  }
}

/**
 * 地図の注の 1 文。取れていないときだけ。
 * 「気象庁から新しい雨雲などの図を取れていません (11/28 10:05 から)。出しているのは 11/28 10:00 までに取ったものです」
 */
export function relayNote(s: RelayStatus): string | undefined {
  if (!relayInTrouble(s)) return undefined;
  const { from, what } = NOTE[s.id];
  const since = s.since ? ` (${jst(s.since)} から)` : "";
  const busy = s.state === "blocked" ? "混んでいるため、" : "";
  // 古いものを返したとき (staleAt) だけ「出しているのは」と言う。返していなければ、覚えていない所は出せていない
  const shown =
    s.staleAt && s.lastOkAt
      ? `出しているのは ${jst(s.lastOkAt)} までに取ったものです`
      : s.lastOkAt
        ? `覚えていない所は出せません (最後に取れたのは ${jst(s.lastOkAt)})`
        : "出せるものがありません";
  return `${busy}${from}から新しい${what}を取れていません${since}。${shown}`;
}

/** 地図の層のタイルの URL から、どの中継の源を読んでいるか (`/relay/<源>/…`)。中継でなければ undefined */
export function relayIdOf(url: string): RelaySourceId | undefined {
  const m = /\/relay\/([a-z-]+)\//.exec(url);
  const id = m?.[1];
  return id && Object.hasOwn(NOTE, id) ? (id as RelaySourceId) : undefined;
}
