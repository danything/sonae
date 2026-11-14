/**
 * 読み上げの原稿 (docs/design.md の 2.4)。通知 (`#lib/notify.ts` の Notice) から、読み上げる文を
 * 区切りごとの並びにする。サーバー (VOICEVOX で前もって合成する) と画面 (合成した音を取りに行く・
 * 端末の読み上げで読む) の両方が同じ原稿を作るので、副作用の無い関数だけを置く。
 *
 * - 冒頭の決まった文 (`OPENINGS`) は起動したときに合成しておき、すぐ鳴らせるようにする。
 *   変わる所 (震源・地域) は事象を受けてから合成する。区切りは文ごとにして、先の文から鳴らせるようにする。
 * - 緊急地震速報の予想震度・到達予想時刻は読まない (docs/design.md の 5 章)。警報は「強い揺れに警戒」と
 *   地域名で伝える。
 * - 気象庁の文 (見出し・津波の付加文) は言い換えずに読む。
 * - 読み上げるだけの字なので、半角の数字と日本語の間に空白を入れない (エンジンが間を置くのを避ける)。
 */

import {
  type AreaIntensity,
  type Eew,
  intensityLabel,
  intensityRank,
  type ObservedIntensity,
  type Quake,
  type Tsunami,
  type TsunamiGrade,
  UNRECEIVED,
  type Volcano,
} from "./model.ts";
import type { Notice } from "./notify.ts";

/** 冒頭の決まった文。起動したときに合成しておく */
export const OPENINGS = {
  eewWarning: "緊急地震速報です。強い揺れに警戒してください。",
  eewForecast: "緊急地震速報、予報です。",
  quakeScale: "震度速報です。",
  quakeInfo: "地震情報です。",
  tsunamiMajor: "大津波警報が発表されました。",
  tsunamiWarning: "津波警報が発表されました。",
  tsunamiWatch: "津波注意報が発表されました。",
  nankai: "南海トラフ地震に関連する情報です。",
  aftershock: "北海道・三陸沖後発地震注意情報です。",
  eruption: "噴火速報です。",
  volcano: "火山の情報です。",
} as const;

/** 「試しに聞く」と「試しに鳴らす」で読む文 */
export const SAMPLE =
  "そなえの読み上げです。この声で地震や津波の情報をお知らせします。";

/** 合成しておく文 (冒頭の文と試しの文) */
export const FIXED_TEXTS: readonly string[] = [
  ...Object.values(OPENINGS),
  SAMPLE,
];
const FIXED = new Set(FIXED_TEXTS);
export const isFixed = (text: string) => FIXED.has(text);

/** 地域を並べて読む数の上限。超えたら「など」で数を言う */
const LIST_MAX = 10;

/** 全角の数字・英字を半角に、読ませない記号を外す */
export function clean(s: string): string {
  return s
    .replace(/[０-９Ａ-Ｚａ-ｚ．]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    .replace(/[＜＞<>「」『』]/g, "")
    .replace(/[（(]/g, "、")
    .replace(/[）)]/g, "、")
    .replace(/、+/g, "、")
    .replace(/、(。|$)/g, "$1")
    .replace(/\s+/g, "")
    .trim();
}

/** 文ごとに区切る (句点で終わらない終わりの文も 1 つに) */
export function sentences(s: string): string[] {
  return (s.match(/[^。]+。?/g) ?? []).map((x) => x.trim()).filter(Boolean);
}

/** 地域の名前を「、」で並べる。多ければ先の幾つかと「など、N の地域」 */
export function listOf(names: string[], unit = "地域"): string {
  const uniq = [...new Set(names.map(clean))];
  if (uniq.length <= LIST_MAX) return uniq.join("、");
  return `${uniq.slice(0, LIST_MAX).join("、")}など、${uniq.length}の${unit}`;
}

/** 「8時43分」(日本時間) */
export function clockText(iso: string | undefined): string | undefined {
  if (!iso || !Number.isFinite(Date.parse(iso))) return undefined;
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  return `${h}時${m}分`;
}

/** 震度の読み方 (「震度5弱」)。未入電は別に言うので、ここでは 5 弱以上 */
const intensityWords = (i: ObservedIntensity) =>
  `震度${i === UNRECEIVED ? "5弱以上" : intensityLabel(i)}`;

function magnitudeWords(
  q: Pick<Quake, "magnitude" | "magnitudeText">,
): string | undefined {
  if (typeof q.magnitude === "number")
    return `マグニチュード${q.magnitude.toFixed(1)}`;
  return q.magnitudeText
    ? clean(q.magnitudeText).replace(/M/g, "マグニチュード")
    : undefined;
}

function eewParts(e: Eew): string[] {
  const place = e.hypocenter?.name ? clean(e.hypocenter.name) : undefined;
  if (e.kind === "warning") {
    // 決まった文を 2 度読む (テレビ・ラジオの伝え方と同じ)。その間に地域の文を合成する
    const out: string[] = [OPENINGS.eewWarning, OPENINGS.eewWarning];
    if (e.warnAreas.length > 0)
      out.push(`強い揺れに警戒が必要な地域は、${listOf(e.warnAreas)}です。`);
    if (place) out.push(`震源は${place}です。`);
    return out;
  }
  const out: string[] = [OPENINGS.eewForecast];
  const m =
    e.magnitude === undefined
      ? undefined
      : `マグニチュード${e.magnitude.toFixed(1)}`;
  if (place)
    out.push(`震源は${place}${m ? `、規模は${m}` : ""}と推定されています。`);
  else if (m) out.push(`規模は${m}と推定されています。`);
  if (e.assumed) out.push("震源と規模は仮のものです。");
  return out;
}

/** 震度の高いほうから 2 つの段ごとに「震度Xを観測したのは、…です。」 */
function intensityLines(areas: AreaIntensity[]): string[] {
  const byInt = new Map<ObservedIntensity, string[]>();
  for (const a of areas) {
    const list = byInt.get(a.int) ?? [];
    list.push(a.name);
    byInt.set(a.int, list);
  }
  const ordered = [...byInt.keys()].sort(
    (a, b) =>
      intensityRank(b) - intensityRank(a) || (a === UNRECEIVED ? 1 : -1),
  );
  const out: string[] = [];
  for (const i of ordered.slice(0, 2)) {
    const names = listOf(byInt.get(i) ?? []);
    out.push(
      i === UNRECEIVED
        ? `震度5弱以上とみられ、まだ震度が入っていない地域は、${names}です。`
        : `${intensityWords(i)}を観測したのは、${names}です。`,
    );
  }
  return out;
}

function quakeParts(q: Quake): string[] {
  const latest = q.reports.at(-1);
  const when = clockText(q.originTime ?? latest?.targetTime);
  const place = q.hypocenter?.name ? clean(q.hypocenter.name) : undefined;
  const out: string[] = [];
  if (!place) {
    // 震度速報 (震源がまだ決まっていない)
    out.push(OPENINGS.quakeScale);
    const max = q.maxInt ? `最大${intensityWords(q.maxInt)}を観測する` : "";
    out.push(`${when ? `${when}ごろ、` : ""}${max}地震がありました。`);
  } else {
    out.push(OPENINGS.quakeInfo);
    out.push(
      `${when ? `${when}ごろ、` : ""}${place}を震源とする地震がありました。`,
    );
    const depth = q.hypocenter?.depthKm;
    const depthText =
      depth === undefined
        ? undefined
        : depth === 0
          ? "ごく浅く"
          : `約${depth}キロメートル`;
    const m = magnitudeWords(q);
    if (depthText && m)
      out.push(
        `震源の深さは${depthText}、地震の規模を示すマグニチュードは${m.replace("マグニチュード", "")}と推定されています。`,
      );
    else if (m) out.push(`地震の規模は${m}と推定されています。`);
    if (q.maxInt) out.push(`最大${intensityWords(q.maxInt)}を観測しました。`);
  }
  out.push(...intensityLines(q.areas));
  // 津波の有無は気象庁の文のまま (「この地震による津波の心配はありません。」など)
  for (const c of q.comments)
    if (c.includes("津波")) out.push(...sentences(clean(c)));
  return out;
}

const TSUNAMI_OPENING: Partial<Record<TsunamiGrade, string>> = {
  major: OPENINGS.tsunamiMajor,
  warning: OPENINGS.tsunamiWarning,
  watch: OPENINGS.tsunamiWatch,
};
const TSUNAMI_WORDS: Partial<Record<TsunamiGrade, string>> = {
  major: "大津波警報",
  warning: "津波警報",
  watch: "津波注意報",
};

function tsunamiParts(t: Tsunami, top: TsunamiGrade): string[] {
  const opening = TSUNAMI_OPENING[top];
  const out: string[] = opening ? [opening] : [];
  const names = (g: TsunamiGrade) =>
    t.areas.filter((a) => a.grade === g).map((a) => a.name);
  // 大津波警報と津波警報の地域を先に、全部読む (逃げる人に要るので「など」で縮めない)
  for (const g of ["major", "warning"] as const) {
    const list = [...new Set(names(g).map(clean))];
    if (list.length > 0)
      out.push(`${TSUNAMI_WORDS[g]}が出ている地域は、${list.join("、")}です。`);
  }
  if (t.headline) out.push(...sentences(clean(t.headline)));
  const watch = names("watch");
  if (watch.length > 0)
    out.push(`津波注意報が出ている地域は、${listOf(watch)}です。`);
  return out;
}

function volcanoParts(v: Volcano): string[] {
  const flash = v.code === "VFVO56";
  const names = v.volcanoes.map((a) => clean(a.name)).join("、");
  const headline = sentences(clean(v.headline));
  if (flash)
    return [
      OPENINGS.eruption,
      ...(headline.length > 0 ? headline : [`${names}で噴火が発生しました。`]),
    ];
  return [OPENINGS.volcano, `${clean(v.title)}が発表されました。`, ...headline];
}

/**
 * 通知から読み上げの原稿を作る。区切りごとの文の並びで、決まった文 (`isFixed`) はそのまま、
 * 変わる文は 1 文ずつ。取消・解除は読まない (鳴らさないので)。
 * 知らない種類 (これから足す種類) は、通知の見出しと本文を読む。
 */
export function readoutOf(n: Notice): string[] {
  if (n.closing) return [];
  const e = n.event;
  let parts: string[];
  switch (e.type) {
    case "eew":
      parts = eewParts(e.data);
      break;
    case "quake":
      parts = quakeParts(e.data);
      break;
    case "tsunami": {
      const top = (["major", "warning", "watch"] as const).find((g) =>
        e.data.areas.some((a) => a.grade === g),
      );
      parts = top ? tsunamiParts(e.data, top) : [];
      break;
    }
    case "advisory": {
      const a = e.data;
      const serial = a.serialName ? `、${clean(a.serialName)}` : "";
      parts = [
        a.code === "VYSE60" ? OPENINGS.aftershock : OPENINGS.nankai,
        `${clean(a.title)}${serial}が発表されました。`,
        ...sentences(clean(a.headline)),
      ];
      break;
    }
    case "volcano":
      parts = volcanoParts(e.data);
      break;
    default:
      parts = [clean(n.title), ...sentences(clean(n.body))];
  }
  return parts
    .flatMap((p) => (isFixed(p) ? [p] : sentences(p)))
    .filter(Boolean);
}
