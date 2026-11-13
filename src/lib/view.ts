/**
 * 1 つの画面の「いま何を見ているか」。どれも URL の query に持つので、リンクを送ればそのまま開ける
 * (docs/ui.md の「URL」)。
 *
<<<<<<< HEAD
 * - `k` … 一覧の種類 (`quake` 地震・`tsunami` 津波・`eew` 緊急地震速報・`volcano` 火山・`info` お知らせ)。無ければ地震
 * - `q` / `t` / `e` / `v` / `i` … 選んだ地震 (id)・津波 (id)・緊急地震速報 (地震の識別番号)・火山の報 (id)・お知らせ (id)。1 つだけ
=======
 * - `k` … 一覧の種類 (`quake` 地震・`tsunami` 津波・`eew` 緊急地震速報・`volcano` 火山)。無ければ地震
 * - `q` / `t` / `e` / `v` … 選んだ地震 (id)・津波 (id)・緊急地震速報 (地震の識別番号)・火山の報 (id)。1 つだけ
>>>>>>> origin/main
 * - `training=1` … 緊急地震速報の訓練・試験も出す
 * - `about=1` … 「出典と注意」を開く
 */

<<<<<<< HEAD
export const KINDS = ["quake", "tsunami", "eew", "volcano", "info"] as const;
=======
export const KINDS = ["quake", "tsunami", "eew", "volcano"] as const;
>>>>>>> origin/main
export type Kind = (typeof KINDS)[number];

export const KIND_LABEL: Record<Kind, string> = {
  quake: "地震",
  tsunami: "津波",
  eew: "緊急地震速報",
  volcano: "火山",
<<<<<<< HEAD
  info: "お知らせ",
=======
>>>>>>> origin/main
};

export interface View {
  kind: Kind;
  /** 選んだもの (無ければ null) */
  selected: { kind: Kind; id: string } | null;
  training: boolean;
  about: boolean;
}

const SELECT_KEYS = {
  quake: "q",
  tsunami: "t",
  eew: "e",
  volcano: "v",
<<<<<<< HEAD
  info: "i",
=======
>>>>>>> origin/main
} as const satisfies Record<Kind, string>;
type SelectKey = (typeof SELECT_KEYS)[Kind];
const SELECT_PARAMS = Object.values(SELECT_KEYS) as SelectKey[];

/** 選んだものを外す patch (`viewHref` に渡す) */
export const UNSELECT = Object.fromEntries(
  SELECT_PARAMS.map((k) => [k, null]),
) as Record<SelectKey, null>;

/** 読むだけの問い合わせ (`page.url.searchParams` は書き換えられない形) */
type Params = Pick<URLSearchParams, "get" | "has" | "toString">;

export function readView(params: Params): View {
  let selected: View["selected"] = null;
  for (const kind of KINDS) {
    const id = params.get(SELECT_KEYS[kind]);
    if (id) {
      selected = { kind, id };
      break;
    }
  }
  const k = params.get("k");
  const kind: Kind = KINDS.includes(k as Kind)
    ? (k as Kind)
    : (selected?.kind ?? "quake");
  return {
    kind,
    selected,
    training: params.get("training") === "1",
    about: params.has("about"),
  };
}

/**
<<<<<<< HEAD
 * いまの query に `patch` を当てたリンク。`null` の鍵は外す。選ぶもの (`q`・`t`・`e`・`v`・`i`) は 1 つだけなので、
=======
 * いまの query に `patch` を当てたリンク。`null` の鍵は外す。選ぶもの (`q`・`t`・`e`・`v`) は 1 つだけなので、
>>>>>>> origin/main
 * どれかを入れたらほかは外す。既定の値 (`k=quake`) は書かない
 */
export function viewHref(
  params: Params,
  patch: Partial<Record<"k" | SelectKey | "training" | "about", string | null>>,
): string {
  const next = new URLSearchParams(params.toString());
  if (SELECT_PARAMS.some((key) => patch[key] !== undefined))
    for (const key of SELECT_PARAMS) next.delete(key);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) next.delete(key);
    else next.set(key, value);
  }
  if (next.get("k") === "quake") next.delete("k");
  const query = next.toString();
  return query === "" ? "/" : `/?${query}`;
}

/** 選ぶリンク (一覧の種類もそれに合わせる) */
export const selectHref = (params: Params, kind: Kind, id: string) =>
  viewHref(params, { k: kind, [SELECT_KEYS[kind]]: id });

/**
 * 前の画面の URL を、1 つの画面の URL に読み替える。読み替えるものが無ければ null。
 * 共有したリンクとブックマークを生かすため (hooks.server.ts が 301 で送る)
 */
export function legacyRedirect(url: URL): string | null {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const params = url.searchParams;
  /** `/quakes/[id]` の id (1 段だけ。読めない % の並びは読み替えない) */
  const id = (prefix: string): string | null => {
    const rest = path.startsWith(prefix) ? path.slice(prefix.length) : "";
    if (rest === "" || rest.includes("/")) return null;
    try {
      return decodeURIComponent(rest);
    } catch {
      return null;
    }
  };
  const empty = new URLSearchParams();
  const quake = id("/quakes/");
  if (quake !== null) return selectHref(empty, "quake", quake);
  const tsunami = id("/tsunami/");
  if (tsunami !== null) return selectHref(empty, "tsunami", tsunami);
  switch (path) {
    case "/map": {
      const q = params.get("quake");
      return q ? selectHref(empty, "quake", q) : "/";
    }
    case "/tsunami":
      return viewHref(empty, { k: "tsunami" });
    case "/eew":
      return viewHref(empty, {
        k: "eew",
        training: params.get("training") === "1" ? "1" : null,
      });
    case "/about":
      return "/?about=1";
    default:
      return null;
  }
}

const dayFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 日本時間の日付 (`2026-11-13`)。読めない時刻は空 */
export function dayKey(iso: string | undefined): string {
  if (iso === undefined || !Number.isFinite(Date.parse(iso))) return "";
  const parts = dayFormat.formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 日付の見出し (`11 月 13 日 (木)`)。日付の鍵 (`dayKey`) から作る */
export function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return "日時の不明なもの";
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m} 月 ${d} 日 (${weekday})`;
}

/** 新しい順に並んだものを、日本時間の日ごとに束ねる (並びはそのまま) */
export function groupByDay<T>(
  items: T[],
  time: (item: T) => string | undefined,
): { day: string; items: T[] }[] {
  const groups: { day: string; items: T[] }[] = [];
  for (const item of items) {
    const day = dayKey(time(item));
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

/** 探す言葉に当たるか。空白で区切った言葉がどれも、どれかの字に入っていれば当たり */
export function matches(
  query: string,
  ...texts: (string | undefined)[]
): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = texts.filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}
