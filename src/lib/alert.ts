/**
 * 開いているときの音と読み上げの、DOM を使わない部分 (docs/design.md の 2.4)。
 * 鳴らす判定は Web Push と同じ `#lib/notify.ts` の noticeOf・decide を使う。鳴らすのは `alerter.svelte.ts`。
 */

import type { SonaeEvent } from "./model.ts";
import {
  contentOf,
  decide,
  type Notice,
  noticeFor,
  noticeOf,
  type Sent,
} from "./notify.ts";
import { DEFAULT_PREFS, normalizePrefs, type PushPrefs } from "./push.ts";

export interface AlertSettings {
  /** 短い音を鳴らす */
  sound: boolean;
  /** 読み上げる */
  speech: boolean;
  /** 読み上げの声 (VOICEVOX のスタイルの id)。無ければサーバーの既定の声 */
  voice?: number;
}

export const ALERT_OFF: AlertSettings = { sound: false, speech: false };

/** 覚えた値を読む。読めなければオフ */
export function parseAlertSettings(raw: string | null): AlertSettings {
  try {
    const o = JSON.parse(raw ?? "") as Partial<AlertSettings> | null;
    const s: AlertSettings = {
      sound: o?.sound === true,
      speech: o?.speech === true,
    };
    if (Number.isInteger(o?.voice) && (o?.voice ?? -1) >= 0) s.voice = o?.voice;
    return s;
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
  const base = noticeOf(e, now);
  // 気象は住んでいる地域で中身が変わる (Web Push と同じく、条件ごとに作る)
  const n = base ? noticeFor(base, prefs) : null;
  if (!n) return null;
  const prev = sent.get(n.tag);
  const digest = contentOf(n);
  const p = decide(n, prefs, prev, digest);
  if (!p.send) return null;
  sent.set(n.tag, { level: Math.max(prev?.level ?? 0, n.level), digest });
  return p.renotify ? n : null;
}

/**
 * 操作の前でも音を出せるか。Firefox は `navigator.getAutoplayPolicy` で分かる。無いブラウザは、
 * 作った AudioContext がすぐ動くか (自動再生を許していなければ suspended で作られる) で見る。
 * 分からなければ出せないとみなす (「音を出す」を出す側に倒す。鳴らすのに失敗したときも出る)。
 * テストで差し替えられるよう、navigator と AudioContext は引数で受ける
 */
export function autoplayAllowed(
  nav: object | undefined,
  Ctx: (new () => { state: string; close(): Promise<void> }) | undefined,
): boolean {
  try {
    const policy = (
      nav as
        { getAutoplayPolicy?: (type: "mediaelement") => string } | undefined
    )?.getAutoplayPolicy;
    if (policy) return policy.call(nav, "mediaelement") === "allowed";
    if (!Ctx) return false;
    const ctx = new Ctx();
    const running = ctx.state === "running";
    void ctx.close().catch(() => {});
    return running;
  } catch {
    return false;
  }
}
