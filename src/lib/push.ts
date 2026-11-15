/**
 * Web Push の、画面・サーバー・Service Worker のどれからも使う決めごと (docs/design.md の 2.4)。
 * どこからでも読むので、DOM や Worker にしか無いものは使わない。
 */

import { type Intensity, isIntensity } from "./model.ts";

/** 津波の通知の閾値。注意報以上 / 警報以上 / 大津波警報だけ / 送らない */
export const TSUNAMI_LEVELS = ["watch", "warning", "major", "off"] as const;
export type TsunamiLevel = (typeof TSUNAMI_LEVELS)[number];

/** 緊急地震速報。警報だけ / 予報も / 送らない */
export const EEW_LEVELS = ["warning", "all", "off"] as const;
export type EewLevel = (typeof EEW_LEVELS)[number];

/**
 * 火山。噴火速報と噴火警報 (居住地域、警戒レベル 4・5) / それに火口周辺警報 (レベル 2・3) も / 送らない
 */
export const VOLCANO_LEVELS = ["warning", "all", "off"] as const;
export type VolcanoLevel = (typeof VOLCANO_LEVELS)[number];

/**
 * 気象の通知 (住んでいる地域)。警報以上 (危険警報・特別警報、記録的短時間大雨情報・竜巻注意情報も) /
 * 注意報も / 送らない
 */
export const WEATHER_LEVELS = ["warning", "all", "off"] as const;
export type WeatherLevel = (typeof WEATHER_LEVELS)[number];

/**
 * 住んでいる地域。1 つの市町村等 (気象警報等) を選び、地震と気象の両方の条件に使う。
 * 地震情報／細分区域・府県予報区・一次細分区域は、選んだときに画面が市町村等の表 (`static/areas/cities.json`)
 * から引いて一緒に持つ (サーバーと Service Worker が表を読まずに判定できるように)。緯度・経度は持たない
 */
export interface Home {
  /** 市町村等のコード (気象・地震・火山情報／市町村等、7 桁) */
  code: string;
  /** 府県と市町村の名前 (「群馬県前橋市」) */
  name: string;
  /** 地震情報／細分区域 */
  quake: { code: string; name: string } | null;
  /** 府県予報区のコード (6 桁) */
  office: string | null;
  /** 一次細分区域のコード (6 桁。記録的短時間大雨情報の地域) */
  ichiji: string | null;
}

/** 端末 (ブラウザの購読) ごとに選ぶ、何を知らせるか */
export interface PushPrefs {
  eew: EewLevel;
  /** 最大震度がこれ以上の地震。"off" で送らない */
  quakeMinInt: Intensity | "off";
  /** 住んでいる地域。無ければ地域の条件 (地震の地域の震度・気象) は使わない */
  home: Home | null;
  /** 住んでいる地域でこの震度以上なら、最大震度の条件に届かなくても送る */
  areaMinInt: Intensity;
  tsunami: TsunamiLevel;
  /** 南海トラフ地震臨時情報・定例外の解説情報・後発地震注意情報 */
  advisory: boolean;
  /** 火山 (噴火速報・噴火警報) */
  volcano: VolcanoLevel;
  /** 住んでいる地域の気象警報・注意報と、記録的短時間大雨情報・竜巻注意情報 */
  weather: WeatherLevel;
  /** 気象の特別警報は、住んでいる地域でなくても知らせる */
  weatherSpecial: boolean;
}

/**
 * 既定値。理由は docs/design.md の 2.4 (持ち主の決定、2026-11-13)。
 * 警報だけ・最大震度 4 以上・住んでいる地域で 3 以上・津波注意報以上・南海トラフ等はオン。
 * 火山は噴火速報と噴火警報 (居住地域) だけ (2026-11-14 に足した。理由は同じ節)。
 * 気象は住んでいる地域の警報以上と、どこでも特別警報 (2026-11-14 に足した。注意報は既定で送らない)。
 */
export const DEFAULT_PREFS: PushPrefs = {
  eew: "warning",
  quakeMinInt: "4",
  home: null,
  areaMinInt: "3",
  tsunami: "watch",
  advisory: true,
  volcano: "warning",
  weather: "warning",
  weatherSpecial: true,
};

const code = (v: unknown, digits: number): string | null =>
  typeof v === "string" && new RegExp(`^\\d{${digits}}$`).test(v) ? v : null;
const label = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= 40 ? v : null;

/** 住んでいる地域を読む。市町村等のコードと名前が読めなければ無し */
function readHome(v: unknown): Home | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const c = code(o.code, 7);
  const name = label(o.name);
  if (!c || !name) return null;
  const q =
    typeof o.quake === "object" && o.quake !== null
      ? (o.quake as Record<string, unknown>)
      : {};
  const qc = code(q.code, 3);
  const qn = label(q.name);
  return {
    code: c,
    name,
    quake: qc && qn ? { code: qc, name: qn } : null,
    office: code(o.office, 6),
    ichiji: code(o.ichiji, 6),
  };
}

const pick = <T extends string>(
  list: readonly T[],
  v: unknown,
  fallback: T,
): T => (list.includes(v as T) ? (v as T) : fallback);

/** 外から来た値を、知っている形に直す。読めない項目は既定値に戻す */
export function normalizePrefs(input: unknown): PushPrefs {
  const o =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  // 前の形の「現在地」(地震情報の細分区域だけ。area) は市町村等が分からないので読まない (選び直してもらう)
  return {
    eew: pick(EEW_LEVELS, o.eew, DEFAULT_PREFS.eew),
    quakeMinInt:
      o.quakeMinInt === "off" || isIntensity(o.quakeMinInt)
        ? o.quakeMinInt
        : DEFAULT_PREFS.quakeMinInt,
    home: readHome(o.home),
    areaMinInt: isIntensity(o.areaMinInt)
      ? o.areaMinInt
      : DEFAULT_PREFS.areaMinInt,
    tsunami: pick(TSUNAMI_LEVELS, o.tsunami, DEFAULT_PREFS.tsunami),
    advisory:
      typeof o.advisory === "boolean" ? o.advisory : DEFAULT_PREFS.advisory,
    volcano: pick(VOLCANO_LEVELS, o.volcano, DEFAULT_PREFS.volcano),
    weather: pick(WEATHER_LEVELS, o.weather, DEFAULT_PREFS.weather),
    weatherSpecial:
      typeof o.weatherSpecial === "boolean"
        ? o.weatherSpecial
        : DEFAULT_PREFS.weatherSpecial,
  };
}

/** サーバーが送り、Service Worker が受けて出す中身 (暗号化されて届く。4KB に収める) */
export interface PushPayload {
  title: string;
  body: string;
  /** 事象の id。同じ tag の続報は前の通知を置き換える */
  tag: string;
  /** 押したときに開く所 (このサイトの中のパス) */
  url: string;
  /** 置き換えるときも鳴らし直す (重さが上がったとき) */
  renotify: boolean;
  /** 閉じるまで残す (緊急地震速報の警報・津波警報) */
  sticky: boolean;
  /** 事象の時刻 (ミリ秒) */
  timestamp: number;
}

/** Service Worker の showNotification に渡す形。DOM の型には renotify が無いので自分で書く */
export interface NotificationShape {
  title: string;
  options: {
    body: string;
    tag: string;
    renotify: boolean;
    requireInteraction: boolean;
    /** OS の通知音を鳴らさない (開いている画面が自分で音を鳴らしたとき。docs/design.md の 2.4) */
    silent: boolean;
    timestamp: number;
    icon: string;
    lang: string;
    data: { url: string };
  };
}

/** いま出ている通知のうち、比べる所 (`Notification` の title・body・tag) */
export interface Shown {
  title: string;
  body: string;
  tag: string;
}

/**
 * 同じ事象の同じ中身の通知が、もう出ているか。開いている画面と Web Push の両方が同じ事象で通知を出すので
 * (docs/design.md の 2.4)、後から出すほうはこれで 2 度目の音を鳴らさない
 * (Service Worker は鳴らさずに置き換え、画面は出さない)
 */
export function isShown(
  n: NotificationShape,
  shown: readonly Shown[],
): boolean {
  return shown.some(
    (s) =>
      s.tag === n.options.tag &&
      s.title === n.title &&
      s.body === n.options.body,
  );
}

/** 鳴らさずに置き換える形にする (同じ tag の通知を、音も前に出すことも無しに差し替える) */
export const quiet = (n: NotificationShape): NotificationShape => ({
  title: n.title,
  options: { ...n.options, renotify: false, silent: true },
});

/** 届いた中身を通知の形にする。読めないときも何か出す (iOS は出さないと購読を止める) */
export function toNotification(raw: unknown): NotificationShape {
  const p = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<
    Record<keyof PushPayload, unknown>
  >;
  const str = (v: unknown, fallback: string) =>
    typeof v === "string" && v.length > 0 ? v : fallback;
  const url = str(p.url, "/");
  return {
    title: str(p.title, "sonae"),
    options: {
      body: str(p.body, "新しい情報があります"),
      tag: str(p.tag, "sonae"),
      renotify: p.renotify === true,
      requireInteraction: p.sticky === true,
      silent: false,
      timestamp: typeof p.timestamp === "number" ? p.timestamp : Date.now(),
      // Android の通知は SVG のアイコンを出さないので PNG (tools/icons/build.sh)
      icon: "/icons/icon-192.png",
      lang: "ja",
      // このサイトの中だけ開く (外の URL を開かせない)
      data: { url: url.startsWith("/") && !url.startsWith("//") ? url : "/" },
    },
  };
}

/** VAPID の公開鍵 (base64url) を pushManager.subscribe に渡す形にする */
export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
