/**
 * 読み上げの原稿 (docs/design.md の 2.4)。通知 (`#lib/notify.ts` の Notice) から、読み上げる文を
 * 区切りごとの並びにする。サーバー (VOICEVOX で前もって合成する) と画面 (合成した音を取りに行く・
 * 端末の読み上げで読む) の両方が同じ原稿を作るので、副作用の無い関数だけを置く。
 *
 * - 冒頭の決まった文 (`OPENINGS`) は起動したときに合成しておき、すぐ鳴らせるようにする。
 *   変わる所 (震源・地域) は事象を受けてから合成する。区切りは文ごとにして、先の文から鳴らせるようにする。
 * - 緊急地震速報の予想震度・到達予想時刻は読まない (docs/design.md の 5 章)。警報は「強い揺れに警戒」と
 *   地域名で伝える。
 * - 気象庁の文 (見出し・津波の付加文) は言い換えずに読む。気象は電文の種類の名前と見出しだけを読み、
 *   雨や風の予想を足さない。
 * - 気象警報・注意報の通知は住んでいる地域で中身が変わる (`noticeFor`)。サーバーが前もって合成できるよう、
 *   地域は電文の市町村等の名前で読む (`readoutCandidates` が、電文に出てくる市町村等ごとの文を並べる)。
 * - 読み上げるだけの字なので、半角の数字と日本語の間に空白を入れない (エンジンが間を置くのを避ける)。
 */

import { kindText } from "./format.ts";
import {
  type AreaIntensity,
  areaLevel,
  type Eew,
  intensityLabel,
  intensityRank,
  type ObservedIntensity,
  type Quake,
  type Tsunami,
  type TsunamiGrade,
  UNRECEIVED,
  type Volcano,
  type WarningArea,
  type WeatherInfo,
  type WeatherWarning,
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
  weatherSpecial: "気象の特別警報です。",
  weatherDanger: "気象の危険警報です。",
  weatherWarning: "気象の警報です。",
  weatherAdvisory: "気象の注意報です。",
  recordRain: "記録的短時間大雨情報です。",
  tornado: "竜巻注意情報です。",
} as const;

/**
 * 現在地の市町村等の気象の通知 (`Notice.here`) で、地域の文の前に読む文。地域は電文の名前で読むので、
 * 住んでいる地域か現在地かをこの文で言う
 */
export const HERE = "現在地の情報です。";

/** 「試しに鳴らす」で、音と読み上げが「読み上げも」のときに通知音の後に読む文 */
export const SAMPLE =
  "そなえの読み上げです。この声で地震や津波の情報をお知らせします。";

/**
 * 画面への配信 (SSE) が切れた・戻ったときに読む文。切れている間はサーバーに音を取りに行けないので、
 * 画面は読み上げがオンになったときに前もって取っておく (`alerter.svelte.ts`)
 */
export const CONNECTION = {
  down: "そなえの受信が切れました。再接続しています。",
  back: "そなえの受信が戻りました。",
} as const;

/** 合成しておく文 (冒頭の文と試しの文と、受信が切れた・戻ったときの文) */
export const FIXED_TEXTS: readonly string[] = [
  ...Object.values(OPENINGS),
  HERE,
  SAMPLE,
  ...Object.values(CONNECTION),
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
function clockText(iso: string | undefined): string | undefined {
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

const WARNING_OPENING: Record<number, string> = {
  4: OPENINGS.weatherDanger,
  3: OPENINGS.weatherWarning,
  2: OPENINGS.weatherAdvisory,
};

/** 出ている種類の名前 (段の高い順。「レベル4土砂災害危険警報」) */
const kindNames = (a: WarningArea, min = 1) =>
  a.kinds
    .filter((k) => k.level >= min)
    .toSorted((x, y) => y.level - x.level)
    .map((k) => clean(kindText(k.name)));

/**
 * 府県予報区ごとに言う段。どこかの特別警報と、「全国」の危険警報 (`Notice.special` の通知は、その段)。
 * 住んでいる地域が特別警報のときも (通知は住んでいる地域の通知で言う)、特別警報として読む。無ければ 0
 */
const wideLevel = (n: Notice): number =>
  n.special ? n.level : n.level >= 5 ? 5 : 0;

/**
 * 気象警報・注意報。住んでいる地域の段 (危険警報・警報・注意報) か、どこかの特別警報・危険警報。
 * 種類の名前と見出しは電文のまま読み、雨や風を予想する文は足さない (docs/design.md の 5 章)。
 * 地域は電文の市町村等の名前で読む (住んでいる地域の名前は端末ごとに違い、サーバーが前もって合成できないため)
 */
function warningParts(n: Notice, w: WeatherWarning): string[] {
  const out: string[] = [];
  const wide = wideLevel(n);
  const special = wide >= 4 ? w.areas.filter((a) => areaLevel(a) >= wide) : [];
  if (special.length > 0) {
    const names = [...new Set(special.flatMap((a) => kindNames(a, wide)))];
    out.push(wide >= 5 ? OPENINGS.weatherSpecial : OPENINGS.weatherDanger);
    out.push(`${clean(w.office.name)}に、${names.join("、")}が出ています。`);
    out.push(
      `対象の市町村は、${listOf(
        special.map((a) => a.name),
        "市町村",
      )}です。`,
    );
  } else {
    const opening = WARNING_OPENING[Math.min(n.level, 4)];
    if (!opening || !n.area) return [];
    out.push(opening);
  }
  if (n.area) {
    const kinds = kindNames(n.area);
    if (kinds.length > 0) {
      if (n.here) out.push(HERE);
      out.push(`${clean(n.area.name)}には、${kinds.join("、")}が出ています。`);
    }
  }
  out.push(...sentences(clean(w.headline)));
  return out;
}

/**
 * 記録的短時間大雨情報・竜巻注意情報。決まった文と、気象庁の見出しのまま。
 * 現在地の通知 (`here`) は、決まった文の後に現在地と言う
 */
function weatherInfoParts(i: WeatherInfo, here: boolean): string[] {
  const headline = [...(here ? [HERE] : []), ...sentences(clean(i.headline))];
  if (i.kind === "rain") return [OPENINGS.recordRain, ...headline];
  if (i.kind === "tornado") {
    const until = clockText(i.validUntil);
    // 有効期限は電文の値 (見出しに無ければ足す)
    const tail =
      until && !headline.some((s) => s.includes("有効"))
        ? [`この情報は${until}まで有効です。`]
        : [];
    return [OPENINGS.tornado, ...headline, ...tail];
  }
  return [];
}

/**
 * 読み上げに使うかもしれない文の全部。気象警報・注意報は住んでいる地域で文が変わるので、
 * 電文に出てくる市町村等ごとに作る。サーバーは、端末が取りに来た文がこの中にあるときだけ合成する
 */
export function readoutCandidates(n: Notice): string[] {
  const e = n.event;
  if (e.type !== "warning") return readoutOf(n);
  const w = e.data;
  const out = new Set<string>();
  const add = (m: Notice) => {
    for (const p of readoutOf(m)) out.add(p);
  };
  // 府県予報区ごとに言う段 (特別警報と「全国」の危険警報) は、出ているいちばん高い段で言う (`warningFor`)
  const top = Math.max(0, ...w.areas.map(areaLevel));
  const wide = top >= 4 ? top : 0;
  if (wide) add({ ...n, special: true, level: wide });
  for (const area of w.areas) {
    const level = areaLevel(area);
    add({ ...n, special: false, level, area });
    if (wide) add({ ...n, special: true, level: wide, area });
  }
  return [...out];
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
    case "warning":
      parts = warningParts(n, e.data);
      break;
    case "weather":
      parts = weatherInfoParts(e.data, n.here === true);
      break;
    default:
      parts = [clean(n.title), ...sentences(clean(n.body))];
  }
  return parts
    .flatMap((p) => (isFixed(p) ? [p] : sentences(p)))
    .filter(Boolean);
}

/**
 * 1 度にまとめて鳴らす通知 (住んでいる地域と現在地の両方に当たった報。`#lib/alert.ts` の `groupAlerts`) の原稿。
 * 住んでいる地域の原稿を先に読み、現在地の原稿は後ろで「現在地の情報です。」から読む (鳴らすのが現在地の
 * 通知でも、後ろの地域の文が現在地か分かるように)。後の原稿は、先に無い文だけを足す (冒頭の文と見出しを 2 度読まない)
 */
export function readoutOfAll(ns: Notice[]): string[] {
  const [first, ...rest] = ns.toSorted(
    (a, b) => Number(a.here === true) - Number(b.here === true),
  );
  if (!first) return [];
  const out = readoutOf(first);
  const seen = new Set(out);
  for (const n of rest)
    for (const p of readoutOf(n))
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
  return out;
}
