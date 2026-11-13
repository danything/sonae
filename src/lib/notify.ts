/**
 * 受けたイベントから、通知の中身と「誰に・鳴らすか」を決める (docs/design.md の 2.4)。
 * Web Push (サーバー) と、開いている画面の音・読み上げ (`alerter.svelte.ts`) の両方が使う。
 * 送ることはしない (`server/push.ts`)。時刻と前に送ったものを引数で受ける、副作用の無い関数だけ。
 * どこからでも読むので、Bun や DOM にしか無いものは使わない。
 */

import { jst, magnitudeText, placeName, quakeName } from "#lib/format.ts";
import {
  type Advisory,
  type Eew,
  intensityLabel,
  intensityRank,
  isUrgentAdvisory,
  type Quake,
  type SonaeEvent,
  type Tsunami,
  type TsunamiGrade,
  tsunamiGradeLabel,
} from "#lib/model.ts";
import type { PushPrefs, TsunamiLevel } from "#lib/push.ts";
import { selectHref } from "#lib/view.ts";

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
  event: SonaeEvent;
}

/** 送るのをやめる古さ。緊急地震速報は数分で意味が無くなる。地震は 1 時間、津波・お知らせは 6 時間 */
export const FRESH_MS = {
  eew: 3 * 60_000,
  quake: 60 * 60_000,
  tsunami: 6 * 60 * 60_000,
  advisory: 6 * 60 * 60_000,
} as const;

const TTL = {
  eew: 120,
  quake: 60 * 60,
  tsunami: 6 * 60 * 60,
  advisory: 6 * 60 * 60,
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
    url: "/",
    urgency: "normal",
    ttl: TTL.advisory,
    sticky: false,
    closing: a.cancelled,
    at: Date.parse(a.reportedAt),
    event,
  };
}

/**
 * イベントから通知を作る。知らせないもの (訓練・試験・遠地地震・定例のお知らせ・古すぎるもの) は null。
 */
export function noticeOf(event: SonaeEvent, now: number): Notice | null {
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
    case "longperiod":
      // 長周期地震動は地震情報の後に出る観測の詳しい内容なので、知らせない (地震情報で知らせている)
      return null;
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
      const area = prefs.area;
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
    case "longperiod":
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
