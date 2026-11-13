/**
 * 米国の太平洋津波警報センター (PTWC) の Atom フィード (tsunami.gov)。いちばん新しい電報 1 つが載っている。
 *
 * - 60 秒ごとに取る (NWS は再試行を 1 分あけるよう求めている)。`If-Modified-Since` を付ける
 * - 電報 1 つを「お知らせ」(Advisory、code は PTWC) にする。本文 (英文の電報) は取りに行かず、
 *   フィードの要約 (種類・地域・規模・位置) とリンクだけを持つ
 * - 米国の参考の情報で、日本の津波の警報・注意報は気象庁が出す。知らせない
 *
 * public domain (https://www.weather.gov/disclaimer)。NWS のロゴは商標なので使わない。
 * 政府の公式の発表のように見せない。
 */

import type { Advisory } from "#lib/model.ts";

import { type PollOptions, pollSource } from "./poll.ts";
import type { Incoming, Source, SourceContext } from "./types.ts";

export const PTWC_FEED = "https://www.tsunami.gov/events/xml/PHEBAtom.xml";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
/** 数値の文字参照 (`&#65;`・`&#x41;`) を字に。読めない値はそのまま */
function codePoint(ref: string): string | undefined {
  const n = /^#x/i.test(ref)
    ? Number.parseInt(ref.slice(2), 16)
    : Number.parseInt(ref.slice(1), 10);
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff
    ? String.fromCodePoint(n)
    : undefined;
}

/**
 * タグを外し、実体参照を戻し、空白を詰める。画面には字として出す (HTML としては出さない) ので、
 * タグは外せるまで繰り返し外し、残った山括弧も消す
 */
function plain(html: string): string {
  let s = html.replace(/<br\s*\/?>/gi, "\n");
  for (let prev = ""; prev !== s;) {
    prev = s;
    s = s.replace(/<[^<>]*>/g, "");
  }
  return s
    .replace(/[<>]/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
      e.startsWith("#")
        ? (codePoint(e) ?? m)
        : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/[ \t]+/g, " ")
    .trim();
}
const tag = (xml: string, name: string) =>
  new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];

/** 要約の「項目: 値」を読む */
function fields(summary: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of plain(summary).split("\n")) {
    const m = /^([A-Za-z/ ]+):\s*(.*)$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/** フィードを読む。電報が無ければ空。Atom でなければ例外 (その回を捨てる) */
export function parsePtwc(xml: string): Incoming[] {
  if (!/<feed[\s>]/.test(xml)) throw new Error("Atom のフィードではありません");
  const bulletin = plain(tag(xml, "title") ?? "");
  // フィードにはいちばん新しい電報 1 つだけが載る。仮に幾つも載っても、先頭 (新しいもの) だけを採る
  const entries = (xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []).slice(0, 1);
  return entries.flatMap((entry): Incoming[] => {
    const id = plain(tag(entry, "id") ?? "");
    const updated = plain(tag(entry, "updated") ?? "");
    if (!id || !Number.isFinite(Date.parse(updated))) return [];
    const f = fields(tag(entry, "summary") ?? "");
    const region = plain(tag(entry, "title") ?? "");
    const link =
      /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/.exec(entry)?.[1] ??
      /<link[^>]*href="([^"]+)"[^>]*rel="alternate"/.exec(entry)?.[1];
    const lat = plain(tag(entry, "geo:lat") ?? "");
    const lon = plain(tag(entry, "geo:long") ?? "");
    const lines = [
      region ? `地域: ${region}` : "",
      f["Preliminary Magnitude"]
        ? `規模 (速報): ${f["Preliminary Magnitude"]}`
        : "",
      lat && lon ? `震央: 緯度 ${lat}・経度 ${lon}` : "",
      f.Note ? `注記: ${f.Note}` : "",
    ].filter(Boolean);
    const advisory: Omit<Advisory, "updatedAt" | "cancelled"> = {
      id: `PTWC-${id.replace(/^urn:uuid:/, "")}`,
      code: "PTWC",
      source: "ptwc",
      eventId: id,
      title: "PTWC (米国) の津波の情報",
      serialName: f.Category,
      status: "normal",
      infoType: "発表",
      reportedAt: new Date(updated).toISOString(),
      headline: bulletin,
      text: lines.join("\n"),
      // 画面にリンクとして出すので、tsunami.gov の https だけを採る
      url: link
        ?.replace(/^http:/, "https:")
        .match(/^https:\/\/www\.tsunami\.gov\/[^\s"<>]*$/)?.[0],
    };
    return [
      {
        source: "ptwc",
        key: id,
        code: "atom",
        body: entry,
        items: [{ type: "advisory", advisory }],
      },
    ];
  });
}

export function ptwcSource(
  ctx: SourceContext,
  opts: Partial<PollOptions> = {},
): Source {
  return pollSource(ctx, {
    id: "ptwc",
    url: PTWC_FEED,
    intervalMs: 60_000,
    minIntervalMs: 60_000,
    parse: parsePtwc,
    ...opts,
  });
}
