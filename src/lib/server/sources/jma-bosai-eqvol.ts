/**
 * 気象庁ホームページ (bosai) の津波と火山の JSON。気象庁防災情報 XML の地震火山のフィード (`jma`) が取れない間だけ
 * 取得する予備 (docs/design.md の 2.1 の「予備の源」・2.2)。
 *
 * - **ふだんは取得しない** (状態は `standby`)。主のフィードが `STANDBY_GRACE_MS` (3 分) より長く取れないとき
 *   (フィードは取れても電文の本体が続けて取れないときも。`jma.ts` の `TELEGRAM_MISS_LIMIT`) だけ、60 秒ごとに取る
 * - 津波: 一覧 `tsunami/data/list.json` (約 0.5KB) を条件付きで取り、新しい津波警報・注意報・予報 (VTSE41)・津波情報
 *   (VTSE51。到達予想・観測)・沖合の津波観測に関する情報 (VTSE52) の本文 `tsunami/data/<名前>.json` を 1 回だけ取る。
 *   本文は電文を JSON にした形 (Control・Head・Body と要素の名前のまま) なので、XML に戻して気象庁 XML と同じ読み方
 *   (`parseJmaXml`) で読む。JSON で抜けた属性 (津波の高さの `description`) は値から作り直す
 * - 火山: 噴火警報・予報のいまの一覧 `volcano/data/warning.json` (約 10KB) を条件付きで取り、新しい報の火山の本文
 *   `volcano/data/warning/<火山のコード>.json` を 1 回だけ取る。噴火速報は一覧 `volcano/data/eruption.json` と本文
 *   `volcano/data/eruption/<識別番号>.json`。どちらも電文の要素を名前を変えて並べた形なので、VFVO50・VFVO56 の
 *   XML に組み直して同じ読み方で読む。**噴火速報の一覧は 2026-11-28 には空で、中身の形は確かめられていない**
 *   (噴火警報の本文と同じ形と見て読み、読めなければ原文を残す)
 * - 主のフィードが最後に取れた時刻 (の 10 分前) より前の報は採らない (気象庁 XML で受けている)
 * - **公式の API ではない** (ホームページの表示用で、予告なく変わる)。形が変わって読めなくなったら、その報の原文を
 *   残して状態にエラーを出すだけにする (ほかの情報源と画面は止まらない。docs/design.md の 2.1 の「読めない・取れないとき」)
 * - 受けた報には `source: "jma-bosai"` を付ける。津波は気象庁 XML と同じ重みで合わせ (merge.ts)、火山は気象庁 XML の
 *   同じ報 (同じ id) が届いたら、そちらに置き換わる。見出しは電文と同じ字なので、置き換えても通知は鳴り直さない
 *
 * 利用条件は気象庁ホームページの利用規約 (公共データ利用規約 第 1.0 版)。出典は「気象庁ホームページ」。
 * 気象庁の発表を変えずに中継する (docs/design.md の 5 章)。
 */

import type { SourceStatus } from "#lib/model.ts";

import { BosaiFetcher, BosaiHttpError, retryable } from "./bosai-fetch.ts";
import { primaryDown } from "./jma-bosai-weather.ts";
import { parseJmaXml } from "./jma-xml.ts";
import { sleep, StatusTracker } from "./retry.ts";
import type { Incoming, Normalized, Source, SourceContext } from "./types.ts";

const BASE = "https://www.jma.go.jp/bosai";
export const BOSAI_TSUNAMI_LIST = `${BASE}/tsunami/data/list.json`;
export const bosaiTsunami = (name: string) => `${BASE}/tsunami/data/${name}`;
export const BOSAI_VOLCANO_WARNING = `${BASE}/volcano/data/warning.json`;
export const bosaiVolcanoWarning = (id: string) =>
  `${BASE}/volcano/data/warning/${id}.json`;
export const BOSAI_VOLCANO_ERUPTION = `${BASE}/volcano/data/eruption.json`;
export const bosaiVolcanoEruption = (id: string) =>
  `${BASE}/volcano/data/eruption/${id}.json`;

const INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
/** 主のフィードが最後に取れた時刻から、これだけ前の報までは予備でも採る */
const OVERLAP_MS = 10 * 60_000;
/** 主のフィードが一度も取れていないときに、予備で採る報の古さの上限 */
const COLD_START_MS = 24 * 60 * 60_000;
/** 本文が 404・410 だったとき、諦めるまでに取りに行く回数 (1 分ごと。一覧が先に出て本文が遅れることがある) */
const BODY_MISS_LIMIT = 5;
/** 一回に取る本文の数の上限 (一覧ごと) */
const MAX_BODIES = 10;
const STANDBY_REASON = "気象庁 XML (地震火山) が取れない間だけ取ります";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]) : []);

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** 要素の名前に使ってよい字か (JSON のキーをそのまま要素にするので、ほかの字は捨てる) */
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const FULL = (s: string) =>
  s.replace(/[0-9.]/g, (c) =>
    c === "." ? "．" : String.fromCharCode(c.charCodeAt(0) + 0xfee0),
  );

/**
 * 津波の高さの値 (bosai は電文の `jmx_eb:TsunamiHeight` の値と条件を 1 つの文字にしている。「<0.2」「>10」「1」
 * 「巨大」) から、電文の `description` (「０．２ｍ未満」「１０ｍ超」「１ｍ」「巨大」) を作り直す
 */
export function tsunamiHeightText(v: string): string {
  const t = v.trim();
  const m = /^([<>]?)(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return t;
  const n = `${FULL(m[2] ?? "")}ｍ`;
  return m[1] === "<" ? `${n}未満` : m[1] === ">" ? `${n}超` : n;
}

/**
 * 電文を JSON にした形 (要素の名前がキー、繰り返しは並び、中身は文字) を XML に戻す。英語の名前 (`en…`) と null は捨てる。
 * 津波の高さは名前空間の付いた要素に戻し、`description` を作り直す
 */
export function bosaiJsonToXml(value: unknown, name: string): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value))
    return value.map((v) => bosaiJsonToXml(v, name)).join("");
  if (name === "TsunamiHeight") {
    const t = str(value);
    // 形が違う (オブジェクトなど) なら、黙って高さを消さずに読めないとする (原文を残す)
    if (t === undefined) throw new Error("津波の高さの形が違います");
    return `<jmx_eb:TsunamiHeight description="${esc(tsunamiHeightText(t))}">${esc(t.replace(/^[<>]/, ""))}</jmx_eb:TsunamiHeight>`;
  }
  if (isObject(value)) {
    const inner = Object.entries(value)
      .filter(([k]) => NAME.test(k) && !/^en[A-Z]/.test(k))
      .map(([k, v]) => bosaiJsonToXml(v, k))
      .join("");
    return `<${name}>${inner}</${name}>`;
  }
  const s = str(value);
  return s === undefined ? "" : `<${name}>${esc(s)}</${name}>`;
}

const ROOT = (inner: string) =>
  `<Report xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">${inner}</Report>`;

/** 津波の一覧の 1 項目 */
export interface BosaiTsunamiItem {
  /** 本文の名前 (`20261106195344_20261106193937_VTSE41_0.json`) */
  name: string;
  code: "VTSE41" | "VTSE51" | "VTSE52";
  /** 発表の時刻 */
  reportedAt: string;
}

const TSUNAMI_NAME = /^\d{14}_\d{14}_(VTSE4[1]|VTSE5[12])_\d+\.json$/;

/** 津波の一覧 (`list.json`) を古い順に。配列でなければ例外 */
export function parseBosaiTsunamiList(text: string): BosaiTsunamiItem[] {
  const all = JSON.parse(text) as unknown;
  if (!Array.isArray(all)) throw new Error("津波の一覧が配列ではありません");
  return all
    .flatMap((v): BosaiTsunamiItem[] => {
      if (!isObject(v)) return [];
      const name = str(v.json);
      const m = name ? TSUNAMI_NAME.exec(name) : null;
      const reportedAt = str(v.rdt);
      if (
        !name ||
        !m ||
        !reportedAt ||
        !Number.isFinite(Date.parse(reportedAt))
      )
        return [];
      return [{ name, code: m[1] as BosaiTsunamiItem["code"], reportedAt }];
    })
    .sort((a, b) => Date.parse(a.reportedAt) - Date.parse(b.reportedAt));
}

/** 津波の本文を、気象庁 XML と同じ津波の報に (源は `jma-bosai`)。形が違えば例外 */
export function parseBosaiTsunami(
  text: string,
  code: BosaiTsunamiItem["code"],
): Normalized[] {
  const d = JSON.parse(text) as unknown;
  if (!isObject(d) || !isObject(d.Control) || !isObject(d.Head))
    throw new Error("津波の本文の形が違います");
  const xml = ROOT(
    ["Control", "Head", "Body"].map((k) => bosaiJsonToXml(d[k], k)).join(""),
  );
  return parseJmaXml(xml, code).map((n) =>
    n.type === "tsunami"
      ? { ...n, report: { ...n.report, source: "jma-bosai" } }
      : n,
  );
}

/** 火山の一覧 (噴火警報・予報のいまの一覧と噴火速報の一覧) の 1 項目 */
export interface BosaiVolcanoItem {
  /** 本文の名前に使う識別番号 (噴火警報・予報は火山のコード) */
  eventId: string;
  reportedAt: string;
}

/** 火山の一覧を古い順に読む。配列でなければ例外。識別番号が英数と下線でない項目は捨てる (本文の URL に使うため) */
export function parseBosaiVolcanoList(text: string): BosaiVolcanoItem[] {
  const all = JSON.parse(text) as unknown;
  if (!Array.isArray(all)) throw new Error("火山の一覧が配列ではありません");
  return (
    all
      .flatMap((v): BosaiVolcanoItem[] => {
        if (!isObject(v)) return [];
        const eventId = str(v.eventId);
        const reportedAt = str(v.reportDatetime);
        if (
          !eventId ||
          !/^[0-9A-Za-z_]{1,40}$/.test(eventId) ||
          !reportedAt ||
          !Number.isFinite(Date.parse(reportedAt))
        )
          return [];
        return [{ eventId, reportedAt }];
      })
      // 古い順に取る (一度に取る数を超えたとき、残りは次の回に)
      .sort((a, b) => Date.parse(a.reportedAt) - Date.parse(b.reportedAt))
  );
}

/**
 * 火山の本文 (噴火警報・予報 `warning/<火山>.json`・噴火速報 `eruption/<識別番号>.json`) を、気象庁 XML と同じ火山の報に。
 * 本文は電文の要素を名前を変えて並べた形 (`volcanoInfos` の `type` は電文の `VolcanoInfo` の type のまま) なので、
 * VFVO50・VFVO56 の XML に組み直す。電文の見出し (Head/Headline/Text) は JSON に無いが、`volcanoHeadline`
 * (VolcanoInfoContent/VolcanoHeadline) と同じ字 (サンプル電文で確かめた) なので、それを置く。形が違えば例外
 */
export function parseBosaiVolcano(
  text: string,
  code: "VFVO50" | "VFVO56",
): Normalized[] {
  const d = JSON.parse(text) as unknown;
  if (!isObject(d)) throw new Error("火山の本文の形が違います");
  const reportedAt = str(d.reportDatetime);
  if (!reportedAt || !Number.isFinite(Date.parse(reportedAt)))
    throw new Error("発表の時刻がありません");
  const el = (n: string, v: string | undefined) =>
    v === undefined || v === "" ? "" : `<${n}>${esc(v)}</${n}>`;
  const infos = list(d.volcanoInfos)
    .filter(isObject)
    .map((info) => {
      const items = list(info.items)
        .filter(isObject)
        .map((it) => {
          const areas = list(it.areas)
            .filter(isObject)
            .map(
              (a) =>
                `<Area>${el("Name", str(a.name))}${el("Code", str(a.code))}</Area>`,
            )
            .join("");
          const eventTime = str(it.eventDatetime) ?? str(d.eventDatetime);
          return (
            `<Item><Kind>${el("Name", str(it.name))}${el("Code", str(it.code))}${el("Condition", str(it.condition))}</Kind>` +
            (str(it.lastCode)
              ? `<LastKind>${el("Code", str(it.lastCode))}</LastKind>`
              : "") +
            (eventTime
              ? `<EventTime>${el("EventDateTime", eventTime)}</EventTime>`
              : "") +
            `<Areas>${areas}</Areas></Item>`
          );
        })
        .join("");
      return `<VolcanoInfo type="${esc(str(info.type) ?? "")}">${items}</VolcanoInfo>`;
    })
    .join("");
  const headline = str(d.volcanoHeadline);
  const xml = ROOT(
    `<Control>${el("Title", str(d.controlTitle))}<Status>通常</Status></Control>` +
      `<Head>${el("Title", str(d.headTitle))}${el("ReportDateTime", reportedAt)}${el("EventID", str(d.eventId))}${el("InfoType", str(d.infoType) || "発表")}` +
      `<Headline>${el("Text", headline)}</Headline></Head>` +
      `<Body>${infos}<VolcanoInfoContent>${el("VolcanoHeadline", headline)}${el("VolcanoActivity", str(d.volcanoActivity))}${el("VolcanoPrevention", str(d.volcanoPrevention))}${el("NextAdvisory", str(d.nextAdvisory))}${el("Appendix", str(d.appendix))}</VolcanoInfoContent></Body>`,
  );
  const out = parseJmaXml(xml, code).map((n) =>
    n.type === "volcano"
      ? { ...n, volcano: { ...n.volcano, source: "jma-bosai" as const } }
      : n,
  );
  if (!out.some((n) => n.type === "volcano" && n.volcano.volcanoes.length > 0))
    throw new Error("対象の火山を読めませんでした");
  return out;
}

export interface BosaiEqvolOptions {
  /** 主の源 (気象庁 XML の地震火山のフィード) のいまの状態 */
  primary: () => SourceStatus;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (m: string) => void;
  now?: () => number;
}

export function bosaiEqvolSource(
  ctx: SourceContext,
  opts: BosaiEqvolOptions,
): Source {
  const id = "jma-bosai-eqvol" as const;
  const status = new StatusTracker(id, ctx.onStatus, {
    kind: "poll",
    everyMs: INTERVAL_MS,
  });
  const http = new BosaiFetcher(opts.fetch ?? fetch);
  const wait = opts.sleep ?? sleep;
  const log = opts.log ?? ((m: string) => console.log(m));
  const now = opts.now ?? Date.now;
  const tag = `[${id}]`;
  /** 本文が 404・410 のまま諦めた報 (一覧に載っている間は取り直さない) */
  const gone = new Map<string, Set<string>>();
  /** 本文が 404・410 だった回数 (一覧が先に出て本文がまだ置かれていないことがあるので、すぐには諦めない) */
  const missTries = new Map<string, number>();
  /** 読めなかった報と、諦めた報の訳 (一覧に載っている間は、受信の状態に出し続ける) */
  const trouble = new Map<string, Map<string, string>>();

  function cutoff(): number {
    const p = opts.primary();
    const last = p.lastSeenAt ? Date.parse(p.lastSeenAt) : Number.NaN;
    return Number.isFinite(last) ? last - OVERLAP_MS : now() - COLD_START_MS;
  }

  /**
   * 一覧を条件付きで取り、まだ受けていない報の本文を 1 回ずつ取って渡す。取り残しがあれば控えを覚えず、
   * 次の回に一覧を読み直す。読めない報・取れない報・読めない一覧の項目は、黙って落とさず訳を返す (受信の状態に出す)
   */
  async function drain<T extends { reportedAt: string }>(
    listUrl: string,
    signal: AbortSignal,
    since: number,
    parseList: (text: string) => { items: T[]; dropped: number },
    keyOf: (item: T) => string,
    bodyUrl: (item: T) => string,
    codeOf: (item: T) => string,
    parse: (text: string, item: T) => Normalized[],
    /** 本文が一覧の項目より古い (配信の途中で、前の報がまだ置かれている) なら true。取らずに次の回へ回す */
    behind?: (text: string, item: T) => boolean,
  ): Promise<string[]> {
    const problems = trouble.get(listUrl) ?? new Map<string, string>();
    trouble.set(listUrl, problems);
    const r = await http.get(listUrl, signal, true);
    if (!r) return [...problems.values()];
    const { items, dropped } = parseList(r.text);
    const listed = new Set(items.map(keyOf));
    // 一覧に載っていない報は忘れる (載り直したら、また取る)
    const missing = new Set(
      [...(gone.get(listUrl) ?? [])].filter((k) => listed.has(k)),
    );
    gone.set(listUrl, missing);
    for (const k of problems.keys()) if (!listed.has(k)) problems.delete(k);
    const todo = items.filter((i) => {
      const k = keyOf(i);
      return (
        Date.parse(i.reportedAt) >= since && !missing.has(k) && !ctx.seen(id, k)
      );
    });
    let left = todo.length > MAX_BODIES;
    for (const i of todo.slice(0, MAX_BODIES)) {
      if (signal.aborted) return [];
      const key = keyOf(i);
      let body: string;
      try {
        const res = await http.get(bodyUrl(i), signal, false);
        // 本文は条件を付けずに取るので 304 は来ないが、型の上で undefined を除く
        if (!res) continue;
        body = res.text;
      } catch (err) {
        if (signal.aborted) return [];
        log(`${tag} ${err}`);
        if (retryable(err)) left = true;
        else if (err instanceof BosaiHttpError) {
          const n = (missTries.get(key) ?? 0) + 1;
          if (n >= BODY_MISS_LIMIT) {
            missTries.delete(key);
            missing.add(key);
            problems.set(key, `${key} の本文を取れません (${err.message})`);
          } else {
            if (missTries.size > 1000) missTries.clear();
            missTries.set(key, n);
            left = true;
          }
        }
        continue;
      }
      missTries.delete(key);
      let stale = false;
      try {
        stale = behind?.(body, i) ?? false;
      } catch {
        // 時刻を読めない本文は、下の読み方で読めないとする
      }
      if (stale) {
        log(`${tag} ${key} の本文がまだ前の報なので、次の回に取り直します`);
        left = true;
        continue;
      }
      let incoming: Incoming;
      try {
        const items = parse(body, i);
        incoming = { source: id, key, code: codeOf(i), body, items };
      } catch (err) {
        // 読めない本文も原文は残す (読み方を直したら流し直す)。黙って落とさず、受信の状態に出す
        log(`${tag} ${key} を読めませんでした: ${err}`);
        problems.set(
          key,
          `${key} を読めませんでした (原文を残しました): ${err}`,
        );
        incoming = {
          source: id,
          key,
          code: codeOf(i),
          body,
          items: [],
          error: String(err),
        };
      }
      ctx.emit(incoming);
      status.seen(true);
    }
    if (!left) http.remember(listUrl, r.validators);
    const out = [...problems.values()];
    if (dropped > 0)
      out.push(`${listUrl} の ${dropped} 項目を読めませんでした`);
    return out;
  }

  const tsunami = (signal: AbortSignal, since: number) =>
    drain(
      BOSAI_TSUNAMI_LIST,
      signal,
      since,
      // 名前の形が違う項目 (ほかの種類の電文) は、もともと取らないものなので数えない
      (text) => ({ items: parseBosaiTsunamiList(text), dropped: 0 }),
      (i) => `tsunami:${i.name}`,
      (i) => bosaiTsunami(i.name),
      (i) => i.code,
      (text, i) => parseBosaiTsunami(text, i.code),
    );

  const volcano = (code: "VFVO50" | "VFVO56") => {
    const [listUrl, bodyUrl] =
      code === "VFVO50"
        ? [BOSAI_VOLCANO_WARNING, bosaiVolcanoWarning]
        : [BOSAI_VOLCANO_ERUPTION, bosaiVolcanoEruption];
    return (signal: AbortSignal, since: number) =>
      drain(
        listUrl,
        signal,
        since,
        // 項目の形が違えば (噴火速報の一覧は形を確かめられていない)、黙って捨てずに数える
        (text) => {
          const items = parseBosaiVolcanoList(text);
          return {
            items,
            dropped: list(JSON.parse(text)).length - items.length,
          };
        },
        // 噴火警報・予報のいまの一覧は火山ごとにいちばん新しい報なので、火山と発表の時刻で 1 つの報になる
        (i) => `${code}:${i.eventId}:${i.reportedAt}`,
        (i) => bodyUrl(i.eventId),
        () => code,
        (text) => parseBosaiVolcano(text, code),
        // 火山の本文は火山ごとに 1 つで差し替わるので、一覧より古ければ (前の報が残っていれば) 待つ
        (text, i) => {
          const d = JSON.parse(text) as unknown;
          const at = isObject(d)
            ? Date.parse(str(d.reportDatetime) ?? "")
            : NaN;
          return Number.isFinite(at) && at < Date.parse(i.reportedAt);
        },
      );
  };

  return {
    id,
    status() {
      const s = status.get();
      return s.state === "standby" ? { ...s, reason: STANDBY_REASON } : s;
    },
    async run(signal) {
      let fail = 0;
      while (!signal.aborted) {
        if (!primaryDown(opts.primary(), now())) {
          fail = 0;
          status.set("standby");
          await wait(INTERVAL_MS, signal);
          continue;
        }
        const since = cutoff();
        // 津波・噴火警報・噴火速報は別の一覧なので、どれかが取れなくてもほかは取る
        const errors: string[] = [];
        /** 一覧は取れたが、読めない報・取れない報があった訳 (待つ長さは延ばさず、受信の状態に出す) */
        const problems: string[] = [];
        for (const part of [tsunami, volcano("VFVO56"), volcano("VFVO50")]) {
          try {
            problems.push(...(await part(signal, since)));
          } catch (err) {
            if (signal.aborted) break;
            log(`${tag} 取れませんでした: ${err}`);
            errors.push(String(err));
          }
        }
        if (signal.aborted) break;
        if (errors.length === 0) {
          fail = 0;
          status.seen(false);
          if (problems.length > 0) status.set("retrying", problems.join(" / "));
          else {
            status.set("connected");
            status.recovered();
          }
        } else {
          fail++;
          status.set("retrying", errors.join(" / "));
        }
        await wait(
          fail === 0
            ? INTERVAL_MS
            : Math.min(MAX_BACKOFF_MS, INTERVAL_MS * 2 ** (fail - 1)),
          signal,
        );
      }
      status.set("stopped");
    },
  };
}
