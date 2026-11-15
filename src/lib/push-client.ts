/**
 * 通知の条件を覚えて送る道と、住んでいる地域を探す道 (画面だけで使う)。
 * 「通知」の窓 (`PushSettings.svelte`) と、地図の右クリック・長押しのメニュー (`QuakeMap.svelte`) が同じものを使う。
 *
 * - 条件はすぐ端末に覚え (`alerter.setPrefs`)、このブラウザが Web Push に登録してあればサーバーにも送る。
 *   続けて変えたときに前の送信と追い越さないよう、送るのは 1 つずつ順に (`queuePrefs`)
 * - 住んでいる地域は、緯度・経度が入る市町村等を端末の中で探す (`#lib/home.ts` の `cityAt`・`homeOf`)。
 *   **緯度・経度はサーバーに送らず、覚えもしない**。送るのは市町村等のコードと、そこから引いた地域だけ
 */

import { alerter } from "./alerter.svelte.ts";
import { type Cities, cityAt, homeOf } from "./home.ts";
import { createQueue } from "./prefs-queue.ts";
import {
  base64UrlToBytes,
  type Home,
  normalizePrefs,
  type PushPrefs,
} from "./push.ts";

export interface Registered {
  endpoint: string;
  label: string;
  prefs: PushPrefs;
  createdAt: number;
}

export type PushInfo =
  | { enabled: false }
  | { enabled: true; publicKey: string; subscriptions: Registered[] };

/** ブラウザが Web Push を使えるか */
export const pushSupported = (): boolean =>
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

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
    const granted = (await Notification.requestPermission()) === "granted";
    alerter.refreshPermission();
    if (!granted)
      return "通知が許可されていません。ブラウザのサイトの設定で許可してください。";
    const sub = await subscribe(publicKey);
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
    return `登録できませんでした: ${err}`;
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

let areasLoad: Promise<Parameters<typeof cityAt>[2]> | undefined;
function loadWarningAreas(): Promise<Parameters<typeof cityAt>[2]> {
  areasLoad ??= fetch("/areas/warning-areas.geojson")
    .then(
      (r) => r.json() as Promise<{ features: Parameters<typeof cityAt>[2] }>,
    )
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

/**
 * 住んでいる地域を変えて覚える (地図のメニューから)。条件のほかの所は、このブラウザが Web Push に
 * 登録してあればサーバーの条件、無ければ端末に覚えた条件のまま。返すのは知らせる文
 */
export async function saveHome(home: Home): Promise<string> {
  let state: Awaited<ReturnType<typeof readPushState>> | undefined;
  try {
    state = await readPushState();
  } catch {
    // サーバーの登録を読めなくても、端末には覚える
  }
  const info = state?.info;
  const mine = info?.enabled
    ? info.subscriptions.find((s) => s.endpoint === state?.endpoint)
    : undefined;
  const prefs = normalizePrefs({
    ...(mine ? mine.prefs : alerter.prefs),
    home,
  });
  alerter.setPrefs(prefs);
  const done = `${home.name}を住んでいる地域にしました`;
  if (!mine || !info?.enabled) return done;
  const result = await queuePrefs(() => sendPrefs(info.publicKey, prefs));
  return result === null || result === "保存しました"
    ? done
    : `${done}。${result}`;
}
