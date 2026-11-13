/**
 * 開いているときの音と読み上げの、DOM を使わない部分 (docs/design.md の 2.4)。
 * 鳴らす判定は Web Push と同じ `#lib/notify.ts` の noticeOf・decide を使う。鳴らすのは `alerter.svelte.ts`。
 */

import type { SonaeEvent } from "./model.ts";
import {
  contentOf,
  decide,
  type Notice,
  noticeOf,
  type Sent,
} from "./notify.ts";
import { DEFAULT_PREFS, normalizePrefs, type PushPrefs } from "./push.ts";

export interface AlertSettings {
  /** 短い音を鳴らす */
  sound: boolean;
  /** 見出しを読み上げる */
  speech: boolean;
}

export const ALERT_OFF: AlertSettings = { sound: false, speech: false };

/** 覚えた値を読む。読めなければオフ */
export function parseAlertSettings(raw: string | null): AlertSettings {
  try {
    const o = JSON.parse(raw ?? "") as Partial<AlertSettings> | null;
    return { sound: o?.sound === true, speech: o?.speech === true };
  } catch {
    return { ...ALERT_OFF };
  }
}

/** 覚えた条件を読む。読めなければ既定 (Web Push と同じ既定) */
export function parseAlertPrefs(raw: string | null): PushPrefs {
  try {
    return raw ? normalizePrefs(JSON.parse(raw)) : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/**
 * 鳴らすかを決めて控える。鳴らすなら通知の中身を返す。
 * 控え (`sent`) は Web Push の push_log と同じく、送ったときだけ書き、重さは大きいほうを残す。
 */
export function alertFor(
  e: SonaeEvent,
  now: number,
  prefs: PushPrefs,
  sent: Map<string, Sent>,
): Notice | null {
  const n = noticeOf(e, now);
  if (!n) return null;
  const prev = sent.get(n.tag);
  const digest = contentOf(n);
  const p = decide(n, prefs, prev, digest);
  if (!p.send) return null;
  sent.set(n.tag, { level: Math.max(prev?.level ?? 0, n.level), digest });
  return p.renotify ? n : null;
}

/** 読み上げる字。括弧は読ませず、間を置くだけにする */
export const spokenText = (title: string) =>
  title
    .replace(/[()（）]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
