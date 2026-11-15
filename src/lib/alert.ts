/**
 * 開いているときの通知・音・読み上げの、DOM を使わない部分 (docs/design.md の 2.4)。
 * 知らせる判定は Web Push と同じ `#lib/notify.ts` の noticeOf・decide を使う。鳴らすのは `alerter.svelte.ts`。
 */

import type { SonaeEvent } from "./model.ts";
import {
  contentOf,
  decide,
  type Notice,
  noticeFor,
  noticeOf,
  payloadOf,
  type Sent,
} from "./notify.ts";
import {
  DEFAULT_PREFS,
  normalizePrefs,
  type NotificationShape,
  type PushPrefs,
  toNotification,
} from "./push.ts";

export interface AlertSettings {
  /** 短い音を鳴らす */
  sound: boolean;
  /** 読み上げる */
  speech: boolean;
  /** 読み上げの声 (VOICEVOX のスタイルの id)。無ければサーバーの既定の声 */
  voice?: number;
  /** OS の通知を出す。無ければ既定 (通知の許可があれば出す)。許可が無ければ、オンでも出せない */
  notify?: boolean;
}

export const ALERT_OFF: AlertSettings = { sound: false, speech: false };

/** 覚えた値を読む。読めなければオフ (通知は既定のまま) */
export function parseAlertSettings(raw: string | null): AlertSettings {
  try {
    const o = JSON.parse(raw ?? "") as Partial<AlertSettings> | null;
    const s: AlertSettings = {
      sound: o?.sound === true,
      speech: o?.speech === true,
    };
    if (Number.isInteger(o?.voice) && (o?.voice ?? -1) >= 0) s.voice = o?.voice;
    if (typeof o?.notify === "boolean") s.notify = o.notify;
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

/** 通知の許可。Notification が無いブラウザは "unsupported" */
export type Permission = NotificationPermission | "unsupported";

/**
 * 開いているときに OS の通知を出すか。許可があり、スイッチを切っていないとき (既定はオン)。
 * 許可は人が「通知」の窓で操作したときにだけ求める (ここでは求めない)
 */
export const notifyOn = (s: AlertSettings, permission: Permission): boolean =>
  permission === "granted" && s.notify !== false;

/** 知らせると決めた事象と、鳴らすか (鳴らさないときは、出ている通知を置き換えるだけ) */
export interface AlertPlan {
  notice: Notice;
  renotify: boolean;
}

/**
 * 知らせるかを決めて控える。控え (`sent`) は Web Push の push_log と同じく、送ったときだけ書き、
 * 重さは大きいほうを残す。鳴らさない続報 (取消・解除・震源が決まった) も、通知の置き換えのために返す
 */
export function planAlert(
  e: SonaeEvent,
  now: number,
  prefs: PushPrefs,
  sent: Map<string, Sent>,
): AlertPlan | null {
  const base = noticeOf(e, now);
  // 気象は住んでいる地域で中身が変わる (Web Push と同じく、条件ごとに作る)
  const n = base ? noticeFor(base, prefs) : null;
  if (!n) return null;
  const prev = sent.get(n.tag);
  const digest = contentOf(n);
  const p = decide(n, prefs, prev, digest);
  if (!p.send) return null;
  sent.set(n.tag, { level: Math.max(prev?.level ?? 0, n.level), digest });
  return { notice: n, renotify: p.renotify };
}

/** 鳴らすかを決めて控える。鳴らすなら通知の中身を返す (Web Push が鳴らす所と同じ) */
export function alertFor(
  e: SonaeEvent,
  now: number,
  prefs: PushPrefs,
  sent: Map<string, Sent>,
): Notice | null {
  const p = planAlert(e, now, prefs, sent);
  return p?.renotify ? p.notice : null;
}

/**
 * 開いている画面が出す通知の形。中身・tag・押したときの URL・残すかは Web Push と同じ
 * (`payloadOf`・`toNotification`)。`silent` は、画面が自分で音 (チャイム) を鳴らしたときに
 * OS の通知音を重ねないためのもの
 */
export function pageNotification(
  n: Notice,
  renotify: boolean,
  silent: boolean,
): NotificationShape {
  const shape = toNotification(payloadOf(n, renotify));
  return { title: shape.title, options: { ...shape.options, silent } };
}

/**
 * ブラウザが音を止めている間に、画面の上の端に出す帯の文。何が止まっていて、何は届くかを言う。
 * `stopped` は止まっているもの (オンにしているもの)、`notifying` は OS の通知が出せるか
 */
export function mutedText(
  stopped: { sound: boolean; speech: boolean },
  notifying: boolean,
): { head: string; body: string } {
  const what =
    stopped.sound && stopped.speech
      ? "音と読み上げ"
      : stopped.speech
        ? "読み上げ"
        : "音";
  return {
    head: `${what}が止まっています`,
    body: notifying
      ? `通知は出ます。${what}も聞くなら押してください`
      : `押すと、警報を${what}で知らせます`,
  };
}

/**
 * 操作の前でも音を出せるか。Firefox は `navigator.getAutoplayPolicy` で分かる。無いブラウザは、
 * 作った AudioContext がすぐ動くか (自動再生を許していなければ suspended で作られる) で見る。
 * 分からなければ出せないとみなす (帯を出す側に倒す。鳴らすのに失敗したときも出る)。
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
