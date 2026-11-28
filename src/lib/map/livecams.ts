/**
 * YouTube のライブカメラ (docs/map.md の「YouTube のライブカメラ」・docs/design.md の 2.13)。
 * 国・自治体が自分の YouTube のチャンネルで常に流している、決まった場所のライブカメラだけを、手で表にする。
 *
 * 動画の ID は、配信をやり直すたびに替わる (2026-11 に数日おきに替わった)。そのため表には、チャンネルと、
 * いまの配信をタイトルで見分ける言葉 (`match`) を持ち、ID は目安 (`seed`) にとどめる。いま配信中の ID は、サーバーが
 * YouTube Data API で確かめる (`#lib/server/sources/youtube.ts`)。API のキーが無いサーバーでは、地図の中で
 * 再生せず、YouTube のチャンネルのページへのリンクだけを出す (終わった配信の録画を、いまの映像と取り違えないため)。
 *
 * ここは画面とサーバーの両方から読む。表と、URL の組み立てと、吹き出しの文
 */

import { darkTileIcon } from "#lib/map/cameras.ts";
import type { PopupLine } from "#lib/map/marine.ts";

export interface Livecam {
  /** sonae の中の名前 (表の中で一意。英小文字・数字・`-`) */
  id: string;
  /** 地図と吹き出しに出す名前 (「元町港 (伊豆大島)」) */
  name: string;
  /** 何を映すか (「海岸」「河川」「港」) */
  kind: "海岸" | "河川" | "港";
  /** 配信している機関 (出典に出す) */
  operator: string;
  /** YouTube のチャンネルの ID (`UC` で始まる 24 文字) */
  channel: string;
  /** いまの配信を見分ける、タイトルに含まれる言葉 */
  match: string;
  /** 表を作ったときの動画の ID (目安。替わっていればサーバーが探し直す) */
  seed: string;
  /** 位置 [経度, 緯度] */
  at: [number, number];
  /** 位置の出どころ。「配信元の座標」か「地名から推定」 */
  atBasis: string;
  /** 配信元の公式のページ (チャンネルが公式であることの裏付け。吹き出しのリンク) */
  page: string;
  /** 配信元が求める出典の文 (配信元の YouTube の運用方針や説明欄の例のまま) */
  credit: string;
}

/**
 * 表 (2026-11-28 に作った)。入れたのは、配信元の公式のページからチャンネルへのリンクがあり、埋め込みが許され
 * (oEmbed が 200)、決まった場所を常に映し、配信元が YouTube の配信を自由に使ってよいと書いているもの (九州地方整備局と
 * 杉並区の YouTube の運用方針、東京都港湾局の説明欄) だけ。
 * 入れなかったものと訳は docs/design.md の 1 章「YouTube のライブカメラ」
 */
export const LIVECAMS: Livecam[] = [
  {
    id: "zenpukujigawa-haradera",
    name: "善福寺川 原寺分橋",
    kind: "河川",
    operator: "杉並区",
    channel: "UC8oWZuLFc_cBA0LmgWfA2Rw",
    match: "原寺分橋",
    seed: "78jvZ8JXYOM",
    at: [139.59, 35.712],
    atBasis:
      "地名から推定 (区のページの「善福寺川　原寺分橋下流（西荻北5丁目）」)",
    page: "https://www.city.suginami.tokyo.jp/anzen/saigai/hazardmap/kasenlive/index.html",
    credit: "出典： 善福寺川原寺分橋付近@杉並区河川ライブカメラ Youtube",
  },
  {
    id: "oshima-motomachi",
    name: "元町港 (伊豆大島)",
    kind: "港",
    operator: "東京都港湾局",
    channel: "UCqdejTsUrCvZ55Y8u9v5h9w",
    match: "元町港",
    seed: "wOvC84yodk4",
    at: [139.35237, 34.75188],
    atBasis: "配信元の座標 (離島港湾情報プラットフォームの地図)",
    page: "https://open.ritokouwan-infopf.metro.tokyo.lg.jp/",
    credit: "東京都港湾局提供",
  },
  {
    id: "miyake-miike",
    name: "三池港 (三宅島)",
    kind: "港",
    operator: "東京都港湾局",
    channel: "UCqdejTsUrCvZ55Y8u9v5h9w",
    match: "三池港",
    seed: "FPDC_vKXuzk",
    at: [139.56318, 34.07986],
    atBasis: "配信元の座標 (離島港湾情報プラットフォームの地図)",
    page: "https://open.ritokouwan-infopf.metro.tokyo.lg.jp/",
    credit: "東京都港湾局提供",
  },
  {
    id: "kimotsukigawa",
    name: "肝属川",
    kind: "河川",
    operator: "国土交通省 九州地方整備局",
    channel: "UCJ9F_aQ05kuUkQRCcrh1XgA",
    match: "肝属川",
    seed: "HB7vPHTg2Vc",
    at: [130.85, 31.38],
    atBasis:
      "地名から推定 (鹿屋市・肝付町のあたり。カメラの地点は説明欄に無い)",
    page: "https://www.qsr.mlit.go.jp/useful/kasen_youtube.html",
    credit: "出典： 国土交通省九州地方整備局 Youtube",
  },
  {
    id: "kumagawa",
    name: "球磨川",
    kind: "河川",
    operator: "国土交通省 九州地方整備局",
    channel: "UC8ZZlK9HyQ7WmLZbamIvwcg",
    match: "球磨川",
    seed: "iq6oWIf76Mg",
    at: [130.76, 32.21],
    atBasis: "地名から推定 (人吉市のあたり。カメラの地点は説明欄に無い)",
    page: "https://www.qsr.mlit.go.jp/useful/kasen_youtube.html",
    credit: "出典： 国土交通省九州地方整備局 Youtube",
  },
  {
    id: "shirakawa",
    name: "白川",
    kind: "河川",
    operator: "国土交通省 九州地方整備局",
    channel: "UCCn1d6KhxWkANtNgRU995Uw",
    match: "白川",
    seed: "ZgzUisFZKIY",
    at: [130.71, 32.8],
    atBasis: "地名から推定 (熊本市の中心のあたり。カメラの地点は説明欄に無い)",
    page: "https://www.qsr.mlit.go.jp/useful/kasen_youtube.html",
    credit: "出典： 国土交通省九州地方整備局 Youtube",
  },
  {
    id: "sendaigawa",
    name: "川内川",
    kind: "河川",
    operator: "国土交通省 九州地方整備局",
    channel: "UCcoGrsRbhwDXPXE_pW2ICzQ",
    match: "川内川",
    seed: "FKmTLo2I9E8",
    at: [130.3, 31.82],
    atBasis: "地名から推定 (薩摩川内市のあたり。カメラの地点は説明欄に無い)",
    page: "https://www.qsr.mlit.go.jp/useful/kasen_youtube.html",
    credit: "出典： 国土交通省九州地方整備局 Youtube",
  },
];

/** 画面がいまの配信を読む所 (ログインの後ろ。サーバーが確かめたものを返すだけ) */
export const LIVECAMS_URL = "/api/livecams";

/** YouTube の動画の ID の形 (11 文字) */
export const isVideoId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{11}$/.test(v);

/** チャンネルの ID の形 */
export const isChannelId = (v: unknown): v is string =>
  typeof v === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(v);

/**
 * 埋め込みのプレーヤーの URL。プライバシー強化モード (youtube-nocookie.com) で、押した後なので音を消して自動で再生する
 * (動きを減らす設定とソフトウェアで描く端末では `autoplay` を false にし、再生のボタンを押してもらう)。
 * 形の合わない ID は読まない
 */
export function embedUrl(videoId: string, autoplay = true): string | undefined {
  if (!isVideoId(videoId)) return undefined;
  const q = new URLSearchParams({
    autoplay: autoplay ? "1" : "0",
    mute: "1",
    playsinline: "1",
    rel: "0",
  });
  return `https://www.youtube-nocookie.com/embed/${videoId}?${q}`;
}

/** YouTube で見る (新しいタブ) */
export const watchUrl = (videoId: string) =>
  isVideoId(videoId) ? `https://www.youtube.com/watch?v=${videoId}` : undefined;

/** チャンネルのライブの一覧 (API のキーが無いときと、配信していないときのリンク) */
export const channelStreamsUrl = (channel: string) =>
  isChannelId(channel)
    ? `https://www.youtube.com/channel/${channel}/streams`
    : undefined;

/** `/api/livecams` の答え。カメラの id → いまの配信 */
export interface LivecamResponse {
  /** サーバーに YouTube Data API のキーがあるか。無ければ地図の中で再生しない */
  enabled: boolean;
  cams: Record<string, LivecamState>;
}

interface LivecamState {
  /** いま配信中で、埋め込める動画。無ければ配信していない (か、見つからない) */
  videoId?: string;
  /** 最後に確かめた時刻 (ISO 8601) */
  checkedAt?: string;
}

/** 地図の点 (properties は id だけ。中身は表から引く) */
export function livecamFeatures() {
  return {
    type: "FeatureCollection" as const,
    features: LIVECAMS.map((c) => ({
      type: "Feature" as const,
      properties: { id: c.id },
      geometry: { type: "Point" as const, coordinates: c.at },
    })),
  };
}

export const livecamById = (id: unknown) => LIVECAMS.find((c) => c.id === id);

const timeFmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
});

export function livecamHead(c: Livecam): PopupLine[] {
  return [
    { text: c.name, cls: "bold" },
    { text: `${c.kind}のライブカメラ (YouTube・${c.operator})`, cls: "small" },
  ];
}

/**
 * プレーヤーの代わりに出す文。API のキーが無い・配信していない・読めない、のどれか。
 * `r` が undefined なら読めなかった。配信中なら undefined を返す
 */
export function livecamStatusText(
  r: LivecamResponse | undefined,
  c: Livecam,
): string | undefined {
  if (!r)
    return "配信の状態を読めませんでした。YouTube のページで見てください。";
  if (!r.enabled)
    return "このサーバーには YouTube の API のキーが無いので、配信中かを確かめられません。地図の中では再生せず、YouTube のページへのリンクだけを出します。";
  const s = r.cams[c.id];
  if (s && isVideoId(s.videoId)) return undefined;
  const at = s?.checkedAt
    ? `${timeFmt.format(new Date(s.checkedAt))} に確かめた`
    : "";
  return `いまは配信していないか、見つかりません${at ? ` (${at})` : ""}。`;
}

/** プレーヤーの下の行。YouTube のリンク・配信元のページ・注意・出典 */
export function livecamFoot(
  c: Livecam,
  videoId: string | undefined,
): PopupLine[] {
  const lines: PopupLine[] = [];
  const watch = videoId ? watchUrl(videoId) : channelStreamsUrl(c.channel);
  if (watch)
    lines.push({
      text: videoId ? "YouTube で見る" : "YouTube のチャンネルのライブを見る",
      cls: "small",
      href: watch,
    });
  lines.push(
    { text: `配信元のページ (${c.operator})`, cls: "small", href: c.page },
    {
      text: "参考の映像です。遅れたり止まったりします。避難などの判断は、この映像に頼らず、自治体や気象庁の情報で決めてください。",
      cls: "small muted",
    },
    {
      text: `${c.credit} (${c.operator} の YouTube のライブ配信)。再生は YouTube のプレーヤー (プライバシー強化モード) です。見ると、YouTube の利用規約と、このサーバーのプライバシーポリシーに同意したことになります`,
      cls: "tiny muted",
    },
    // YouTube API Services の Developer Policies III.A.1・III.A.2 (docs/design.md の 1 章「YouTube のライブカメラ」)
    { text: "YouTube 利用規約", cls: "tiny", href: YOUTUBE_TERMS },
    { text: "プライバシーポリシー", cls: "tiny", href: PRIVACY_URL },
  );
  return lines;
}

/** YouTube の利用規約と Google のプライバシーポリシー (出典と注意・プライバシーのページ) */
export const YOUTUBE_TERMS = "https://www.youtube.com/t/terms";
export const GOOGLE_PRIVACY = "https://policies.google.com/privacy";
/** このサーバーのプライバシーポリシー (ログインの外) */
const PRIVACY_URL = "/privacy";

/**
 * 地図の印 (MapLibre の addImage に渡す。pixelRatio 2)。画面だけで呼ぶ。
 * 白い縁の暗い角丸の四角に、白い再生の三角。火山の監視カメラ (カメラの形) と同じ地で、中の形で見分ける
 */
export const livecamIcon = (): ImageData =>
  darkTileIcon((g) => {
    g.beginPath();
    g.moveTo(11, 8.5);
    g.lineTo(20, 14);
    g.lineTo(11, 19.5);
    g.closePath();
    g.fillStyle = "#ffffff";
    g.fill();
  });
