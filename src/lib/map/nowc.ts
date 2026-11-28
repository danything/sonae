/**
 * 雷・竜巻のナウキャストと今後の雨 (降水短時間予報)、線状降水帯の雨域。docs/map.md の「雷・竜巻」「今後の雨」「線状降水帯」。
 * 気象庁ホームページの画面が読むタイルと GeoJSON を、sonae のサーバーの中継 (`#lib/relay.ts`) を通して読む。公式の API ではなく、予告なく変わる。
 * どれも気象庁が解析・予測した 1 枚を色も値も変えずに重ねるだけで、sonae が先を予想することはしない (docs/design.md の 5 章)。
 * DOM にも MapLibre にも触らない (試験できるように)
 */

import { relayBase } from "#lib/relay.ts";

/** 気象庁の `https://www.jma.go.jp/bosai/jmatile/data` を、サーバーの中継を通して読む頭 */
export const JMATILE = relayBase("jmatile");
const NOWC = `${JMATILE}/nowc`;
const RASRF = `${JMATILE}/rasrf`;
/** 雷・竜巻・線状降水帯の時刻の表 (10 分ごと。新しい順。いまと 1 時間先までの予測) */
export const N3_TIMES_URL = `${NOWC}/targetTimes_N3.json`;
/** 今後の雨 (降水短時間予報) の時刻の表 */
export const RASRF_TIMES_URL = `${RASRF}/targetTimes.json`;
/** 気象庁ホームページの雨雲の動き (雷・竜巻・線状降水帯) と、今後の雨の画面 (凡例と出典のリンク) */
export const NOWC_PAGE = "https://www.jma.go.jp/bosai/nowc/";
export const RASRF_PAGE = "https://www.jma.go.jp/bosai/kaikotan/";

/**
 * 雷と竜巻のタイルのあるズーム。偶数で、8 まで (気象庁の画面の設定は `zoomUse="even"`・`maxNativeZoom` 9)。
 * ほかのズームは何も塗っていない空のタイル (334 バイト) が返る (2026-11-21 に確かめた)
 */
export const N3_TILE_ZOOMS = [4, 6, 8] as const;
/** 今後の雨のタイルのあるズーム (雨雲と同じく 4〜10 の偶数。画面の設定は `maxNativeZoom` 10) */
export const RASRF_TILE_ZOOMS = [4, 6, 8, 10] as const;

/**
 * 段ごとの層を出す地図のズーム (雨雲・キキクル・雷と竜巻・今後の雨で同じ)。MapLibre の地図のズーム z は 256px の
 * タイルの z + 1 を読むので、タイルのズーム n の段は地図のズーム n − 1 から n + 1 の手前まで (n − 1 で引き伸ばさずに
 * ちょうど合う)。最初の段は引いた側を、最後の段は寄せた側を切らない (最後の段を引き伸ばす)
 */
export function stepLayerZoom(
  n: number,
  zooms: readonly number[],
): { minzoom?: number; maxzoom?: number } {
  return {
    ...(n === zooms[0] ? {} : { minzoom: n - 1 }),
    ...(n === zooms.at(-1) ? {} : { maxzoom: n + 1 }),
  };
}

/** 雷・竜巻 (選ぶ図)。どちらも雷ナウキャスト・竜巻発生確度ナウキャストの解析の 1 枚 */
export interface NowcKind {
  id: "thunder" | "tornado";
  element: "thns" | "trns";
  label: string;
  pill: string;
  title: string;
  credit: string;
  legend: { color: string; label: string; note: string }[];
  about: string;
}

/**
 * 凡例。色は気象庁の画面の凡例 (`legend_jp_normal_thns.svg`・`legend_jp_normal_trns.svg`) とタイルのまま
 * (2026-11-21 に読んだ)。言葉は気象庁の雷ナウキャスト・竜巻発生確度ナウキャストの説明のまま
 */
export const NOWC_KINDS: NowcKind[] = [
  {
    id: "thunder",
    element: "thns",
    label: "雷 (いま)",
    pill: "雷 (いま)",
    title: "雷 (雷活動度)",
    credit: "気象庁 (雷ナウキャスト)",
    legend: [
      { color: "rgb(200 0 255)", label: "4", note: "激しい雷" },
      { color: "rgb(255 40 0)", label: "3", note: "やや激しい雷" },
      { color: "rgb(255 170 0)", label: "2", note: "雷あり" },
      { color: "rgb(255 245 0)", label: "1", note: "雷可能性あり" },
    ],
    about:
      "雷の激しさと、雷の可能性を 4 段で示した気象庁の解析です。2 以上は、雷鳴が聞こえたり電光が見えたりする所です。",
  },
  {
    id: "tornado",
    element: "trns",
    label: "竜巻 (いま)",
    pill: "竜巻 (いま)",
    title: "竜巻 (竜巻発生確度)",
    credit: "気象庁 (竜巻発生確度ナウキャスト)",
    legend: [
      { color: "rgb(255 40 0)", label: "2", note: "可能性があり注意が必要" },
      { color: "rgb(250 245 0)", label: "1", note: "可能性がある" },
    ],
    about:
      "竜巻などの激しい突風が発生する可能性の程度を 2 段で示した気象庁の解析です。確度 2 でも、実際に竜巻が起きるのは一部です。",
  },
];

export const nowcOf = (id: string): NowcKind | undefined =>
  NOWC_KINDS.find((k) => k.id === id);

/** 1 枚の解析か予測。時刻は UTC の `YYYYMMDDhhmmss` (表のまま)。member はタイルの URL の途中の名前 */
export interface NowcFrame {
  basetime: string;
  validtime: string;
  member: string;
}

const STAMP = /^\d{14}$/;
const MEMBER = /^[a-z0-9_]+$/;

function rows(raw: unknown): (NowcFrame & { elements: unknown[] })[] {
  if (!Array.isArray(raw)) return [];
  const out: (NowcFrame & { elements: unknown[] })[] = [];
  for (const row of raw as unknown[]) {
    if (typeof row !== "object" || row === null) continue;
    const { basetime, validtime, member, elements } = row as Record<
      string,
      unknown
    >;
    if (typeof basetime !== "string" || typeof validtime !== "string") continue;
    if (!STAMP.test(basetime) || !STAMP.test(validtime)) continue;
    if (!Array.isArray(elements)) continue;
    // N3 の表には member が無い (URL は none)。今後の雨は none か immed。URL に入れるので形を確かめる
    const m = member === undefined ? "none" : member;
    if (typeof m !== "string" || !MEMBER.test(m)) continue;
    out.push({ basetime, validtime, member: m, elements });
  }
  return out;
}

/** 時刻の表から、その要素のいちばん新しい解析 (basetime と validtime が同じ 1 枚) を選ぶ。読めなければ null */
export function latestAnalysis(
  raw: unknown,
  element: string,
): NowcFrame | null {
  let best: NowcFrame | null = null;
  for (const r of rows(raw)) {
    // 予測 (validtime が先) は使わない
    if (r.basetime !== r.validtime || !r.elements.includes(element)) continue;
    if (!best || r.validtime > best.validtime)
      best = { basetime: r.basetime, validtime: r.validtime, member: r.member };
  }
  return best;
}

/**
 * 今後の雨の予測の並び。予測のある (validtime が basetime より先の行がある) いちばん新しい basetime の行を、
 * 先の時刻の順に並べる。30 分ごとの速報は 6 時間先まで、1 時間ごとの予報は 15 時間先まで (2026-11-21 に読んだ)。
 * 読めなければ空
 */
export function forecastFrames(raw: unknown): NowcFrame[] {
  const fc = rows(raw).filter(
    (r) => r.validtime > r.basetime && r.elements.includes("rasrf"),
  );
  if (fc.length === 0) return [];
  const base = fc.reduce(
    (a, r) => (r.basetime > a ? r.basetime : a),
    fc[0]!.basetime,
  );
  return fc
    .filter((r) => r.basetime === base)
    .map(({ basetime, validtime, member }) => ({ basetime, validtime, member }))
    .sort((a, b) => a.validtime.localeCompare(b.validtime));
}

/** タイルの URL の型 (`{z}/{x}/{y}` は MapLibre が埋める) */
export const nowcTiles = (f: NowcFrame, element: NowcKind["element"]) =>
  `${NOWC}/${f.basetime}/${f.member}/${f.validtime}/surf/${element}/{z}/{x}/{y}.png`;
export const rasrfTiles = (f: NowcFrame) =>
  `${RASRF}/${f.basetime}/${f.member}/${f.validtime}/surf/rasrf/{z}/{x}/{y}.png`;
/** 線状降水帯の雨域 (代表の楕円。解析) の GeoJSON */
export const slmcsUrl = (f: NowcFrame) =>
  `${NOWC}/${f.basetime}/${f.member}/${f.validtime}/surf/slmcs_unify/data.geojson`;

/** 時刻 (ISO 8601。画面は `#lib/format.ts` の `jst` で出す) */
export function stampIso(t: string): string {
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}Z`;
}

/** 表の時刻 (`YYYYMMDDhhmmss`) から `now` までのミリ秒 */
export const stampAge = (t: string, now: number) =>
  now - Date.parse(stampIso(t));

/**
 * 次に時刻の表を取るまでのミリ秒 (雨雲・キキクル・雷と竜巻で同じ決め方)。いまの 1 枚の時刻 `t` の次の時刻が表に
 * 載る頃 (`t` + `step` + `publish`) に取り、もう過ぎていれば (遅れている・まだ取れていない) `retry` 後に取り直す。
 * まだ 1 枚も読めていなければ (`t` が null) `retry` 後
 */
export function nextPoll(
  t: string | null,
  now: number,
  step: number,
  publish: number,
  retry: number,
): number {
  if (t === null) return retry;
  const wait = step + publish - stampAge(t, now);
  return wait > 0 ? Math.min(wait, step + publish) : retry;
}

/** 更新の間隔 (雷・竜巻・線状降水帯は 10 分ごと) */
const N3_STEP_MS = 10 * 60_000;
/**
 * 解析の時刻から、その時刻の表が取れるまでの待ち。表は解析の時刻の数分後に書き換わり、配信の CDN が 60 秒覚えるので、
 * 余裕を見て 5 分待つ
 */
const N3_PUBLISH_MS = 5 * 60_000;
export const NOWC_RETRY_MS = 60_000;
/** 解析の時刻からこれより経ったら古いとみなし、凡例にそう書く (2 回続けて更新が取れていない) */
export const N3_STALE_MS = 35 * 60_000;
/** 今後の雨の時刻の表を取り直す間 (予測は 30 分ごとに出る) */
export const RASRF_POLL_MS = 10 * 60_000;
/** 今後の雨の解析の時刻からこれより経ったら古いとみなす (2 回続けて新しい予測が取れていない) */
const RASRF_STALE_MS = 80 * 60_000;

/** 次に N3 の時刻の表を取るまでのミリ秒 (`nextPoll`) */
export const nextN3Poll = (frame: NowcFrame | null, now: number): number =>
  nextPoll(
    frame?.validtime ?? null,
    now,
    N3_STEP_MS,
    N3_PUBLISH_MS,
    NOWC_RETRY_MS,
  );

export const nowcStale = (frame: NowcFrame, now: number) =>
  stampAge(frame.validtime, now) > N3_STALE_MS;
export const rasrfStale = (frame: NowcFrame, now: number) =>
  stampAge(frame.basetime, now) > RASRF_STALE_MS;

/**
 * 予測の何時間先か (basetime から validtime まで、0.5 時間刻み)。2026-11-21 の表はどの basetime も 1 時間ごとの
 * 予測だったが、30 分ずれた行が来ても「1 時間先」に丸めて取り違えないよう、半端は 1.5 のように出す
 */
export const hoursAhead = (f: NowcFrame) =>
  Math.round(
    ((Date.parse(stampIso(f.validtime)) - Date.parse(stampIso(f.basetime))) /
      3_600_000) *
      2,
  ) / 2;

/**
 * 今後の雨の凡例 (1 時間の雨量 mm。強いものから)。色は気象庁の画面の凡例 (`legend_jp_normal_rasrf.svg`) のまま
 * (2026-11-21 に読んだ。気象庁の配色の指針の表 2-1 と同じ区切り)
 */
export const RASRF_LEGEND: { color: string; label: string }[] = [
  { color: "rgb(180 0 104)", label: "80 以上" },
  { color: "rgb(255 40 0)", label: "50〜80" },
  { color: "rgb(255 153 0)", label: "30〜50" },
  { color: "rgb(255 245 0)", label: "20〜30" },
  { color: "rgb(0 65 255)", label: "10〜20" },
  { color: "rgb(33 140 255)", label: "5〜10" },
  { color: "rgb(160 210 255)", label: "1〜5" },
  { color: "rgb(242 242 255)", label: "1 未満" },
];

/** 線状降水帯の雨域の線 (気象庁の画面と同じ白い縁の赤) */
export const SLMCS_COLOR = "rgb(255 0 0)";

/**
 * 線状降水帯の GeoJSON から、線で描ける形 (面と線) だけを残す。属性は使わない。形の分からないものは捨てる
 * (データが無いときは空の FeatureCollection が来る。2026-11-21 は空で、出ているときの形は気象庁の画面の設定から読んだ)
 */
export function slmcsFeatures(raw: unknown): {
  type: "FeatureCollection";
  features: { type: "Feature"; geometry: unknown; properties: object }[];
} {
  const out: { type: "Feature"; geometry: unknown; properties: object }[] = [];
  const keep = new Set([
    "Polygon",
    "MultiPolygon",
    "LineString",
    "MultiLineString",
  ]);
  const feats =
    typeof raw === "object" &&
    raw !== null &&
    Array.isArray((raw as { features?: unknown }).features)
      ? ((raw as { features: unknown[] }).features ?? [])
      : [];
  for (const f of feats) {
    if (typeof f !== "object" || f === null) continue;
    const g = (f as { geometry?: unknown }).geometry;
    if (typeof g !== "object" || g === null) continue;
    const t = (g as { type?: unknown }).type;
    if (typeof t !== "string" || !keep.has(t)) continue;
    if (!Array.isArray((g as { coordinates?: unknown }).coordinates)) continue;
    out.push({ type: "Feature", geometry: g, properties: {} });
  }
  return { type: "FeatureCollection", features: out };
}
