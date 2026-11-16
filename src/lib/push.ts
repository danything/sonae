/**
 * Web Push の、画面・サーバー・Service Worker のどれからも使う決めごと (docs/design.md の 2.4)。
 * どこからでも読むので、DOM や Worker にしか無いものは使わない。
 */

import { type Intensity, isIntensity } from "./model.ts";

/**
 * 種類ごとに選ぶ、どこのものを知らせるか (持ち主の決定、2026-11-16。docs/design.md の 2.4 の表)。
 * 全国のもの / 住んでいる地域と現在地のものだけ / 知らせない。何の段から知らせるか (注意報も など) は
 * 選ばせず、`#lib/notify.ts` の既定値で決める。地震の震度だけは選べる (`quakeMin`)
 */
export const SCOPES = ["everywhere", "nearby", "off"] as const;
export type Scope = (typeof SCOPES)[number];

/** 範囲を選ぶ種類 (画面に並べる順) */
export const SCOPE_KINDS = [
  "eew",
  "quake",
  "tsunami",
  "volcano",
  "weather",
] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/**
 * 住んでいる地域。1 つの市町村等 (気象警報等) を選び、どの種類の「住んでいる地域」にも使う。
 * 地震情報／細分区域・府県予報区・一次細分区域・津波予報区は、選んだときに画面が市町村等の表
 * (`static/areas/cities.json`) から引いて一緒に持つ (サーバーと Service Worker が表を読まずに判定できるように)。
 * 緯度・経度は持たない。開いている画面の現在地 (`alerter.here`) も同じ形
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
  /**
   * 沿岸が入る津波予報区 (海に面していなければ空)。2026-11-16 より前に覚えた住んでいる地域には無く、
   * 無いときは分からないので、津波はどの予報区でも当たるとみなす (知らせない側に倒さない)。
   * 画面を開けば表から引き直して覚え直す
   */
  tsunami?: { code: string; name: string }[];
}

/**
 * 端末 (ブラウザの購読) ごとに選ぶ、何を知らせるか。種類ごとに範囲 (`Scope`) を 1 つ選ぶ。
 * 南海トラフ地震臨時情報等と、どこかの気象の特別警報は選ばせず、いつも知らせる
 * (持ち主の決定、2026-11-16。docs/design.md の 2.4)。前の形の段 (`quakeMinInt`・`areaMinInt`・
 * 津波の `watch` など) は `normalizePrefs` が新しい範囲に読み替える
 */
export interface PushPrefs {
  /** 住んでいる地域。無ければ「住んでいる地域と現在地」は現在地だけ (開いている画面だけ) で見る */
  home: Home | null;
  eew: Scope;
  quake: Scope;
  /**
   * 地震を知らせる震度 (範囲の下に 1 つだけ選ぶ。2026-11-16 に戻した)。「全国」ならどこかの最大震度、
   * 「住んでいる地域と現在地」ならそこの震度で見る。選んでいなければ範囲ごとの既定
   * (全国 4・地域 3。`#lib/notify.ts` の `quakeMinOf`)
   */
  quakeMin?: Intensity;
  tsunami: Scope;
  volcano: Scope;
  weather: Scope;
}

/**
 * 既定値。前の既定 (緊急地震速報の警報・最大震度 4 以上・津波注意報以上・噴火速報と噴火警報は全国、
 * 気象は住んでいる地域の警報以上) と同じものを知らせる範囲にした
 */
export const DEFAULT_PREFS: PushPrefs = {
  home: null,
  eew: "everywhere",
  quake: "everywhere",
  tsunami: "everywhere",
  volcano: "everywhere",
  weather: "nearby",
};

const code = (v: unknown, digits: number): string | null =>
  typeof v === "string" && new RegExp(`^\\d{${digits}}$`).test(v) ? v : null;
const label = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= 40 ? v : null;

/** 津波予報区の並びを読む。並びでなければ無し (前の形。分からない) */
function readTsunamiAreas(
  v: unknown,
): { code: string; name: string }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  // 1 つの市町村等に当たるのは多くて 2〜3。外から来た値の長さは、予報区の数 (66) までに抑える
  return v.slice(0, 66).flatMap((a) => {
    const o =
      typeof a === "object" && a !== null ? (a as Record<string, unknown>) : {};
    const c = code(o.code, 3);
    const n = label(o.name);
    return c && n ? [{ code: c, name: n }] : [];
  });
}

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
  const tsunami = readTsunamiAreas(o.tsunami);
  return {
    code: c,
    name,
    quake: qc && qn ? { code: qc, name: qn } : null,
    office: code(o.office, 6),
    ichiji: code(o.ichiji, 6),
    ...(tsunami ? { tsunami } : {}),
  };
}

/**
 * 範囲を読む。新しい形の値はそのまま、前の形の段は `old` で読み替える。読めなければ既定値。
 * 新しい値の名前は、前の形の値 (`all`・`warning` など) と重ならないようにしてある
 */
function scope(v: unknown, old: Record<string, Scope>, fallback: Scope): Scope {
  if ((SCOPES as readonly unknown[]).includes(v)) return v as Scope;
  return typeof v === "string" && Object.hasOwn(old, v)
    ? (old[v] ?? fallback)
    : fallback;
}

/** 範囲ごとの震度の既定 (前の既定の、最大震度 4 と住んでいる地域の震度 3) */
export const QUAKE_MIN_DEFAULT: Record<"everywhere" | "nearby", Intensity> = {
  everywhere: "4",
  nearby: "3",
};

/**
 * 地震の震度を読む。新しい形 (`quakeMin`) が無ければ、前の 2 つの段 (2026-11-16 の #180 より前の
 * `quakeMinInt`・`areaMinInt`) から、読み替えた範囲で使っていたほうを読む。
 * 範囲の既定と同じ値は持たない (既定のままなら、範囲を替えたときに替えた先の既定で見るように)。
 * 「知らせない」のときは、選んであった値を残す (範囲を戻したときに使う)
 */
function readQuakeMin(
  o: Record<string, unknown>,
  quake: Scope,
): Intensity | undefined {
  if (quake === "off") return isIntensity(o.quakeMin) ? o.quakeMin : undefined;
  const v = isIntensity(o.quakeMin)
    ? o.quakeMin
    : quake === "everywhere"
      ? o.quakeMinInt
      : o.areaMinInt;
  return isIntensity(v) && v !== QUAKE_MIN_DEFAULT[quake] ? v : undefined;
}

/** 選んだ範囲で使う震度 (選んでいなければ範囲の既定) */
export const quakeMinOf = (p: Pick<PushPrefs, "quake" | "quakeMin">) =>
  p.quakeMin ??
  QUAKE_MIN_DEFAULT[p.quake === "nearby" ? "nearby" : "everywhere"];

/** 震度を選んだ値にする。範囲の既定と同じなら持たない (`readQuakeMin` と同じ決まり) */
export function withQuakeMin(p: PushPrefs, v: Intensity): PushPrefs {
  const { quakeMin: _, ...rest } = p;
  return p.quake !== "off" && v === quakeMinOf({ quake: p.quake })
    ? rest
    : { ...rest, quakeMin: v };
}

/**
 * 外から来た値を、知っている形に直す。読めない項目は既定値に戻す。
 * DB の購読・Webhook・端末の localStorage・API の本文のどれもここを通すので、前の形の値もここで読み替える
 * (2026-11-16 の作り替え。docs/design.md の 2.4 の「前の形の読み替え」)
 */
export function normalizePrefs(input: unknown): PushPrefs {
  const o =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  // 前の形の「現在地」(地震情報の細分区域だけ。area) は市町村等が分からないので読まない (選び直してもらう)。
  // 前のスイッチ (advisory・weatherSpecial) も読まない (いつも知らせる。2026-11-16)
  const off = { off: "off" } as const;
  // 地震は前の 2 つの段から読む。最大震度の条件があれば全国、「知らせない」で住んでいる地域の震度だけなら地域
  const oldQuake =
    o.quakeMinInt === "off"
      ? "nearby"
      : isIntensity(o.quakeMinInt)
        ? "everywhere"
        : undefined;
  const quake = scope(o.quake, {}, oldQuake ?? DEFAULT_PREFS.quake);
  const quakeMin = readQuakeMin(o, quake);
  return {
    home: readHome(o.home),
    // 前は 警報だけ / 予報も / 送らない。どちらの段も予報を知らせる「全国」にする (2.4)
    eew: scope(
      o.eew,
      { ...off, warning: "everywhere", all: "everywhere" },
      DEFAULT_PREFS.eew,
    ),
    quake,
    ...(quakeMin ? { quakeMin } : {}),
    // 前は 注意報以上 / 警報以上 / 大津波警報だけ / 送らない。どれも全国のものだった
    tsunami: scope(
      o.tsunami,
      {
        ...off,
        watch: "everywhere",
        warning: "everywhere",
        major: "everywhere",
      },
      DEFAULT_PREFS.tsunami,
    ),
    // 前は 噴火速報と噴火警報 / 火口周辺警報も / 送らない。どれも全国のものだった
    volcano: scope(
      o.volcano,
      { ...off, warning: "everywhere", all: "everywhere" },
      DEFAULT_PREFS.volcano,
    ),
    // 前は住んでいる地域の 警報以上 / 注意報も / 送らない。どちらも注意報から知らせる「住んでいる地域と現在地」(2.4)
    weather: scope(
      o.weather,
      { ...off, warning: "nearby", all: "nearby" },
      DEFAULT_PREFS.weather,
    ),
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

/**
 * 受け付ける配信サービス。購読の endpoint はブラウザから来るので、任意の宛先へサーバーから
 * POST させないよう、主なブラウザの配信サービスだけに絞る (Chrome・Edge は FCM、Firefox は
 * Mozilla、Safari は Apple、旧 Edge は WNS)。画面も、登録する前に同じ決まりで見る
 * (届かない宛先を返すブラウザに、黙って登録させない)
 */
export const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

/** 購読の endpoint が、受け付ける配信サービスの https の URL か */
export function pushEndpointOk(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "") return false;
  return PUSH_HOSTS.some(
    (h) => url.hostname === h || url.hostname.endsWith(`.${h}`),
  );
}
