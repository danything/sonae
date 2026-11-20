/** 画面の書き方。時刻はいつも日本時間で出す (気象庁の発表に合わせる) */

import type {
  ForeignSource,
  Hypocenter,
  Quake,
  SourceId,
  SourceStatus,
  Status,
  WeatherInfo,
} from "./model.ts";

const dateTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const fullDateTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const clock = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const valid = (iso: string | undefined): iso is string =>
  iso !== undefined && Number.isFinite(Date.parse(iso));

/** 「11/13 08:43」 */
export const jst = (iso: string | undefined) =>
  valid(iso) ? dateTime.format(new Date(iso)) : "—";
/** 「2026/11/13 08:43:12」 */
export const jstFull = (iso: string | undefined) =>
  valid(iso) ? fullDateTime.format(new Date(iso)) : "—";
/** 「08:43」(一覧の行の時刻) */
export const jstTime = (iso: string | undefined) => jstClock(iso).slice(0, 5);
/** 「08:43:12」 */
export const jstClock = (iso: string | undefined) =>
  valid(iso) ? clock.format(new Date(iso)) : "—";

export function depthText(h: Hypocenter | undefined): string {
  if (h?.depthKm === undefined) return "不明";
  return h.depthKm === 0 ? "ごく浅い" : `約 ${h.depthKm} km`;
}

/** 震源の名前。まだ決まっていなければ「震源は調査中」 */
export const placeName = (h: Hypocenter | undefined) =>
  h?.name ?? "震源は調査中";

/** 地震の名前。震源が決まる前 (震度速報だけ) は、震度を観測した最初の地域で「〜 など」 */
export const quakeName = (q: Pick<Quake, "hypocenter" | "areas">) =>
  q.hypocenter?.name ??
  (q.areas[0] ? `${q.areas[0].name} など` : placeName(undefined));

/** 訓練・試験の印 (通常は空) */
export const STATUS_LABEL: Record<Status, string> = {
  normal: "",
  training: "訓練",
  test: "試験",
};

/**
 * 訓練・試験の緊急地震速報の詳しい内容の先頭に、大きく出す文 (通常は空)。
 * 訓練・試験は一覧と地図に出さなくても (`SONAE_TRAINING` がオフ)、`?e=<識別番号>` のリンクでは開くので、
 * 本物と取り違えないようにする (docs/design.md の 2.2)
 */
export const EEW_DRILL_NOTE: Record<Status, string> = {
  normal: "",
  training: "訓練の緊急地震速報です。実際の地震ではありません。",
  test: "試験の緊急地震速報です。実際の地震ではありません。",
};

/** 海外の地震の情報源の短い名前 (一覧の行の 2 段目) */
export const FOREIGN_SOURCE_SHORT: Record<ForeignSource, string> = {
  usgs: "USGS",
  emsc: "EMSC",
  geonet: "GeoNet",
  cwa: "中央氣象署",
};

/** 情報源の名前 (受信の状態・詳しい内容・起動のログ) */
export const SOURCE_LABEL: Record<SourceId, string> = {
  jma: "気象庁 防災情報 XML",
  "jma-weather": "気象庁 防災情報 XML (気象)",
  p2p: "P2P地震情報",
  wolfx: "Wolfx Project",
  usgs: "USGS (米国地質調査所)",
  emsc: "EMSC (欧州地中海地震センター)",
  geonet: "GeoNet (ニュージーランド)",
  cwa: "中央氣象署 (台湾)",
  ptwc: "PTWC (米国 太平洋津波警報センター)",
  "jma-bosai": "気象庁ホームページ (国際津波)",
  trem: "ExpTech TREM (台湾の観測点の揺れ・非公式)",
  seisjs: "Wolfx SeisJS (有志の観測点の揺れ・非公式)",
  msil: "海しる (海上保安庁。海底地殻変動観測点・海域火山)",
  roads: "国土交通省 (災害時の通行止め)",
};

const SOURCE_STATE: Record<SourceStatus["state"], string> = {
  connecting: "接続中",
  connected: "受信中",
  retrying: "再接続中",
  stopped: "停止",
  off: "オフ",
};

/** 情報源の受信の状態の 1 行 (「受信中・11/13 08:43」「オフ (授権碼がありません)」) */
export function sourceStateText(s: SourceStatus): string {
  const state = SOURCE_STATE[s.state] ?? s.state;
  if (s.state === "off") return s.reason ? `${state} (${s.reason})` : state;
  const road = roadDiscoverText(s, state);
  if (road) return road;
  return s.lastSeenAt ? `${state}・${jst(s.lastSeenAt)}` : state;
}

/**
 * 災害時の通行止めを自動で見つけているときの 1 行 (docs/design.md の 2.12)。
 * 「受信中・令和8年熊本地震 (1 件)・11/21 10:00 に一覧を確かめた」「災害の通行止めはありません (11/21 10:00 に確かめた)」
 * 「一覧が読めません (最後に読めたのは 11/21 07:00)」。自動の発見を使っていなければ undefined
 */
function roadDiscoverText(s: SourceStatus, state: string): string | undefined {
  const r = s.roads;
  if (s.id !== "roads" || !r?.discover || s.state === "stopped")
    return undefined;
  if (r.problem)
    return r.checkedAt
      ? `${r.problem} (最後に読めたのは ${jst(r.checkedAt)})`
      : r.problem;
  if (!r.checkedAt) return "一覧を確かめています";
  const at = jst(r.checkedAt);
  const manual = r.manual > 0 ? `登録した URL ${r.manual} 件` : undefined;
  const n = r.disasters.length;
  if (n === 0)
    return manual
      ? `${state}・${manual}・一覧に災害はありません (${at} に確かめた)`
      : `災害の通行止めはありません (${at} に確かめた)`;
  const found = `${r.disasters.join("、")} (${n} 件)`;
  return `${state}・${manual ? `${found}、${manual}` : found}・${at} に一覧を確かめた`;
}

/** 注意の色で出す状態か。受信中と、設定で切ってあるものは問題ではない。通行止めの一覧が読めないときは出す */
export const sourceInTrouble = (s: SourceStatus) =>
  (s.state !== "connected" && s.state !== "off") ||
  (s.id === "roads" && s.state !== "off" && !!s.roads?.problem);

/** M の書き方 (「M3.5」)。M が無ければ電文の文のまま、それも無ければ「—」 */
export function magnitudeText(
  q: Pick<Quake, "magnitude" | "magnitudeText">,
): string {
  if (typeof q.magnitude === "number") return `M${q.magnitude.toFixed(1)}`;
  // 「Ｍ不明」「Ｍ８を超える巨大地震」は電文の文のまま
  return q.magnitudeText ?? "—";
}

/**
 * いま出ている緊急地震速報の箱の震源の行 (「震源 石川県能登地方・深さ 約 10 km・M5.6」)。
 * 震源も M も無ければ空
 */
export function eewSourceLine(
  e: Pick<Quake, "hypocenter" | "magnitude" | "magnitudeText">,
): string {
  return [
    e.hypocenter
      ? `震源 ${e.hypocenter.name}・深さ ${depthText(e.hypocenter)}`
      : "",
    e.magnitude !== undefined ? magnitudeText(e) : "",
  ]
    .filter(Boolean)
    .join("・");
}

/** 気象庁の「震度の色」(配色の指針 表 2-2) と、その上に置く字の色 */
export const INTENSITY_COLORS: Record<string, { bg: string; fg: string }> = {
  "7": { bg: "rgb(180 0 104)", fg: "#fff" },
  "6+": { bg: "rgb(165 0 33)", fg: "#fff" },
  "6-": { bg: "rgb(255 40 0)", fg: "#fff" },
  "5+": { bg: "rgb(255 153 0)", fg: "#000" },
  "5-": { bg: "rgb(255 230 0)", fg: "#000" },
  "5-?": { bg: "rgb(255 230 0)", fg: "#000" },
  "4": { bg: "rgb(250 230 150)", fg: "#000" },
  "3": { bg: "rgb(0 65 255)", fg: "#fff" },
  "2": { bg: "rgb(0 170 255)", fg: "#000" },
  "1": { bg: "rgb(242 242 255)", fg: "#000" },
};

/**
 * 長周期地震動階級の色。気象庁の配色の指針に長周期地震動階級の表は無いので、表 2-1 (数値が高くなるほど
 * 危険度が増す情報) の基本配色の上から 4 つを、階級 4 から順に当てた (自分で決めた割り当て)
 */
export const LG_COLORS: Record<string, { bg: string; fg: string }> = {
  "4": { bg: "rgb(180 0 104)", fg: "#fff" },
  "3": { bg: "rgb(255 40 0)", fg: "#fff" },
  "2": { bg: "rgb(255 153 0)", fg: "#000" },
  "1": { bg: "rgb(250 245 0)", fg: "#000" },
};

/** 気象庁の「津波の色」(同じ指針の表 1-2)。津波予報は指針に無いので自分で決めた青系 */
export const TSUNAMI_COLORS: Record<string, { bg: string; fg: string }> = {
  major: { bg: "rgb(200 0 255)", fg: "#fff" },
  warning: { bg: "rgb(255 40 0)", fg: "#fff" },
  watch: { bg: "rgb(250 245 0)", fg: "#000" },
  forecast: { bg: "rgb(120 160 220)", fg: "#000" },
  none: { bg: "rgb(200 200 203)", fg: "#000" },
};

/**
 * 噴火警報・予報の色 (同じ指針の表 1-2)。段 (`volcanoLevel`) ごとに、5 は 200,0,255、4 は 255,40,0、
 * 3 は 255,170,0、2 は 250,245,0、1 は 242,242,255
 */
export const VOLCANO_COLORS: Record<number, { bg: string; fg: string }> = {
  5: { bg: "rgb(200 0 255)", fg: "#fff" },
  4: { bg: "rgb(255 40 0)", fg: "#fff" },
  3: { bg: "rgb(255 170 0)", fg: "#000" },
  2: { bg: "rgb(250 245 0)", fg: "#000" },
  1: { bg: "rgb(242 242 255)", fg: "#000" },
};

/**
 * 気象警報・注意報の段の色。配色の指針 (令和 2 年 7 月の一部改訂) の表 1-1 の警戒レベルの列
 * (5 相当 特別警報 12,0,12・4 相当 土砂災害警戒情報 170,0,170・3 相当 警報 255,40,0・2 注意報 242,231,0・
 * 発表なし 200,200,203)。指針は危険警報の名前でまだ書き直されていないので、レベル 4 の色を危険警報に当てた。
 * 気象庁ホームページの警報の地図も同じ色 (2026-11-14 に確かめた)。指定河川洪水予報も同じ表で同じ 4 色
 */
export const WARNING_COLORS: Record<number, { bg: string; fg: string }> = {
  5: { bg: "rgb(12 0 12)", fg: "#fff" },
  4: { bg: "rgb(170 0 170)", fg: "#fff" },
  3: { bg: "rgb(255 40 0)", fg: "#fff" },
  2: { bg: "rgb(242 231 0)", fg: "#000" },
  0: { bg: "rgb(200 200 203)", fg: "#000" },
};

/** 「レベル３大雨警報」の全角の数字を半角に (画面の字の幅をそろえる。名前はそのまま) */
export const kindText = (name: string) =>
  name.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );

/**
 * 気象の報のタイトル。台風は電文の題名がどれも「台風解析・予報情報」なので、台風番号と名前にする
 * (「台風第 32 号 CEMPAKA」。番号の上 2 桁は年)
 */
export function weatherTitle(
  w: Pick<WeatherInfo, "title" | "typhoon">,
): string {
  const t = w.typhoon;
  if (!t?.number && !t?.name) return w.title;
  const no = t.number ? `台風第 ${Number(t.number.slice(2))} 号` : "台風";
  return t.name ? `${no} ${t.name}` : no;
}

/**
 * 火山の種類の名前を短くする (「レベル３（入山規制）」→「レベル3 入山規制」)。
 * 全角の数字を半角に、終わりの全角の括弧を空白に替える
 */
export const volcanoKindText = (kind: string) =>
  kind
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/（([^（）]*)）$/, " $1")
    .trim();
