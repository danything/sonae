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

/** 端末 (ブラウザの購読) ごとに選ぶ、何を知らせるか */
export interface PushPrefs {
  eew: EewLevel;
  /** 最大震度がこれ以上の地震。"off" で送らない */
  quakeMinInt: Intensity | "off";
  /** 現在地 (地震情報の細分区域)。無ければ現在地の条件は使わない */
  area: { code: string; name: string } | null;
  /** 現在地でこの震度以上なら、最大震度の条件に届かなくても送る */
  areaMinInt: Intensity;
  tsunami: TsunamiLevel;
  /** 南海トラフ地震臨時情報・定例外の解説情報・後発地震注意情報 */
  advisory: boolean;
  /** 火山 (噴火速報・噴火警報) */
  volcano: VolcanoLevel;
}

/**
 * 既定値。理由は docs/design.md の 2.4 (持ち主の決定、2026-11-13)。
 * 警報だけ・最大震度 4 以上・現在地で 3 以上・津波注意報以上・南海トラフ等はオン。
 * 火山は噴火速報と噴火警報 (居住地域) だけ (2026-11-14 に足した。理由は同じ節)。
 */
export const DEFAULT_PREFS: PushPrefs = {
  eew: "warning",
  quakeMinInt: "4",
  area: null,
  areaMinInt: "3",
  tsunami: "watch",
  advisory: true,
  volcano: "warning",
};

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
  const area = o.area as Record<string, unknown> | null | undefined;
  return {
    eew: pick(EEW_LEVELS, o.eew, DEFAULT_PREFS.eew),
    quakeMinInt:
      o.quakeMinInt === "off" || isIntensity(o.quakeMinInt)
        ? o.quakeMinInt
        : DEFAULT_PREFS.quakeMinInt,
    area:
      area &&
      typeof area.code === "string" &&
      /^\d{1,6}$/.test(area.code) &&
      typeof area.name === "string" &&
      area.name.length > 0 &&
      area.name.length <= 40
        ? { code: area.code, name: area.name }
        : null,
    areaMinInt: isIntensity(o.areaMinInt)
      ? o.areaMinInt
      : DEFAULT_PREFS.areaMinInt,
    tsunami: pick(TSUNAMI_LEVELS, o.tsunami, DEFAULT_PREFS.tsunami),
    advisory:
      typeof o.advisory === "boolean" ? o.advisory : DEFAULT_PREFS.advisory,
    volcano: pick(VOLCANO_LEVELS, o.volcano, DEFAULT_PREFS.volcano),
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
    timestamp: number;
    icon: string;
    lang: string;
    data: { url: string };
  };
}

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
