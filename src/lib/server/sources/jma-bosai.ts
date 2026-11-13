/**
 * 気象庁ホームページ (bosai) の国際津波関連情報 (北西太平洋津波情報センターの電報 WEPA40)。
 *
 * - 一覧 `pacifictsunami/data/list.json` (1 か月分) を 60 秒ごとに取る (`Cache-Control: max-age=60`、ETag を付ける)
 * - 一覧に新しい電報があれば、その本文 (英文、`data/wepa40/<fname>`) を 1 回だけ取る。取れなかった電報は
 *   30 分は取り直さない (同じ URL を何度も取りに行かない)
 * - **公式の API ではない** (ホームページの表示用で、予告なく変わる)。ほかの情報源と分けた独立のアダプターにし、
 *   形が変わって読めなくなったら、その回を捨てて状態にエラーを出すだけにする (ほかの情報源と画面は止まらない)
 * - 各国の機関に向けた情報で、日本の沿岸の津波予報ではない。お知らせの一覧にだけ出し、知らせない
 *
 * 利用条件は気象庁ホームページの利用規約 (公共データ利用規約 第 1.0 版)。出典は「気象庁ホームページ」。
 */

import type { Advisory } from "#lib/model.ts";

import { type PollOptions, pollSource, type PollTools } from "./poll.ts";
import type { Incoming, Source, SourceContext } from "./types.ts";

const BASE = "https://www.jma.go.jp/bosai/pacifictsunami";
export const BOSAI_TSUNAMI_LIST = `${BASE}/data/list.json`;
export const bosaiTsunamiText = (fname: string) =>
  `${BASE}/data/wepa40/${fname}`;

/** 一度に取りに行く本文の数の上限 (起動したときに 1 か月分を一度に取りに行かない) */
const MAX_TEXTS = 5;
/** 取れなかった電報を取り直さない時間 */
const RETRY_AFTER_MS = 30 * 60_000;
/** 本文の長さの上限 (これより長い所は捨てる) */
const MAX_TEXT = 20_000;

interface ListItem {
  time: string;
  fname: string;
  lat?: string;
  lon?: string;
  depth?: number;
  mag?: number;
}

const FNAME = /^(\d{14})_\d+_WEPA40_RJTD\.txt$/;

/** 一覧を読む。形が違えば例外 (その回を捨てる)。新しい順に並べる */
export function parseBosaiTsunamiList(text: string): ListItem[] {
  const list = JSON.parse(text) as unknown;
  if (!Array.isArray(list)) throw new Error("一覧が配列ではありません");
  return list
    .flatMap((v): ListItem[] => {
      if (typeof v !== "object" || v === null) return [];
      const o = v as Record<string, unknown>;
      const fname = typeof o.fname === "string" ? o.fname : "";
      const time = typeof o.time === "string" ? o.time : "";
      if (!FNAME.test(fname) || !Number.isFinite(Date.parse(time))) return [];
      const epi = (o.epicenter ?? {}) as Record<string, unknown>;
      return [
        {
          time,
          fname,
          lat: typeof epi.lat === "string" ? epi.lat : undefined,
          lon: typeof epi.lon === "string" ? epi.lon : undefined,
          depth: typeof o.depth === "number" ? o.depth : undefined,
          mag: typeof o.mag === "number" ? o.mag : undefined,
        },
      ];
    })
    .sort((a, b) => b.fname.localeCompare(a.fname));
}

/** 電報のファイル名の時刻 (`20261025022014` は UTC) */
function issuedAt(fname: string): string | undefined {
  const d = FNAME.exec(fname)?.[1];
  if (!d) return undefined;
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}Z`;
  return Number.isFinite(Date.parse(iso))
    ? new Date(iso).toISOString()
    : undefined;
}

/** 緯度・経度の書き方 (`+28.0`・`-13.8`) を「北緯 28.0」などに */
const latText = (v: string | undefined) =>
  v === undefined
    ? ""
    : `${v.startsWith("-") ? "南緯" : "北緯"} ${v.replace(/^[+-]/, "")}`;
const lonText = (v: string | undefined) =>
  v === undefined
    ? ""
    : `${v.startsWith("-") ? "西経" : "東経"} ${v.replace(/^[+-]/, "")}`;

/** 1 つの電報を、お知らせにする */
export function bosaiTsunamiAdvisory(
  item: ListItem,
  body: string,
): Omit<Advisory, "updatedAt" | "cancelled"> {
  const text = body.replace(/\r\n?/g, "\n").slice(0, MAX_TEXT).trim();
  const first = text.split("\n")[0]?.trim() ?? "";
  // 評価の段落 (「THERE IS NO POSSIBILITY OF A TSUNAMI」など) の 1 行目
  const evaluation = /\nEVALUATION\n\s*(.+)/.exec(text)?.[1]?.trim();
  const facts = [
    item.mag === undefined ? "" : `M${item.mag.toFixed(1)}`,
    item.depth === undefined ? "" : `深さ ${Math.round(item.depth)} km`,
    [latText(item.lat), lonText(item.lon)].filter(Boolean).join(" "),
  ].filter(Boolean);
  const id = item.fname.replace(/\.txt$/, "");
  return {
    id: `WEPA40-${id}`,
    code: "WEPA40",
    source: "jma-bosai",
    eventId: id,
    title: "国際津波関連情報 (北西太平洋)",
    serialName: first || undefined,
    status: "normal",
    infoType: "発表",
    reportedAt: issuedAt(item.fname) ?? new Date(item.time).toISOString(),
    headline: [facts.join("・"), evaluation].filter(Boolean).join("。"),
    text,
    url: bosaiTsunamiText(item.fname),
  };
}

export function bosaiTsunamiSource(
  ctx: SourceContext,
  opts: Partial<PollOptions> = {},
): Source {
  const failed = new Map<string, number>();
  async function parse(text: string, _url: string, tools: PollTools) {
    const list = parseBosaiTsunamiList(text);
    const now = Date.now();
    // 取り直さない控えは 30 分で捨てる (増え続けない)
    for (const [f, t] of failed) if (now - t > RETRY_AFTER_MS) failed.delete(f);
    const unseen = list.filter((i) => !ctx.seen("jma-bosai", i.fname));
    const todo = unseen.filter((i) => !failed.has(i.fname)).slice(0, MAX_TEXTS);
    // 取り残し (上限で次に回したもの・取れなかったもの) があれば、次の回も一覧を読み直す
    if (unseen.length > todo.length) tools.leftLater();
    const out: Incoming[] = [];
    // 古い順に渡す (一覧の並びと同じ向きに保存する)
    for (const item of todo.reverse()) {
      let body: string;
      try {
        body = await tools.fetchText(bosaiTsunamiText(item.fname));
      } catch (err) {
        failed.set(item.fname, now);
        tools.leftLater();
        console.warn(`[jma-bosai] ${item.fname} を取れませんでした: ${err}`);
        continue;
      }
      out.push({
        source: "jma-bosai",
        key: item.fname,
        code: "WEPA40",
        body,
        items: [
          { type: "advisory", advisory: bosaiTsunamiAdvisory(item, body) },
        ],
      });
    }
    return out;
  }
  return pollSource(ctx, {
    id: "jma-bosai",
    url: BOSAI_TSUNAMI_LIST,
    intervalMs: 60_000,
    minIntervalMs: 60_000,
    parse,
    ...opts,
  });
}
