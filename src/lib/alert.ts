/**
 * 開いているときの通知・音・読み上げの、DOM を使わない部分 (docs/design.md の 2.4)。
 * 知らせる判定は Web Push と同じ `#lib/notify.ts` の noticeOf・decide を使う。鳴らすのは `alerter.svelte.ts`。
 */

import type { SonaeEvent, WeatherWarning } from "./model.ts";
import {
  contentOf,
  decide,
  hereNoticeFor,
  type Notice,
  noticeFor,
  noticeOf,
  payloadOf,
  type Sent,
} from "./notify.ts";
import {
  DEFAULT_PREFS,
  type Home,
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
  // 声は端末に持たない (この家で 1 つ。サーバーの DB。前の `voice` は読まない)
  /** OS の通知を出す。無ければ既定 (通知の許可があれば出す)。許可が無ければ、オンでも出せない */
  notify?: boolean;
  /** 画面への配信が切れた・戻ったことを知らせる。無ければ既定 (知らせる) */
  outage?: boolean;
  /** 地図の現在地が入る市町村等の気象も知らせる。無ければ既定 (知らせる) */
  here?: boolean;
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
    if (typeof o?.notify === "boolean") s.notify = o.notify;
    if (typeof o?.outage === "boolean") s.outage = o.outage;
    if (typeof o?.here === "boolean") s.here = o.here;
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
  return planAlerts(e, now, prefs, sent, null)[0] ?? null;
}

/**
 * `planAlert` に、現在地の市町村等 (`here`) の気象の通知を足したもの。住んでいる地域と現在地の
 * それぞれで知らせるかを決めて控える (tag が違うので控えも別)。現在地が住んでいる地域と同じなら、
 * 住んでいる地域の通知だけ。記録的短時間大雨情報・竜巻注意情報は 1 つの報に地域が並ぶので、
 * 住んでいる地域が対象なら現在地は足さない。鳴らすのを 1 度にまとめるのは `groupAlerts`。
 *
 * `left` は前にいた (もう出た) 市町村等。そこで前に知らせたもの (控えのある tag) だけ、解除・続報で
 * 出ている通知を置き換える (鳴らさない。重さが上がっても、もういないので鳴らし直さない)
 */
export function planAlerts(
  e: SonaeEvent,
  now: number,
  prefs: PushPrefs,
  sent: Map<string, Sent>,
  here: Home | null,
  left: readonly Home[] = [],
): AlertPlan[] {
  const base = noticeOf(e, now);
  if (!base) return [];
  // 気象は住んでいる地域で中身が変わる (Web Push と同じく、条件ごとに作る)
  const home = noticeFor(base, prefs);
  const notices: { notice: Notice; quiet: boolean }[] = home
    ? [{ notice: home, quiet: false }]
    : [];
  if (
    here &&
    here.code !== prefs.home?.code &&
    !(e.type === "weather" && home)
  ) {
    const h = hereNoticeFor(base, prefs, here);
    if (h) notices.push({ notice: h, quiet: false });
  }
  for (const l of left) {
    if (l.code === here?.code || l.code === prefs.home?.code) continue;
    const h = hereNoticeFor(base, prefs, l, true);
    if (h && sent.has(h.tag)) notices.push({ notice: h, quiet: true });
  }
  const plans: AlertPlan[] = [];
  const seen = new Set<string>();
  for (const { notice: n, quiet } of notices) {
    // 記録的短時間大雨情報・竜巻注意情報は、地域が違っても同じ tag (先に並ぶほうだけ)
    if (seen.has(n.tag)) continue;
    seen.add(n.tag);
    const p = mark(n, prefs, sent);
    if (p) plans.push(quiet ? { ...p, renotify: false } : p);
  }
  return plans;
}

/** 知らせるかを決め、知らせるなら控える (Web Push の push_log と同じく、重さは大きいほうを残す) */
function mark(
  n: Notice,
  prefs: PushPrefs,
  sent: Map<string, Sent>,
): AlertPlan | null {
  const prev = sent.get(n.tag);
  const digest = contentOf(n);
  const p = decide(n, prefs, prev, digest);
  if (!p.send) return null;
  sent.set(n.tag, { level: Math.max(prev?.level ?? 0, n.level), digest });
  return { notice: n, renotify: p.renotify };
}

/**
 * 現在地が別の市町村等に替わったとき、そこにもう出ている気象警報・注意報を知らせるかを決めて控える
 * (`warnings` は画面が持ついまの警報・注意報。府県予報区と種別ごとの最新の報)。
 * 段は `planAlerts` と同じ (警報以上 / 注意報も)。同じ中身は控えで 1 度だけなので、境目で行き来しても、
 * 戻ってきても鳴らし直さない。出たままの警報は、報が古くても (6 時間を過ぎても) 出ているので知らせる。
 * 住んでいる地域と同じ市町村等なら足さない (住んでいる地域の通知で知らせている)
 */
export function planEntry(
  warnings: readonly WeatherWarning[],
  prefs: PushPrefs,
  sent: Map<string, Sent>,
  here: Home,
): AlertPlan[] {
  if (here.code === prefs.home?.code) return [];
  const plans: AlertPlan[] = [];
  for (const w of warnings) {
    const e: SonaeEvent = { seq: 0, type: "warning", data: w };
    // 古さは見ない (いま出ているもの)。訓練・試験は noticeOf が外す
    const base = noticeOf(e, Date.parse(w.reportedAt));
    const n = base ? hereNoticeFor(base, prefs, here) : null;
    if (!n || n.closing) continue;
    const p = mark(n, prefs, sent);
    if (p) plans.push(p);
  }
  return plans;
}

/** 1 つの報で鳴らすもの。鳴らすのは `ring` の 1 度で、`also` は音なしの通知と、読み上げに足す */
export interface AlertGroup {
  ring: Notice | null;
  also: Notice[];
  /** 鳴らさない続報 (出ている通知を置き換えるだけ) */
  replace: Notice[];
}

/**
 * 住んでいる地域と現在地の両方に当たった報を、1 度だけ鳴らす形にまとめる。重いほうを鳴らし、
 * 同じ重さなら住んでいる地域 (先に並ぶほう) を鳴らす
 */
export function groupAlerts(plans: AlertPlan[]): AlertGroup {
  const ringing = plans
    .filter((p) => p.renotify)
    .map((p) => p.notice)
    .toSorted((a, b) => b.level - a.level);
  return {
    ring: ringing[0] ?? null,
    also: ringing.slice(1),
    replace: plans.filter((p) => !p.renotify).map((p) => p.notice),
  };
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
