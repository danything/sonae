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
import type { Home, PushPayload, PushPrefs, TsunamiLevel } from "#lib/push.ts";
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
  /** 気象の特別警報を、住んでいる地域でなくても知らせるもの (条件は「特別警報はどこでも」で見る) */
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
const TSUNAMI_MIN: Record<Exclude<TsunamiLevel, "off">, number> = {
  watch: GRADE_RANK.watch,
  warning: GRADE_RANK.warning,
  major: GRADE_RANK.major,
};

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
  const special = w.areas.filter((a) => areaLevel(a) === 5);
  const homeLevel = homeNotice?.level ?? 0;
  // 同じ府県予報区のほかの市町村等に特別警報が出ているときは、特別警報を先に言う
  // (住んでいる地域が特別警報なら、上の住んでいる地域の通知が特別警報を言う)
  if (!prefs.weatherSpecial || special.length === 0 || homeLevel >= 5)
    return homeNotice;
  const names = [
    ...new Set(
      special.flatMap((a) =>
        a.kinds.filter((k) => k.level === 5).map((k) => kindText(k.name)),
      ),
    ),
  ];
  const cities = special.map((a) => a.name);
  const where = `${cities.slice(0, 8).join("・")}${cities.length > 8 ? ` ほか ${cities.length - 8} 市町村` : ""}`;
  const sp: Notice = {
    ...n,
    tag: `warning:special:${w.office.code}:${w.code}`,
    level: 5,
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
 * ほかの種類はそのまま返す。この購読に関係しない気象の通知は null
 */
export function noticeFor(n: Notice, prefs: PushPrefs): Notice | null {
  const e = n.event;
  if (e.type === "warning") return warningFor(n, e.data, prefs);
  if (e.type === "weather") return weatherInfoFor(n, e.data, prefs);
  return n;
}

/**
 * 現在地の市町村等の、気象の通知 (開いている画面だけが使う。docs/design.md の 2.4 の「現在地」)。
 * 住んでいる地域の通知と同じ作り方で、地域の名前の前に「現在地の」を付け、`here` を立てる。
 * 気象のほかの種類と、現在地が入らないどこかの特別警報 (住んでいる地域の側で言う) は null
 */
export function hereNoticeFor(
  n: Notice,
  prefs: PushPrefs,
  here: Home,
): Notice | null {
  const e = n.event;
  if (e.type !== "warning" && e.type !== "weather") return null;
  const m = noticeFor(n, {
    ...prefs,
    home: { ...here, name: `現在地の${here.name}` },
  });
  if (!m || m.tag.startsWith("warning:special:")) return null;
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
export function matches(n: Notice, prefs: PushPrefs): boolean {
  if (n.closing) return false;
  const e = n.event;
  switch (e.type) {
    case "eew":
      return (
        prefs.eew === "all" ||
        (prefs.eew === "warning" && e.data.kind === "warning")
      );
    case "quake": {
      const q = e.data;
      if (
        prefs.quakeMinInt !== "off" &&
        q.maxInt &&
        intensityRank(q.maxInt) >= intensityRank(prefs.quakeMinInt)
      )
        return true;
      // 住んでいる地域が入る地震情報／細分区域
      const area = prefs.home?.quake;
      if (!area) return false;
      // P2P の震度速報には地域のコードが無いので、名前でも見る
      return q.areas.some(
        (a) =>
          (a.code === area.code || (!a.code && a.name === area.name)) &&
          intensityRank(a.int) >= intensityRank(prefs.areaMinInt),
      );
    }
    case "tsunami":
      return prefs.tsunami !== "off" && n.level >= TSUNAMI_MIN[prefs.tsunami];
    case "advisory":
      return prefs.advisory;
    case "volcano":
      // 噴火速報はどちらでも。噴火警報は「warning」なら居住地域 (レベル 4・5)、「all」なら火口周辺 (レベル 2) から
      if (prefs.volcano === "off") return false;
      if (e.data.code === "VFVO56") return true;
      return n.level >= (prefs.volcano === "all" ? 2 : VOLCANO_RESIDENTIAL);
    case "warning":
      // どこかの特別警報 (住んでいる地域でなくても) と、住んでいる地域の警報以上 (「all」なら注意報から)
      if (n.special) return prefs.weatherSpecial;
      if (prefs.weather === "off") return false;
      return n.level >= (prefs.weather === "all" ? 2 : 3);
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
 * `digest` はこの通知の中身の値 (prev.digest と同じ作り方のもの)。
 */
export function decide(
  n: Notice,
  prefs: PushPrefs,
  prev: Sent | undefined,
  digest: string,
): Plan {
  const ok = matches(n, prefs);
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
