/**
 * 受けたイベントから、通知の中身と「誰に・鳴らすか」を決める (docs/design.md の 2.4)。
 * Web Push (サーバー) と、開いている画面の音・読み上げ (`alerter.svelte.ts`) の両方が使う。
 * 送ることはしない (`server/push.ts`)。時刻と前に送ったものを引数で受ける、副作用の無い関数だけ。
 * どこからでも読むので、Bun や DOM にしか無いものは使わない。
 */

import {
  jst,
  kindText,
  magnitudeText,
  placeName,
  quakeName,
} from "#lib/format.ts";
import {
  type Advisory,
  areaLevel,
  type Eew,
  type Intensity,
  intensityLabel,
  intensityRank,
  isExpired,
  isUrgentAdvisory,
  type Quake,
  type SonaeEvent,
  type Tsunami,
  type TsunamiGrade,
  tsunamiGradeLabel,
  type Volcano,
  VOLCANO_RESIDENTIAL,
  volcanoTop,
  WARNING_PHENOMENON,
  type WarningArea,
  WEATHER_INFO_LABEL,
  type WeatherInfo,
  type WeatherWarning,
} from "#lib/model.ts";
import type {
  Home,
  PushPayload,
  PushPrefs,
  Scope,
  ScopeKind,
} from "#lib/push.ts";
import { OFFICE_PREFIX, selectHref } from "#lib/view.ts";

/** 押したときに開く所 (1 つの画面で、その件を選んだ URL。docs/ui.md) */
const NONE = new URLSearchParams();

/** 1 つのイベントから作る通知。購読ごとに matches で絞り、plan で鳴らすかを決める */
export interface Notice {
  /** 事象の id。同じ事象の続報は、この tag で前の通知を置き換える */
  tag: string;
  /** 重さ。前に送ったときより大きくなったら鳴らし直す */
  level: number;
  title: string;
  body: string;
  url: string;
  urgency: "high" | "normal";
  /** 配信サービスが預かる秒数 (届くのが遅れたら意味が無いものは短く) */
  ttl: number;
  sticky: boolean;
  /** 取消・解除。前に知らせた購読にだけ、通知を置き換えに行く */
  closing: boolean;
  /** 事象の時刻 (ミリ秒)。古すぎるもの (起動したときの埋め直しなど) は送らない */
  at: number;
  /**
   * 続報を送り直すかを見る値。無ければ見出しと本文。緊急地震速報は 1 分ほどの間に報が何十も出て、
   * 報ごとに M や震源が少しずつ変わるので、警報の地域が増えたときだけ送り直す
   */
  changeKey?: string;
  /** 気象の特別警報を、住んでいる地域でなくても知らせるもの (いつも知らせる) */
  special?: boolean;
  /**
   * 気象警報・注意報の通知で、住んでいる地域に当たる市町村等 (電文の名前と、出ている種類)。
   * 読み上げはこれを読む (住んでいる地域の名前は端末ごとに違うので、電文の名前で読む)
   */
  area?: WarningArea;
  /** 現在地の市町村等の気象の通知 (`hereNoticeFor`。開いている画面だけが作る)。読み上げで現在地と言う */
  here?: boolean;
  event: SonaeEvent;
}

/**
 * 送るのをやめる古さ。緊急地震速報は数分で意味が無くなる。地震は 1 時間、津波・お知らせ・火山・気象の警報は 6 時間。
 * 気象の報 (記録的短時間大雨情報・竜巻注意情報) は 1 時間 (竜巻注意情報の有効期限は約 1 時間)
 */
export const FRESH_MS = {
  eew: 3 * 60_000,
  quake: 60 * 60_000,
  tsunami: 6 * 60 * 60_000,
  advisory: 6 * 60 * 60_000,
  volcano: 6 * 60 * 60_000,
  warning: 6 * 60 * 60_000,
  weather: 60 * 60_000,
} as const;

const TTL = {
  eew: 120,
  quake: 60 * 60,
  tsunami: 6 * 60 * 60,
  advisory: 6 * 60 * 60,
  volcano: 6 * 60 * 60,
  warning: 6 * 60 * 60,
  weather: 60 * 60,
} as const;

const BODY_MAX = 300;
const clip = (s: string) =>
  s.length > BODY_MAX ? `${s.slice(0, BODY_MAX - 1)}…` : s;

const GRADE_RANK: Record<TsunamiGrade, number> = {
  none: 0,
  forecast: 1,
  watch: 2,
  warning: 3,
  major: 4,
};
/*
 * 範囲 (全国 / 住んでいる地域と現在地 / 知らせない) ごとに、何の段から知らせるか。人には選ばせない
 * 既定値 (持ち主の決定、2026-11-16。理由は docs/design.md の 2.4 の表)。
 * 「全国」は「住んでいる地域と現在地」で知らせるものに、どこのものでも知らせる段を足したもの
 */
/** 地震の「全国」: どこでもこの最大震度から (前の既定の震度 4) */
export const QUAKE_EVERYWHERE_MIN: Intensity = "4";
/** 地震の住んでいる地域と現在地: その地震情報／細分区域でこの震度から (前の既定の震度 3) */
export const QUAKE_NEARBY_MIN: Intensity = "3";
/** 気象の「全国」: どこに出ても府県予報区ごとに知らせる段 (危険警報、レベル 4)。ほかの範囲は特別警報 (5) だけ */
export const WEATHER_WIDE_EVERYWHERE = 4;

/** 住んでいる地域と、開いている画面の現在地 (どちらも無いことがある) */
const placesOf = (prefs: PushPrefs, here: Home | null): Home[] =>
  [prefs.home, here].filter((p): p is Home => p !== null);

/**
 * 住んでいる地域と現在地の沿岸の予報区に出ている、いちばん高い区分の重さ。前の形で覚えた住んでいる地域
 * (津波予報区を持たない) は、分からないのでどの予報区でも当たるとみなす (知らせない側に倒さない)
 */
function nearbyTsunamiRank(t: Tsunami, places: Home[]): number {
  let top = 0;
  for (const a of t.areas) {
    const hit = places.some(
      (p) =>
        p.tsunami === undefined ||
        p.tsunami.some((x) => (a.code ? x.code === a.code : x.name === a.name)),
    );
    if (hit) top = Math.max(top, GRADE_RANK[a.grade]);
  }
  return top;
}

/** 噴火速報・噴火警報の対象の市町村等に、住んでいる地域か現在地が入るか */
const volcanoNearby = (v: Volcano, places: Home[]): boolean =>
  (v.cityCodes ?? []).some((c) => places.some((p) => p.code === c));

function topGrade(t: Tsunami): TsunamiGrade {
  let top: TsunamiGrade = "none";
  for (const a of t.areas)
    if (GRADE_RANK[a.grade] > GRADE_RANK[top]) top = a.grade;
  return top;
}

function eewNotice(e: Eew, event: SonaeEvent): Notice {
  const place = e.hypocenter?.name;
  const base = {
    tag: `eew:${e.eventId}`,
    url: selectHref(NONE, "eew", e.eventId),
    urgency: "high" as const,
    ttl: TTL.eew,
    at: Date.parse(e.issuedAt),
    event,
  };
  if (e.cancelled) {
    return {
      ...base,
      level: 0,
      title: "緊急地震速報 (取消)",
      body: "先ほどの緊急地震速報は取り消されました。",
      sticky: false,
      closing: true,
    };
  }
  // 予想震度は書かない (docs/design.md の 5 章)。警報は「強い揺れに警戒」と地域名で伝える
  if (e.kind === "warning") {
    const areas = e.warnAreas.length > 0 ? `\n${e.warnAreas.join("・")}` : "";
    return {
      ...base,
      level: 2,
      title: "緊急地震速報 (警報) 強い揺れに警戒",
      changeKey: `warning:${[...e.warnAreas].sort().join(",")}`,
      body: clip(
        `${place ? `${place}で地震。` : ""}強い揺れに警戒してください。${areas}`,
      ),
      sticky: true,
      closing: false,
    };
  }
  const m = e.magnitude === undefined ? "" : ` ${magnitudeText(e)}`;
  return {
    ...base,
    level: 1,
    title: "緊急地震速報 (予報)",
    changeKey: "forecast",
    body: `${place ?? placeName(undefined)}${m}${e.assumed ? " (仮定震源)" : ""}`,
    sticky: false,
    closing: false,
  };
}

function quakeNotice(q: Quake, event: SonaeEvent): Notice {
  const latest = q.reports.at(-1);
  const at = Date.parse(
    q.originTime ?? latest?.targetTime ?? latest?.reportedAt ?? q.updatedAt,
  );
  const base = {
    tag: `quake:${q.id}`,
    url: selectHref(NONE, "quake", q.id),
    urgency: "normal" as const,
    ttl: TTL.quake,
    at,
    sticky: false,
    event,
  };
  if (q.cancelled) {
    return {
      ...base,
      level: 0,
      title: "地震情報 (取消)",
      body: "先ほどの地震情報は取り消されました。",
      closing: true,
    };
  }
  const max = q.maxInt ? `最大震度${intensityLabel(q.maxInt)} ` : "";
  const place = quakeName(q);
  const when = q.originTime ? `${jst(q.originTime)} 頃 ` : "";
  const mag = magnitudeText(q);
  return {
    ...base,
    level: q.maxInt ? intensityRank(q.maxInt) + 1 : 0,
    title: `${max}${place}`,
    body: clip(`${when}${mag === "—" ? "" : mag}`.trim() || "震度速報"),
    closing: false,
  };
}

function tsunamiNotice(t: Tsunami, event: SonaeEvent): Notice {
  const top = topGrade(t);
  const base = {
    tag: `tsunami:${t.id}`,
    url: selectHref(NONE, "tsunami", t.id),
    urgency: "high" as const,
    ttl: TTL.tsunami,
    at: Date.parse(t.issuedAt),
    event,
  };
  if (t.ended || t.cancelled || top === "none") {
    return {
      ...base,
      level: 0,
      title: t.cancelled ? "津波の情報 (取消)" : "津波の警報・注意報の解除",
      body: t.cancelled
        ? "先ほどの津波の情報は取り消されました。"
        : "津波の警報・注意報はすべて解除されました。",
      sticky: false,
      closing: true,
    };
  }
  const names = t.areas.filter((a) => a.grade === top).map((a) => a.name);
  const shown = names.slice(0, 6).join("・");
  const more = names.length > 6 ? ` ほか ${names.length - 6} 区域` : "";
  return {
    ...base,
    level: GRADE_RANK[top],
    title: tsunamiGradeLabel(top),
    body: clip(`${shown}${more}`),
    sticky: top === "major" || top === "warning",
    closing: false,
  };
}

function advisoryNotice(a: Advisory, event: SonaeEvent): Notice {
  return {
    tag: `advisory:${a.id}`,
    // 報が新しくなるたびに鳴らす (調査中 → 巨大地震注意 など)
    level: Date.parse(a.reportedAt) || 0,
    title: a.cancelled
      ? `${a.title} (取消)`
      : a.serialName
        ? `${a.title} (${a.serialName})`
        : a.title,
    body: clip(a.cancelled ? "先ほどの情報は取り消されました。" : a.headline),
    url: selectHref(NONE, "info", a.id),
    urgency: "normal",
    ttl: TTL.advisory,
    sticky: false,
    closing: a.cancelled,
    at: Date.parse(a.reportedAt),
    event,
  };
}

/**
 * 火山。噴火速報は報ごとに、噴火警報・予報は火山ごとに tag を分ける (段が上がったら鳴らし直す)。
 * 噴火速報は段が無いので、いちばん重い 9 として扱う
 */
function volcanoNotice(v: Volcano, event: SonaeEvent): Notice {
  const flash = v.code === "VFVO56";
  const names = v.volcanoes.map((a) => a.name).join("・");
  const top = volcanoTop(v);
  const ended = v.warning?.code === "04";
  return {
    tag: flash
      ? `volcano:flash:${v.eventId}`
      : `volcano:${v.volcanoes.map((a) => a.code).join(",") || v.eventId}`,
    level: v.cancelled ? 0 : flash ? 9 : top,
    title: v.cancelled
      ? `${v.title} (取消)`
      : flash
        ? `噴火速報 ${names}`
        : v.title,
    body: clip(
      v.cancelled
        ? "先ほどの火山の情報は取り消されました。"
        : v.headline
            .replace(/[＜＞]/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
    ),
    url: selectHref(NONE, "volcano", v.id),
    urgency: flash || top >= VOLCANO_RESIDENTIAL ? "high" : "normal",
    ttl: TTL.volcano,
    sticky: !v.cancelled && (flash || top >= VOLCANO_RESIDENTIAL),
    closing: v.cancelled || ended,
    at: Date.parse(v.eventTime ?? v.reportedAt),
    event,
  };
}

/**
 * 気象の通知の元。住んでいる地域で中身が変わるので、ここでは時刻と送り方だけを決め、
 * 中身は購読ごとに `noticeFor` で作る
 */
function weatherBase(event: SonaeEvent, at: number, ttl: number): Notice {
  return {
    tag: "",
    level: 0,
    title: "",
    body: "",
    url: "/",
    urgency: "normal",
    ttl,
    sticky: false,
    closing: false,
    at,
    event,
  };
}

const levelName = (l: number) =>
  l >= 5 ? "特別警報" : l >= 4 ? "危険警報" : l >= 3 ? "警報" : "注意報";

/** 気象警報・注意報の通知。住んでいる地域の段か、どこかの特別警報か */
function warningFor(
  n: Notice,
  w: WeatherWarning,
  prefs: PushPrefs,
): Notice | null {
  const url = selectHref(NONE, "weather", `${OFFICE_PREFIX}${w.office.code}`);
  const home = prefs.home;
  const mine = home ? w.areas.find((a) => a.code === home.code) : undefined;
  const released = home
    ? w.released.find((a) => a.code === home.code)
    : undefined;
  const phenomenon = WARNING_PHENOMENON[w.code];
  let homeNotice: Notice | null = null;
  if (home && (mine || released)) {
    const level = mine ? areaLevel(mine) : 0;
    const kinds = (mine?.kinds ?? [])
      .toSorted((a, b) => b.level - a.level)
      .map((k) => kindText(k.name));
    homeNotice = {
      ...n,
      tag: `warning:${home.code}:${w.code}`,
      level,
      title:
        level > 0
          ? `${home.name}に${kinds[0] ?? levelName(level)}`
          : `${home.name}の${phenomenon}の警報・注意報の解除`,
      body: clip(
        level > 0
          ? [kinds.join("・"), w.headline].filter(Boolean).join("\n")
          : (
              released?.kinds.map((k) => `${kindText(k.name)}は解除`) ?? []
            ).join("・"),
      ),
      url,
      urgency: level >= 4 ? "high" : "normal",
      sticky: level >= 4,
      closing: level === 0,
      ...(mine ? { area: mine } : {}),
    };
  }
  // どこに出ても知らせる段。どこかの特別警報はいつも知らせる (選ばせない。持ち主の決定、2026-11-16)。
  // 「全国」を選んでいれば危険警報 (レベル 4) から (2026-11-16。docs/design.md の 2.4 の表)
  const wide = prefs.weather === "everywhere" ? WEATHER_WIDE_EVERYWHERE : 5;
  const special = w.areas.filter((a) => areaLevel(a) >= wide);
  const homeLevel = homeNotice?.level ?? 0;
  // 同じ府県予報区のほかの市町村等にその段が出ているときは、そちらを先に言う
  // (住んでいる地域がその段以上なら、上の住んでいる地域の通知が言う)
  if (special.length === 0) return homeNotice;
  const top = Math.max(...special.map(areaLevel));
  if (homeLevel >= top) return homeNotice;
  const names = [
    ...new Set(
      special.flatMap((a) =>
        a.kinds.filter((k) => k.level >= wide).map((k) => kindText(k.name)),
      ),
    ),
  ];
  const cities = special.map((a) => a.name);
  const where = `${cities.slice(0, 8).join("・")}${cities.length > 8 ? ` ほか ${cities.length - 8} 市町村` : ""}`;
  const sp: Notice = {
    ...n,
    tag: `warning:special:${w.office.code}:${w.code}`,
    level: top,
    title: `${w.office.name}に${names.join("・")}`,
    body: clip(where),
    url,
    urgency: "high",
    sticky: true,
    closing: false,
    special: true,
  };
  if (!homeNotice) return sp;
  // 住んでいる地域がこの府県予報区にあるときは、住んでいる地域の tag のまま特別警報を言い、
  // 住んでいる地域の状態も添える (住んでいる地域の続報・解除を落とさない。特別警報が終われば
  // 住んでいる地域だけの中身に戻り、同じ tag で置き換わる)
  return {
    ...sp,
    ...(homeNotice.area ? { area: homeNotice.area } : {}),
    tag: homeNotice.tag,
    body: clip(
      `${where}\n${home?.name}: ${homeLevel > 0 ? (mine?.kinds.map((k) => kindText(k.name)).join("・") ?? "") : `${phenomenon}の警報・注意報は解除`}`,
    ),
  };
}

/** 記録的短時間大雨情報・竜巻注意情報。住んでいる地域 (市町村等・一次細分区域・府県予報区) が対象のときだけ */
function weatherInfoFor(
  n: Notice,
  i: WeatherInfo,
  prefs: PushPrefs,
): Notice | null {
  const home = prefs.home;
  if (!home) return null;
  const keys = [home.code, home.ichiji, home.office].filter(Boolean);
  if (!i.areas.some((a) => keys.includes(a.code))) return null;
  return {
    ...n,
    tag: `weather:${i.series}`,
    level: i.cancelled ? 0 : 3,
    title: i.cancelled
      ? `${WEATHER_INFO_LABEL[i.kind]} (取消)`
      : `${WEATHER_INFO_LABEL[i.kind]} ${home.name}`,
    body: clip(
      i.cancelled
        ? "先ほどの情報は取り消されました。"
        : i.headline.replace(/\s+/g, " ").trim(),
    ),
    url: selectHref(NONE, "weather", i.id),
    urgency: "high",
    closing: i.cancelled,
  };
}

/**
 * 購読の条件に合わせて通知の中身を決める。気象は住んでいる地域で中身が変わるので、ここで作る。
 * 津波は「住んでいる地域と現在地」のとき、重さを住んでいる地域と現在地 (`here`。開いている画面だけ) の
 * 予報区の区分にする (そこの区分が上がったら鳴らし直す)。どこかに大津波警報が出ていれば、その重さ
 * (大津波警報は気象の特別警報と同じく、どこに出ても知らせる。docs/design.md の 2.4)。
 * ほかの種類はそのまま返す。この購読に関係しない気象の通知は null
 */
export function noticeFor(
  n: Notice,
  prefs: PushPrefs,
  here: Home | null = null,
): Notice | null {
  const e = n.event;
  if (e.type === "warning") return warningFor(n, e.data, prefs);
  if (e.type === "weather") return weatherInfoFor(n, e.data, prefs);
  if (e.type === "tsunami" && prefs.tsunami === "nearby" && !n.closing) {
    const near = nearbyTsunamiRank(e.data, placesOf(prefs, here));
    return {
      ...n,
      level: n.level === GRADE_RANK.major ? n.level : Math.min(near, n.level),
    };
  }
  return n;
}

/**
 * 現在地の市町村等の、気象の通知 (開いている画面だけが使う。docs/design.md の 2.4 の「現在地」)。
 * 住んでいる地域の通知と同じ作り方で、地域の名前の前に「現在地の」を付け、`here` を立てる。
 * 気象のほかの種類と、現在地が入らないどこかの特別警報 (住んでいる地域の側で言う) は null。
 * `left` は前にいた (もう出た) 市町村等で、出ている通知を解除・続報で置き換えるためのもの。
 * 「現在地の」も `here` も付けない (もういないので。読み上げもしない)
 */
export function hereNoticeFor(
  n: Notice,
  prefs: PushPrefs,
  here: Home,
  left = false,
): Notice | null {
  const e = n.event;
  if (e.type !== "warning" && e.type !== "weather") return null;
  const m = noticeFor(n, {
    ...prefs,
    home: left ? here : { ...here, name: `現在地の${here.name}` },
  });
  if (!m || m.tag.startsWith("warning:special:")) return null;
  if (left) return m;
  // 同じ府県予報区のほかの市町村の特別警報を言う通知は、見出しが府県予報区の名前になるので、
  // 現在地の通知と分かるように添える (現在地の状態は本文に「現在地の…」で入る)
  if (m.special)
    return { ...m, title: `${m.title} (現在地を含む地域)`, here: true };
  return { ...m, here: true };
}

/**
 * イベントから通知を作る。知らせないもの (訓練・試験・遠地地震・定例のお知らせ・古すぎるもの) は null。
 * 気象の通知は、購読ごとに `noticeFor` で中身を決める
 */
export function noticeOf(event: SonaeEvent, now: number): Notice | null {
  // 海外の地震は知らせない (遠地地震と同じ。日本に津波のおそれがあれば気象庁が津波の情報を出す)
  if (event.type === "foreign") return null;
  if (event.data.status !== "normal") return null;
  let n: Notice;
  switch (event.type) {
    case "eew":
      n = eewNotice(event.data, event);
      break;
    case "quake":
      if (event.data.foreign) return null;
      n = quakeNotice(event.data, event);
      break;
    case "tsunami":
      n = tsunamiNotice(event.data, event);
      break;
    case "advisory":
      if (!isUrgentAdvisory(event.data)) return null;
      n = advisoryNotice(event.data, event);
      break;
    case "volcano":
      n = volcanoNotice(event.data, event);
      break;
    case "longperiod":
      // 長周期地震動は地震情報の後に出る観測の詳しい内容なので、知らせない (地震情報で知らせている)
      return null;
    case "warning":
      n = weatherBase(event, Date.parse(event.data.reportedAt), TTL.warning);
      break;
    case "weather": {
      const i = event.data;
      // 知らせるのは記録的短時間大雨情報と竜巻注意情報だけ。有効期限の過ぎた竜巻注意情報は知らせない
      if (i.kind !== "rain" && i.kind !== "tornado") return null;
      if (isExpired(i, now)) return null;
      n = weatherBase(event, Date.parse(i.reportedAt), TTL.weather);
      break;
    }
  }
  if (!Number.isFinite(n.at) || now - n.at > FRESH_MS[event.type]) return null;
  return n;
}

/** この購読の条件に合うか (取消・解除は合わない。前に送った購読にだけ plan が送る) */
export function matches(
  n: Notice,
  prefs: PushPrefs,
  here: Home | null = null,
): boolean {
  if (n.closing) return false;
  const e = n.event;
  const places = placesOf(prefs, here);
  switch (e.type) {
    case "eew":
      // 警報だけ (予報は知らせない)。「住んでいる地域と現在地」は、その地震情報／細分区域が警報の対象のとき
      // (警報の地域は細分区域の名前で届く)
      if (prefs.eew === "off" || e.data.kind !== "warning") return false;
      return (
        prefs.eew === "everywhere" ||
        places.some((p) => p.quake && e.data.warnAreas.includes(p.quake.name))
      );
    case "quake": {
      if (prefs.quake === "off") return false;
      const q = e.data;
      if (
        prefs.quake === "everywhere" &&
        q.maxInt &&
        intensityRank(q.maxInt) >= intensityRank(QUAKE_EVERYWHERE_MIN)
      )
        return true;
      // 住んでいる地域と現在地が入る地震情報／細分区域。P2P の震度速報には地域のコードが無いので、名前でも見る
      return places.some((p) => {
        const area = p.quake;
        return (
          area !== null &&
          q.areas.some(
            (a) =>
              (a.code === area.code || (!a.code && a.name === area.name)) &&
              intensityRank(a.int) >= intensityRank(QUAKE_NEARBY_MIN),
          )
        );
      });
    }
    case "tsunami":
      // 津波注意報以上。「住んでいる地域と現在地」の重さは noticeFor がそこの予報区の区分にしてある
      return prefs.tsunami !== "off" && n.level >= GRADE_RANK.watch;
    case "advisory":
      // 南海トラフ地震臨時情報等はいつも知らせる (選ばせない。持ち主の決定、2026-11-16)
      return true;
    case "volcano": {
      if (prefs.volcano === "off") return false;
      const near = volcanoNearby(e.data, places);
      // 噴火速報は、全国ならどこでも、地域なら対象の市町村等のとき
      if (e.data.code === "VFVO56")
        return prefs.volcano === "everywhere" || near;
      // 噴火警報 (居住地域。レベル 4・5) は特別警報なので、どこに出ても知らせる。
      // 火口周辺警報 (レベル 2・3) は、住んでいる地域か現在地が対象のときだけ
      return n.level >= VOLCANO_RESIDENTIAL || (near && n.level >= 2);
    }
    case "warning":
      // 特別警報はどこに出ても (住んでいる地域でも、「知らせない」にしてあっても) 知らせる。
      // 府県予報区ごとに知らせる通知 (special) は、「全国」なら危険警報から (warningFor が作る)。
      // ほかは住んでいる地域 (と現在地) の警報以上
      if (n.level >= 5) return true;
      if (n.special) return prefs.weather === "everywhere";
      if (prefs.weather === "off") return false;
      return n.level >= 3;
    case "weather":
      // 住んでいる地域の記録的短時間大雨情報・竜巻注意情報 (地域は noticeFor で絞ってある)
      return prefs.weather !== "off";
    case "longperiod":
    case "foreign":
      return false;
  }
}

/** 同じ事象で前に鳴らしたもの (Web Push は購読ごとに push_log、開いている画面はメモリに持つ) */
export interface Sent {
  level: number;
  digest: string;
}

export type Plan = { send: false } | { send: true; renotify: boolean };

/** 中身が変わったかを見るための元の字 (サーバーはこれの SHA-256 を digest として持つ) */
export const contentOf = (n: Pick<Notice, "title" | "body" | "changeKey">) =>
  n.changeKey ?? `${n.title}\n${n.body}`;

/**
 * 鳴らすかどうか (Web Push と、開いている画面の音・読み上げで同じ判定)。同じ事象の続報で何度も鳴らさない:
 * - 初めて: 条件に合えば鳴らす。
 * - 前に送った: 中身が同じなら送らない。重さが上がって条件に合えば鳴らし直す。
 *   それ以外 (震源が決まった・取消・解除など) は、同じ tag で鳴らさずに置き換える。
 *
 * `digest` はこの通知の中身の値 (prev.digest と同じ作り方のもの)。`here` は開いている画面の現在地
 * (サーバーは持たない)。
 */
export function decide(
  n: Notice,
  prefs: PushPrefs,
  prev: Sent | undefined,
  digest: string,
  here: Home | null = null,
): Plan {
  const ok = matches(n, prefs, here);
  if (!prev) return ok ? { send: true, renotify: true } : { send: false };
  if (prev.digest === digest) return { send: false };
  return { send: true, renotify: ok && n.level > prev.level };
}

/**
 * 通知に出す中身。Web Push (サーバー) も、開いている画面の通知 (`alerter.svelte.ts`) もこれで作り、
 * `toNotification` で通知の形にする (同じ事象は同じ tag・見出し・本文になり、前の通知を置き換える)
 */
export function payloadOf(n: Notice, renotify: boolean): PushPayload {
  return {
    title: n.title,
    body: n.body,
    tag: n.tag,
    url: n.url,
    renotify,
    sticky: n.sticky,
    timestamp: n.at,
  };
}

/**
 * 「通知」の窓の住んでいる地域の下に出す文。何で照らすか (地震の細分区域・津波予報区) と、
 * 選んでいないときに「住んでいる地域と現在地」がどうなるかを言う
 */
export function homeNote(home: Home | null): string {
  if (!home)
    return "選んでいないと、「住んでいる地域と現在地のものだけ」は、開いている画面で地図の現在地を出している間だけ知らせます。Web Push と Webhook には、どこに出ても知らせるもの (大津波警報・噴火警報・特別警報など) だけが届きます。";
  const parts = [home.name];
  if (home.quake) parts.push(`地震は「${home.quake.name}」の震度で見ます`);
  if (home.tsunami)
    parts.push(
      home.tsunami.length > 0
        ? `津波は「${home.tsunami.map((t) => t.name).join("」「")}」の予報区で見ます`
        : "海に面していないので、津波は現在地の予報区と、どこに出た大津波警報で見ます",
    );
  return `${parts.join("。")}。`;
}

/** 「通知」の窓の種類の名前 */
export const SCOPE_LABEL: Record<ScopeKind, string> = {
  eew: "緊急地震速報",
  quake: "地震",
  tsunami: "津波",
  volcano: "火山",
  weather: "気象",
};

/** 範囲の選択肢の名前 (どの種類も同じ) */
export const SCOPE_OPTION: Record<Scope, string> = {
  everywhere: "全国のものを知らせる",
  nearby: "住んでいる地域と現在地のものだけ",
  off: "知らせない",
};

/**
 * 選んでいる範囲で何を知らせるかの 1 文 (選択のすぐ下に出す)。段は選ばせない既定値なので、ここで言う。
 * 判定 (`matches`) と同じことを言うよう、決まりを変えたらここも直す
 */
export function scopeText(kind: ScopeKind, scope: Scope): string {
  if (scope === "off")
    return kind === "weather"
      ? "どこに出た特別警報だけを知らせます。"
      : "知らせません。";
  const q = (i: Intensity) => `震度${intensityLabel(i)}以上`;
  const texts: Record<ScopeKind, Record<"everywhere" | "nearby", string>> = {
    eew: {
      everywhere: "どこに出た警報も知らせます。予報は知らせません。",
      nearby:
        "住んでいる地域か現在地が対象の警報だけを知らせます。予報は知らせません。",
    },
    quake: {
      everywhere: `最大${q(QUAKE_EVERYWHERE_MIN)}の地震と、住んでいる地域か現在地で${q(QUAKE_NEARBY_MIN)}の地震を知らせます。`,
      nearby: `住んでいる地域か現在地で${q(QUAKE_NEARBY_MIN)}の地震だけを知らせます。`,
    },
    tsunami: {
      everywhere: "どこに出た津波注意報・津波警報・大津波警報も知らせます。",
      nearby:
        "住んでいる地域か現在地の沿岸の予報区に出た津波注意報以上と、どこに出た大津波警報も知らせます。",
    },
    volcano: {
      everywhere:
        "どこに出た噴火速報と噴火警報 (レベル 4・5) も知らせます。住んでいる地域か現在地が対象なら、火口周辺警報 (レベル 2・3) も知らせます。",
      nearby:
        "住んでいる地域か現在地が対象の噴火速報・火口周辺警報と、どこに出た噴火警報 (レベル 4・5) も知らせます。",
    },
    weather: {
      everywhere:
        "住んでいる地域か現在地の警報以上と記録的短時間大雨情報・竜巻注意情報に加え、どこに出た危険警報 (レベル 4) と特別警報も知らせます。",
      nearby:
        "住んでいる地域か現在地の警報以上と記録的短時間大雨情報・竜巻注意情報、どこに出た特別警報を知らせます。注意報は知らせません。",
    },
  };
  return texts[kind][scope];
}
