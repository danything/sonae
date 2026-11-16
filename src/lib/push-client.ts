/**
 * 通知の条件を覚えて送る道と、住んでいる地域を探す道 (画面だけで使う)。
 * 「通知」の窓 (`PushSettings.svelte`) と、地図の右クリック・長押しのメニュー (`QuakeMap.svelte`) が同じものを使う。
 *
 * - 条件はすぐ端末に覚え (`alerter.setPrefs`)、このブラウザが Web Push に登録してあればサーバーにも送る。
 *   続けて変えたときに前の送信と追い越さないよう、送るのは 1 つずつ順に (`queuePrefs`)
 * - 住んでいる地域は、緯度・経度が入る市町村等を端末の中で探す (`#lib/home.ts` の `cityAt`・`homeOf`)。
 *   **緯度・経度はサーバーに送らず、覚えもしない**。送るのは市町村等のコードと、そこから引いた地域だけ
 * - 地図の現在地が入る市町村等も同じ道で探し、開いているときの気象の通知に使う (`trackHere`)。
 *   これはサーバーに送らず、端末にも覚えない
 */

import { untrack } from "svelte";

import { alerter } from "./alerter.svelte.ts";
import {
  type AreaFeature,
  type Cities,
  cityAt,
  createHereFinder,
  homeOf,
  planHomeSave,
} from "./home.ts";
import { live } from "./live.svelte.ts";
import { createQueue } from "./prefs-queue.ts";
import {
  endpointBlock,
  permissionDeniedText,
  type PushBlock,
  pushBlockOf,
  pushBlockText,
  type PushFeatures,
  QUIET_DENY_MS,
  registerFailedText,
} from "./push-support.ts";
import { base64UrlToBytes, type Home, type PushPrefs } from "./push.ts";
import { syncWebhookPrefs } from "./webhook-client.ts";

export interface Registered {
  endpoint: string;
  label: string;
  prefs: PushPrefs;
  createdAt: number;
}

export type PushInfo =
  | { enabled: false }
  | { enabled: true; publicKey: string; subscriptions: Registered[] };

/** このブラウザにある、Web Push に要る機能 */
export const pushFeatures = (): PushFeatures => ({
  serviceWorker: "serviceWorker" in navigator,
  pushManager: "PushManager" in window,
  notification: "Notification" in window,
  standalone:
    "standalone" in navigator
      ? (navigator as { standalone?: boolean }).standalone === true
      : undefined,
});

/** ブラウザが Web Push を使えそうか (機能がそろっているか) */
export const pushSupported = (): boolean =>
  pushBlockOf(pushFeatures()) === null;

/**
 * 登録してみて分かった、届かない宛先 (Android の Edge など)。このページを開いている間は覚えておき、
 * 窓を開き直しても「このブラウザで受ける」を出さない
 */
let endpointBlocked: PushBlock | null = null;

/** Web Push を使えない訳 (機能が無い・届かない宛先を返した)。使えそうなら null */
export const pushBlock = (): PushBlock | null =>
  pushBlockOf(pushFeatures()) ?? endpointBlocked;

/** サーバーの Web Push の登録と、このブラウザの購読の endpoint (無ければ undefined) */
export async function readPushState(): Promise<{
  info: PushInfo;
  endpoint: string | undefined;
}> {
  const res = await fetch("/api/push");
  if (!res.ok)
    throw new Error(`Web Push の登録を読めませんでした (${res.status})`);
  const info = (await res.json()) as PushInfo;
  if (!info.enabled || !pushSupported()) return { info, endpoint: undefined };
  const sub = await (
    await navigator.serviceWorker.ready
  ).pushManager.getSubscription();
  // 前に作った購読が届かない宛先なら、覚えて消す (サーバーには登録されていないので、ブラウザにだけ残っている)
  const bad = sub ? endpointBlock(sub.endpoint) : null;
  if (sub && bad) {
    endpointBlocked ??= bad;
    await sub.unsubscribe().catch(() => false);
    return { info, endpoint: undefined };
  }
  return { info, endpoint: sub?.endpoint };
}

/** 公開鍵が替わっていたら、購読を作り直す (古い鍵の購読には送れない) */
export async function subscribe(key: string): Promise<PushSubscription> {
  const pm = (await navigator.serviceWorker.ready).pushManager;
  const want = base64UrlToBytes(key);
  const cur = await pm.getSubscription();
  if (cur) {
    const have = cur.options.applicationServerKey;
    const same =
      have !== null &&
      new Uint8Array(have).length === want.length &&
      new Uint8Array(have).every((b, i) => b === want[i]);
    if (same) return cur;
    await cur.unsubscribe();
  }
  return pm.subscribe({ userVisibleOnly: true, applicationServerKey: want });
}

/**
 * 条件をサーバーに送り、結果の文を返す (画面には書かない。どこに出すかは呼ぶ側が決める)。
 * 通知の許可が無ければ聞く (「このブラウザで受ける」の操作の中で呼ぶ)
 */
export async function sendPrefs(
  publicKey: string,
  prefs: PushPrefs,
): Promise<string> {
  try {
    const asked = Notification.permission === "default";
    const t0 = performance.now();
    const granted = (await Notification.requestPermission()) === "granted";
    alerter.refreshPermission();
    if (!granted)
      return permissionDeniedText(navigator.userAgent, {
        asked,
        quiet: performance.now() - t0 < QUIET_DENY_MS,
      });
    const sub = await subscribe(publicKey);
    // 登録できても、届かない宛先を返すブラウザがある (Android の Edge は `permanently-removed.invalid`)。
    // サーバーに送っても断られるだけなので、ここで止めて、何ができないかと代わりの道を返す
    const block = endpointBlock(sub.endpoint);
    if (block) {
      endpointBlocked = block;
      await sub.unsubscribe().catch(() => false);
      return pushBlockText(block, navigator.userAgent);
    }
    alerter.setPrefs(prefs);
    const res = await fetch("/api/push", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subscription: sub.toJSON(),
        prefs,
        label: navigator.userAgent,
      }),
    });
    return res.ok
      ? "保存しました"
      : `保存できませんでした (${res.status}): ${await res.text()}`;
  } catch (err) {
    return registerFailedText(err);
  }
}

/** 条件を送る列。「通知」の窓と地図のメニューで 1 本を使う */
const queue = createQueue();

/** 送る仕事を順に並べる。返すのは、それが最後の 1 つだったときの結果 (後ろにまだ並んでいれば null) */
export const queuePrefs = queue.push;

/** 並んでいる送信が全部終わるのを待つ (窓を開き直したとき、送る途中の条件より古い条件を読まないように) */
export const prefsSettled = queue.settled;

// ---- 住んでいる地域を探す (市町村等の表と面。地図と同じファイルを、要るときに 1 度だけ読む) ----

let citiesLoad:
  Promise<{ cities: Cities; quakeNames: Map<string, string> }> | undefined;

/** 市町村等の表と、地震情報／細分区域の名前 */
export function loadCities(): Promise<{
  cities: Cities;
  quakeNames: Map<string, string>;
}> {
  citiesLoad ??= Promise.all([
    fetch("/areas/cities.json").then((r) => r.json() as Promise<Cities>),
    fetch("/areas/quake-areas.geojson").then(
      (r) =>
        r.json() as Promise<{
          features: { properties: { code: string; name: string } }[];
        }>,
    ),
  ]).then(([cities, quake]) => ({
    cities,
    quakeNames: new Map(
      quake.features.map((f) => [f.properties.code, f.properties.name]),
    ),
  }));
  // 読めなかったときは次に読み直す
  citiesLoad.catch(() => (citiesLoad = undefined));
  return citiesLoad;
}

let areasLoad: Promise<AreaFeature[]> | undefined;
function loadWarningAreas(): Promise<AreaFeature[]> {
  areasLoad ??= fetch("/areas/warning-areas.geojson")
    .then((r) => r.json() as Promise<{ features: AreaFeature[] }>)
    .then((fc) => fc.features);
  areasLoad.catch(() => (areasLoad = undefined));
  return areasLoad;
}

/** 緯度・経度が入る市町村等を、住んでいる地域の形で返す。海の上や日本の外なら null */
export async function homeAt(lat: number, lon: number): Promise<Home | null> {
  const [{ cities, quakeNames }, features] = await Promise.all([
    loadCities(),
    loadWarningAreas(),
  ]);
  const code = cityAt(lat, lon, features);
  return code ? homeOf(code, cities, quakeNames) : null;
}

let hereFinder: ReturnType<typeof createHereFinder> | undefined;
/** 現在地を受けた回数。前の位置の探す途中に新しい位置が来たら、前のほうの答えを使わない */
let hereSeq = 0;

/**
 * 地図の現在地から、いる市町村等を `alerter.here` に入れる (開いているときの気象の通知に使う)。
 * 別の市町村等に入ったら、そこにもう出ている警報・注意報を知らせる (`alerter.moveHere`)。
 * 位置が無い (地図の現在地がオフ・まだ取れない) か、「現在地の気象も知らせる」を切っていれば空にする。
 * 前の市町村等の中にいる間は面を引き直さない (`createHereFinder`)。
 * **緯度・経度はサーバーに送らず、覚えもしない** (住んでいる地域と同じ)。`alerter.here` もメモリだけ
 */
export async function trackHere(
  at: { lat: number; lon: number } | undefined,
): Promise<void> {
  const seq = ++hereSeq;
  if (!at || alerter.settings.here === false) {
    // 地図の $effect の中から同期で呼ばれるので、読む状態を effect の依存にしない
    untrack(() => alerter.moveHere(null, live.warnings));
    return;
  }
  try {
    const [{ cities, quakeNames }, features] = await Promise.all([
      loadCities(),
      loadWarningAreas(),
    ]);
    if (seq !== hereSeq) return;
    hereFinder ??= createHereFinder(features);
    const code = hereFinder(at.lat, at.lon);
    if (code === (alerter.here?.code ?? null)) return;
    alerter.moveHere(
      code ? homeOf(code, cities, quakeNames) : null,
      live.warnings,
    );
  } catch {
    // 面を読めなければ、住んでいる地域だけで知らせる (次の位置で読み直す)
  }
}

/**
 * 住んでいる地域を変えて覚える (地図のメニューから)。条件のほかの所は、このブラウザが Web Push に
 * 登録してあればサーバーの条件、無ければ端末に覚えた条件のまま。返すのは知らせる文
 */
export async function saveHome(home: Home): Promise<string> {
  // 「通知」の窓で変えた条件をまだ送っている途中なら、それが終わってからサーバーの条件を読む
  // (古い条件に住んでいる地域だけを足して送り、窓で変えた所を戻さない)
  await prefsSettled();
  let state: Awaited<ReturnType<typeof readPushState>> | null = null;
  try {
    state = await readPushState();
  } catch {
    // サーバーの登録を読めなくても、端末には覚える (そう知らせる)
  }
  const plan = planHomeSave(state, alerter.prefs, home);
  alerter.setPrefs(plan.prefs);
  // Webhook にも同じ条件を使う (「通知」の窓で変えたときと同じ)
  const hook = syncWebhookPrefs(plan.prefs);
  const key = plan.publicKey;
  const result =
    key === null ? null : await queuePrefs(() => sendPrefs(key, plan.prefs));
  const failed = await hook;
  const note =
    result === null || result === "保存しました"
      ? plan.note
      : `${plan.note}。${result}`;
  return failed ? `${note}。${failed}` : note;
}
