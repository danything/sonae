/**
 * 開いているときの通知・音・読み上げの、DOM を使わない部分 (docs/design.md の 2.4)。
 * 知らせる判定は Web Push と同じ `#lib/notify.ts` の noticeOf・decideDaily (`decide` に注意報の 1 日 1 回を足したもの) を使う。鳴らすのは `alerter.svelte.ts`。
 */

import {
  isTsunamiActive,
  latestPerVolcano,
  type SonaeEvent,
  type Tsunami,
  type Volcano,
  type WeatherWarning,
} from "./model.ts";
import {
  ADVISORY_QUOTA,
  advisoryQuotaTag,
  contentOf,
  decideDaily,
  hereNoticeFor,
  keptLevel,
  type Notice,
  noticeFor,
  noticeOf,
  noticesFor,
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

/**
 * 開いているときの音と読み上げ。画面では 1 つの選択 (オフ / 通知音だけ / 読み上げも) で、
 * 読み上げるときはいつも通知音も鳴らす (`speech` なら `sound` も立つ。持ち主の決定、2026-11-16)
 */
export interface AlertSettings {
  /** 短い音 (チャイム) を鳴らす */
  sound: boolean;
  /** 読み上げる (このときは `sound` も立つ) */
  speech: boolean;
  // 声は端末に持たない (この家で 1 つ。サーバーの DB。前の `voice` は読まない)
  /** OS の通知を出す。無ければ既定 (通知の許可があれば出す)。許可が無ければ、オンでも出せない */
  notify?: boolean;
  // 画面への配信が切れた・戻ったことはいつも知らせる (2026-11-16 からスイッチは無い。前の `outage` は読まない)
  // 現在地は、範囲の「住んでいる地域と現在地」でいつも使う (2026-11-16 からスイッチは無い。前の `here` は読まない)
}

export const ALERT_OFF: AlertSettings = { sound: false, speech: false };

/** 音と読み上げの選択 (「通知」の窓の 1 つの選択) */
export const AUDIO_MODES = ["off", "chime", "speech"] as const;
export type AudioMode = (typeof AUDIO_MODES)[number];

export const AUDIO_LABEL: Record<AudioMode, string> = {
  off: "オフ",
  chime: "通知音だけ",
  speech: "読み上げも",
};

/** いまの設定がどの選択か */
export const audioModeOf = (s: AlertSettings): AudioMode =>
  s.speech ? "speech" : s.sound ? "chime" : "off";

/** 選択を設定にする (ほかの項目はそのまま) */
export const withAudioMode = (
  s: AlertSettings,
  mode: AudioMode,
): AlertSettings => ({
  ...s,
  sound: mode !== "off",
  speech: mode === "speech",
});

/**
 * 覚えた値を読む。読めなければオフ (通知は既定のまま)。前の形は音と読み上げが別のスイッチで、
 * 読み上げだけ (音はオフ) にもできた。その値は「読み上げも」(音も鳴らす) に読み替える
 */
export function parseAlertSettings(raw: string | null): AlertSettings {
  try {
    const o = JSON.parse(raw ?? "") as Partial<AlertSettings> | null;
    const speech = o?.speech === true;
    const s: AlertSettings = { sound: speech || o?.sound === true, speech };
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
  // 気象は住んでいる地域で中身が変わる (Web Push と同じく、条件ごとに作る)。気象のほかの種類は
  // 通知が 1 つで、「住んでいる地域と現在地」の判定に現在地も使う (mark が decide に渡す)。
  // 府県予報区ごとに知らせる段が終わったことを伝える通知も足す (Web Push と同じ `noticesFor`)
  const own = noticesFor(base, prefs, here);
  const notices: { notice: Notice; quiet: boolean }[] = own.map((notice) => ({
    notice,
    quiet: false,
  }));
  if (
    here &&
    here.code !== prefs.home?.code &&
    !(e.type === "weather" && own.length > 0)
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
    const p = mark(n, prefs, sent, here, now);
    if (p) plans.push(quiet ? { ...p, renotify: false } : p);
  }
  return plans;
}

/**
 * 知らせるかを決め、知らせるなら控える (重さは Web Push の push_log と同じく `keptLevel`)。
 * 注意報だけの通知は 1 日 1 回まで (`decideDaily`。数えた日も `sent` に、`ADVISORY_QUOTA` の tag で持つ)
 */
function mark(
  n: Notice,
  prefs: PushPrefs,
  sent: Map<string, Sent>,
  here: Home | null,
  now: number,
): AlertPlan | null {
  const prev = sent.get(n.tag);
  const digest = contentOf(n);
  const qTag = advisoryQuotaTag(n);
  const p = decideDaily(n, prefs, prev, digest, here, sent.get(qTag), now);
  if (!p.send) return null;
  // Map は書き直しても並びが変わらないので、消してから足す。古い控えから捨てる (`trimSent`) ときに、
  // 長く続く事象 (津波・気象) の控えを先に捨てて、次の続報を初めてとして鳴らさないため
  sent.delete(n.tag);
  sent.set(n.tag, { level: keptLevel(prev, n), digest });
  if (p.day) {
    // 数えた日の控えも同じく、いちばん新しい所へ置き直す
    sent.delete(qTag);
    sent.set(qTag, { level: 0, digest: p.day });
  }
  return { notice: n, renotify: p.renotify };
}

/**
 * 端末に注意報を数えた日を持つ localStorage の鍵 (`readPref` の形。`sonae.alert.quota`)。
 * 開き直しても、タブをまたいでも 1 日 1 回にする
 */
export const QUOTA_KEY = "alert.quota";

/** localStorage の値から、数えた日を控えに入れる (控えの日のほうが新しければそのまま) */
export function loadQuota(raw: string | null, sent: Map<string, Sent>): void {
  let o: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(raw ?? "{}");
    if (typeof v === "object" && v !== null) o = v as Record<string, unknown>;
  } catch {
    return;
  }
  for (const tag of Object.values(ADVISORY_QUOTA)) {
    const day = o[tag];
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const mine = sent.get(tag)?.digest;
    if (mine === undefined || mine < day) {
      sent.delete(tag);
      sent.set(tag, { level: 0, digest: day });
    }
  }
}

/** 控えから、localStorage に書く値を作る */
export function quotaJson(sent: Map<string, Sent>): string {
  const o: Record<string, string> = {};
  for (const tag of Object.values(ADVISORY_QUOTA)) {
    const day = sent.get(tag)?.digest;
    if (day) o[tag] = day;
  }
  return JSON.stringify(o);
}

/** 画面が持ついまの状態のうち、現在地に入ったときに見るもの */
export interface Present {
  warnings: readonly WeatherWarning[];
  tsunamis: readonly Tsunami[];
  volcanoes: readonly Volcano[];
}

/**
 * いま出ているもの (現在地に入ったときに知らせるか見るもの)。気象警報・注意報 (府県予報区と種別ごとの
 * 最新の報)、まだ終わっていない津波、火山ごとのいまの噴火警報・予報。古さは見ない (出たままなら出ている)
 */
export function presentEvents(p: Present, now: number): SonaeEvent[] {
  return [
    ...p.warnings.map((data): SonaeEvent => ({
      seq: 0,
      type: "warning",
      data,
    })),
    ...p.tsunamis
      .filter((t) => t.status === "normal" && isTsunamiActive(t, now))
      .map((data): SonaeEvent => ({ seq: 0, type: "tsunami", data })),
    ...latestPerVolcano([...p.volcanoes]).map((data): SonaeEvent => ({
      seq: 0,
      type: "volcano",
      data,
    })),
  ];
}

/** 報の時刻 (noticeOf が古さを見る時刻。いま出ているものは古くても知らせるので、これを「いま」として渡す) */
function timeOf(e: SonaeEvent): number {
  switch (e.type) {
    case "warning":
      return Date.parse(e.data.reportedAt);
    case "tsunami":
      return Date.parse(e.data.issuedAt);
    case "volcano":
      return Date.parse(e.data.eventTime ?? e.data.reportedAt);
    default:
      return Number.NaN;
  }
}

/**
 * 現在地が別の市町村等に替わったとき、そこにもう出ているものを知らせるかを決めて控える
 * (`events` は `presentEvents` で作った、いま出ているもの)。
 * - 気象警報・注意報は、現在地の通知 (`hereNoticeFor`) を作る。段は `planAlerts` と同じ (注意報以上。注意報だけの通知は 1 日 1 回まで)
 * - 津波・火山は全国と同じ通知 (同じ tag) で、範囲の判定に現在地を使う。まだ知らせていなければ、ここで初めて知らせる
 *
 * 同じ中身は控えで 1 度だけなので、境目で行き来しても、戻ってきても鳴らし直さない。出たままのものは、
 * 報が古くても (6 時間を過ぎても) 出ているので知らせる。住んでいる地域と同じ市町村等なら足さない
 * (住んでいる地域の通知で知らせている)
 */
export function planEntry(
  events: readonly SonaeEvent[],
  prefs: PushPrefs,
  sent: Map<string, Sent>,
  here: Home,
  now: number = Date.now(),
): AlertPlan[] {
  if (here.code === prefs.home?.code) return [];
  const plans: AlertPlan[] = [];
  for (const e of events) {
    // 古さは見ない (いま出ているもの)。訓練・試験は noticeOf が外す
    const base = noticeOf(e, timeOf(e));
    if (!base) continue;
    const n =
      e.type === "warning"
        ? hereNoticeFor(base, prefs, here)
        : noticeFor(base, prefs, here);
    if (!n || n.closing) continue;
    const p = mark(n, prefs, sent, here, now);
    // 津波・火山の控えが前からあり中身も同じなら、mark が null を返す (もう知らせている)
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
