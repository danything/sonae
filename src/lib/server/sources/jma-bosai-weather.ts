/**
 * 気象庁ホームページ (bosai) の警報・注意報と府県気象防災速報の JSON。気象庁防災情報 XML の気象のフィード
 * (`jma-weather`) が取れない間だけ取得する予備 (docs/design.md の 2.8 の「予備」)。
 *
 * - **ふだんは取得しない** (状態は `standby`)。主のフィードが `STANDBY_GRACE_MS` より長く取れないときだけ、
 *   60 秒ごとに取る。主のフィードが取れたら、次の回から待機に戻る (配信元の負荷を増やさない)
 * - 警報・注意報は全国の一覧 `warning/data/r8/map.json` (府県予報区と電文の種別ごとのいちばん新しい報。約 1.3MB、圧縮して 48KB ほど) を
 *   1 分に 1 回まで、ETag と Last-Modified を付けて取る (変わっていなければ 304)。中身は気象警報・注意報 (R06) の電文と同じ形 (種別・市町村等・種類のコード・状態) で、
 *   種類の名前は無いので、解説資料の別表 3 の名前 (`WARNING_KIND_NAMES`) を当てる。府県予報区と市町村等の名前は、
 *   気象庁ホームページの地域の表 `common/const/area.json` から引く (予備を使い始めたときに 1 回だけ取る)
 * - 府県気象防災速報 (線状降水帯・短時間大雪) は、気象情報の一覧 `information/data/r8/information.json` を ETag を
 *   付けて取り、新しい速報の本文 `information/data/r8/denbun/<名前>.json` を 1 回だけ取る
 * - 主のフィードが最後に取れた時刻より前の報は採らない (気象庁 XML で受けている)
 * - **公式の API ではない** (ホームページの表示用で、予告なく変わる)。形が変わって読めなくなったら、その回を捨てて
 *   状態にエラーを出すだけにする (ほかの情報源と画面は止まらない)
 * - 受けた報には `source: "jma-bosai"` を付ける。気象庁 XML の同じ報が届いたら、そちらに置き換わる (store.ts)
 *
 * 利用条件は気象庁ホームページの利用規約 (公共データ利用規約 第 1.0 版)。出典は「気象庁ホームページ」。
 * 警報・注意報は気象庁の発表を変えずに中継する (段は種類のコードから。docs/design.md の 5 章)。
 */

import {
  type SourceStatus,
  WARNING_CODES,
  WARNING_PHENOMENON,
  type WarningArea,
  type WarningCode,
  type WarningKind,
  warningLevel,
  type WeatherInfo,
  type WeatherWarning,
} from "#lib/model.ts";

import { BosaiFetcher, BosaiHttpError } from "./bosai-fetch.ts";
import { sleep, StatusTracker } from "./retry.ts";
import type { Incoming, Source, SourceContext } from "./types.ts";

const BASE = "https://www.jma.go.jp/bosai";
export const BOSAI_WARNING_MAP = `${BASE}/warning/data/r8/map.json`;
export const BOSAI_AREA = `${BASE}/common/const/area.json`;
export const BOSAI_INFORMATION = `${BASE}/information/data/r8/information.json`;
export const bosaiDenbun = (name: string) =>
  `${BASE}/information/data/r8/denbun/${name}.json`;

/** 主のフィードがこれより長く取れなければ、予備を取得する (主は 60 秒ごとなので、続けて 3 回ほど取れないとき) */
export const STANDBY_GRACE_MS = 3 * 60_000;
/** 主のフィードが最後に取れた時刻から、これだけ前の報までは予備でも採る (フィードに載るまでの遅れの分) */
const OVERLAP_MS = 10 * 60_000;
/** 主のフィードが一度も取れていないときに、予備で採る報の古さの上限 */
const COLD_START_MS = 24 * 60 * 60_000;
const INTERVAL_MS = 60_000;
/**
 * 全国の警報・注意報の一覧 (`map.json`) を取りに行く最短の間隔。配信元の max-age (60 秒) と同じ。取りに行っても、
 * 変わっていなければ 304 で本体を運ばない
 */
export const MAP_MIN_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
/** 一回に取る気象防災速報の本文の数の上限 */
const MAX_DENBUN = 10;
/** 地域の表を取り直す間隔 (表に無いコードが来たとき) */
const AREA_REFRESH_MS = 6 * 60 * 60_000;
const STANDBY_REASON = "気象庁 XML (気象) が取れない間だけ取ります";

/**
 * 気象警報・注意報 (R06) の種類のコードと名前 (解説資料「気象警報・注意報（Ｒ０６）」の別表 3)。
 * 電文の `Kind/Name` と同じ字 (全角の数字) にする。サンプル電文の名前と、気象庁ホームページの警報の画面の
 * 名前で確かめた (2026-11-28)
 */
export const WARNING_KIND_NAMES: Readonly<Record<string, string>> = {
  "33": "レベル５大雨特別警報",
  "43": "レベル４大雨危険警報",
  "03": "レベル３大雨警報",
  "10": "レベル２大雨注意報",
  "39": "レベル５土砂災害特別警報",
  "49": "レベル４土砂災害危険警報",
  "09": "レベル３土砂災害警報",
  "29": "レベル２土砂災害注意報",
  "38": "レベル５高潮特別警報",
  "48": "レベル４高潮危険警報",
  "08": "レベル３高潮警報",
  "19": "レベル２高潮注意報",
  "35": "暴風特別警報",
  "05": "暴風警報",
  "15": "強風注意報",
  "32": "暴風雪特別警報",
  "02": "暴風雪警報",
  "13": "風雪注意報",
  "37": "波浪特別警報",
  "07": "波浪警報",
  "16": "波浪注意報",
  "36": "大雪特別警報",
  "06": "大雪警報",
  "12": "大雪注意報",
  "14": "雷注意報",
  "17": "融雪注意報",
  "20": "濃霧注意報",
  "21": "乾燥注意報",
  "22": "なだれ注意報",
  "23": "低温注意報",
  "24": "霜注意報",
  "25": "着氷注意報",
  "26": "着雪注意報",
};

/** 主のフィードが取れていないか (予備を取得するか) */
export function primaryDown(s: SourceStatus, now: number): boolean {
  if (s.state === "connected" || s.state === "off") return false;
  const last = Date.parse(s.lastSeenAt ?? s.since);
  return !Number.isFinite(last) || now - last > STANDBY_GRACE_MS;
}

/** 地域の表のうち使うところ */
export interface BosaiAreas {
  /** 府県予報区のコードと名前 */
  offices: Map<string, string>;
  /** 一次細分区域のコードと、その府県予報区のコード */
  class10: Map<string, string>;
  /** 市町村等のコードと名前 */
  class20: Map<string, string>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]) : []);

/** 地域の表 (`area.json`) を読む。形が違えば例外 */
export function parseBosaiAreas(text: string): BosaiAreas {
  const o = JSON.parse(text) as unknown;
  if (!isObject(o) || !isObject(o.offices) || !isObject(o.class20s))
    throw new Error("地域の表の形が違います");
  const pick = (v: unknown, key: "name" | "parent") => {
    const m = new Map<string, string>();
    if (isObject(v))
      for (const [code, a] of Object.entries(v)) {
        const s = isObject(a) ? str(a[key]) : undefined;
        if (s) m.set(code, s);
      }
    return m;
  };
  return {
    offices: pick(o.offices, "name"),
    class10: pick(o.class10s, "parent"),
    class20: pick(o.class20s, "name"),
  };
}

/** 警報・注意報の 1 つの報 (`map.json` の 1 項目) を読んだもの */
export interface BosaiWarning {
  /** 情報源の中での重複の除去の鍵 (`<種別>_<府県予報区>_<発表の時刻 (UTC)>`) */
  key: string;
  /** 電文の時刻 (UTC。主のフィードが最後に取れた時刻と比べる) */
  controlAt: string;
  body: string;
  warning: Omit<WeatherWarning, "updatedAt">;
}

/**
 * 全国の警報・注意報の一覧 (`map.json`) を読む。配列でなければ例外 (その回を捨てる)。
 * 府県予報区・市町村等が地域の表に無い項目は `unknown` に数える (表を取り直す)。
 * 知らない種類のコードのある項目は、名前を付けられないので採らない (`unknown` に数える)
 */
export function parseBosaiWarnings(
  text: string,
  areas: BosaiAreas,
): { warnings: BosaiWarning[]; unknown: number } {
  const all = JSON.parse(text) as unknown;
  if (!Array.isArray(all))
    throw new Error("警報・注意報の一覧が配列ではありません");
  const warnings: BosaiWarning[] = [];
  let unknown = 0;
  for (const v of all) {
    if (!isObject(v) || !isObject(v.warning)) continue;
    const code = str(v.dataTypeCode);
    if (!code || !(WARNING_CODES as readonly string[]).includes(code)) continue;
    const reportedAt = str(v.reportDatetime);
    const controlAt = str(v.controlDatetime);
    if (!reportedAt || !controlAt || !Number.isFinite(Date.parse(reportedAt)))
      continue;
    const firstClass10 = list(v.warning.class10Items)
      .map((i) => (isObject(i) ? str(i.areaCode) : undefined))
      .find(Boolean);
    const officeCode = firstClass10
      ? areas.class10.get(firstClass10)
      : undefined;
    const officeName = officeCode ? areas.offices.get(officeCode) : undefined;
    if (!officeCode || !officeName) {
      unknown++;
      continue;
    }
    const active: WarningArea[] = [];
    const released: WarningArea[] = [];
    let readable = true;
    for (const item of list(v.warning.class20Items)) {
      if (!isObject(item)) continue;
      const areaCode = str(item.areaCode);
      if (!areaCode) continue;
      const on: WarningKind[] = [];
      const off: WarningKind[] = [];
      for (const k of list(item.kinds)) {
        const kindCode = isObject(k) ? str(k.code) : undefined;
        // 「発表警報・注意報はなし」は種類のコードが無い
        if (!isObject(k) || !kindCode) continue;
        const name = WARNING_KIND_NAMES[kindCode];
        if (!name) {
          readable = false;
          continue;
        }
        const status = str(k.status) ?? "";
        const kind: WarningKind = {
          code: kindCode,
          name,
          level: warningLevel(kindCode),
          status,
        };
        if (status === "解除") off.push(kind);
        else if (kind.level > 0) on.push(kind);
      }
      if (on.length === 0 && off.length === 0) continue;
      const areaName = areas.class20.get(areaCode);
      if (!areaName) {
        readable = false;
        continue;
      }
      if (on.length > 0)
        active.push({ code: areaCode, name: areaName, kinds: on });
      if (off.length > 0)
        released.push({ code: areaCode, name: areaName, kinds: off });
    }
    if (!readable) {
      unknown++;
      continue;
    }
    const wc = code as WarningCode;
    warnings.push({
      key: `${wc}_${officeCode}_${controlAt}`,
      controlAt,
      body: JSON.stringify(v),
      warning: {
        id: `${wc}-${officeCode}`,
        code: wc,
        office: { code: officeCode, name: officeName },
        // 気象庁ホームページには訓練・試験の報は載らない
        status: "normal",
        infoType: str(v.infoType) === "訂正" ? "訂正" : "発表",
        reportedAt,
        // JSON に電文の表題 (Head/Title) は無い。表題は画面に出していないので、府県予報区と現象の名前で置く
        title: `${officeName}の${WARNING_PHENOMENON[wc]}の警報・注意報`,
        headline: str(v.headlineText) ?? "",
        areas: active,
        released,
        source: "jma-bosai",
      },
    });
  }
  return { warnings, unknown };
}

/** 気象情報の一覧のうち、府県気象防災速報 (VPBS50) の 1 項目 */
export interface BosaiInfoItem {
  /** 本文の名前 (`20261126190843_0_VPBS50_471000`) */
  name: string;
  /** 電文の時刻 (UTC) */
  controlAt: string;
}

const DENBUN_NAME = /^\d{14}_\d+_VPBS50_\d{6}$/;

/** 気象情報の一覧 (`information.json`) から、府県気象防災速報を新しい順に。配列でなければ例外 */
export function parseBosaiInformation(text: string): BosaiInfoItem[] {
  const all = JSON.parse(text) as unknown;
  if (!Array.isArray(all))
    throw new Error("気象情報の一覧が配列ではありません");
  return all
    .flatMap((v): BosaiInfoItem[] => {
      if (!isObject(v) || v.header !== "VPBS50") return [];
      const name = str(v.jsonName);
      const controlAt = str(v.datetime);
      if (!name || !DENBUN_NAME.test(name) || !controlAt) return [];
      if (!Number.isFinite(Date.parse(controlAt))) return [];
      return [{ name, controlAt }];
    })
    .sort((a, b) => Date.parse(b.controlAt) - Date.parse(a.controlAt));
}

/**
 * 府県気象防災速報の本文 (`denbun/<名前>.json`) を、気象庁 XML の VPBS50 と同じ気象の報にする
 * (jma-weather.ts の `parseWeatherXml` と同じ id・一連の情報の鍵・情報タグ・地域)。
 * 記録雨だけの速報と、情報タグの無い速報 (取消を除く) は、XML と同じく採らない (undefined)。形が違えば例外
 */
export function parseBosaiDenbun(
  text: string,
): Omit<WeatherInfo, "updatedAt" | "cancelled"> | undefined {
  const d = JSON.parse(text) as unknown;
  if (!isObject(d)) throw new Error("気象防災速報の形が違います");
  const reportedAt = str(d.reportDatetime);
  if (!reportedAt || !Number.isFinite(Date.parse(reportedAt)))
    throw new Error("発表の時刻がありません");
  const code = "VPBS50";
  const infoType =
    d.infoType === "取消" ? "取消" : d.infoType === "訂正" ? "訂正" : "発表";
  const tags: string[] = [];
  const areas = new Map<string, string>();
  for (const info of list(d.headlineInfo)) {
    if (!isObject(info)) continue;
    const kinds = list(info.kind).filter(isObject);
    if (info.type === "情報タグ")
      for (const k of kinds) {
        const c = str(k.condition);
        if (c) tags.push(c);
      }
    if (kinds.some((k) => k.condition === "なし")) continue;
    for (const group of list(info.areas))
      for (const a of isObject(group) ? list(group.area) : []) {
        const ac = isObject(a) ? str(a.code) : undefined;
        const an = isObject(a) ? str(a.name) : undefined;
        if (ac && an && !areas.has(ac)) areas.set(ac, an);
      }
  }
  const kindName = tags.join("・") || undefined;
  if (infoType !== "取消" && (kindName === undefined || kindName === "記録雨"))
    return undefined;
  const digits = reportedAt.replace(/[^0-9]/g, "").slice(0, 14);
  const series = str(d.eventId)?.split("_")[0] || `${code}${digits}`;
  return {
    id: `${code}-${series}-${digits}`,
    kind: "bosai",
    code,
    series: `bosai-${series}`,
    // 気象庁ホームページには訓練・試験の報は載らない
    status: "normal",
    infoType,
    reportedAt,
    title: str(d.headTitle) ?? "府県気象防災速報",
    headline: str(d.headlineText) ?? "",
    kindName,
    areas: [...areas].map(([c, name]) => ({ code: c, name })),
    source: "jma-bosai",
  };
}

export interface BosaiWeatherOptions {
  /** 主の源 (気象庁 XML の気象のフィード) のいまの状態 */
  primary: () => SourceStatus;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (m: string) => void;
  now?: () => number;
}

export function bosaiWeatherSource(
  ctx: SourceContext,
  opts: BosaiWeatherOptions,
): Source {
  const id = "jma-bosai-weather" as const;
  const status = new StatusTracker(id, ctx.onStatus, {
    kind: "poll",
    everyMs: INTERVAL_MS,
  });
  const http = new BosaiFetcher(opts.fetch ?? fetch);
  const wait = opts.sleep ?? sleep;
  const log = opts.log ?? ((m: string) => console.log(m));
  const now = opts.now ?? Date.now;
  const tag = `[${id}]`;
  let areas: { table: BosaiAreas; at: number } | undefined;
  /** 本文が 404・410 だった速報 (一覧に載っている間は取り直さない) */
  const gone = new Set<string>();
  /** 全国の警報・注意報の一覧を最後に取りに行った時刻 (`MAP_MIN_INTERVAL_MS` より短くは取らない) */
  let mapAt = Number.NEGATIVE_INFINITY;
  /** 採れなかった報のある一覧の本文 (地域の表を取り直したら、一覧を取り直さずに読み直す) */
  let pendingMap: string | undefined;

  async function areaTable(signal: AbortSignal): Promise<BosaiAreas> {
    if (areas) return areas.table;
    const r = await http.get(BOSAI_AREA, signal, false);
    if (!r) throw new Error("地域の表が取れませんでした");
    areas = { table: parseBosaiAreas(r.text), at: now() };
    return areas.table;
  }

  /** 主のフィードが最後に取れた時刻 (余裕を持たせる)。これより前の報は気象庁 XML で受けている */
  function cutoff(): number {
    const p = opts.primary();
    const last = p.lastSeenAt ? Date.parse(p.lastSeenAt) : Number.NaN;
    return Number.isFinite(last) ? last - OVERLAP_MS : now() - COLD_START_MS;
  }

  async function warnings(signal: AbortSignal, since: number): Promise<void> {
    const table = await areaTable(signal);
    let text: string;
    let fresh: Parameters<typeof http.remember>[1] | undefined;
    if (now() - mapAt < MAP_MIN_INTERVAL_MS) {
      if (pendingMap === undefined) return;
      text = pendingMap;
    } else {
      mapAt = now();
      // 変わっていなければ 304 で本体を運ばない (落ちている間の量を抑える。docs/design.md の 2.8 の「予備」)
      const r = await http.get(BOSAI_WARNING_MAP, signal, true);
      if (r) {
        text = r.text;
        fresh = r.validators;
      } else if (pendingMap !== undefined) text = pendingMap;
      else return;
    }
    const { warnings: ws, unknown } = parseBosaiWarnings(text, table);
    // 控えは読めた後に覚える (読めない形の一覧を覚えると、次の 304 で受信中に戻り、エラーが消える)
    if (fresh) http.remember(BOSAI_WARNING_MAP, fresh);
    // 採れなかった報があっても控えは覚え (変わっていない一覧を取り直さない)、本文を手元に残して読み直す
    pendingMap = unknown > 0 ? text : undefined;
    if (unknown > 0) {
      log(
        `${tag} 地域の表に無いか、名前の分からない種類の報が ${unknown} あります`,
      );
      // 地域の表が古いかもしれないので、時間を置いて取り直す
      if (areas && now() - areas.at > AREA_REFRESH_MS) areas = undefined;
    }
    for (const w of ws) {
      if (Date.parse(w.controlAt) < since || ctx.seen(id, w.key)) continue;
      ctx.emit({
        source: id,
        key: w.key,
        code: w.warning.code,
        body: w.body,
        items: [{ type: "warning", warning: w.warning }],
      });
      status.seen(true);
    }
  }

  async function information(
    signal: AbortSignal,
    since: number,
  ): Promise<void> {
    const r = await http.get(BOSAI_INFORMATION, signal, true);
    if (!r) return;
    const items = parseBosaiInformation(r.text);
    const listed = new Set(items.map((i) => i.name));
    for (const n of gone) if (!listed.has(n)) gone.delete(n);
    const todo = items
      .filter(
        (i) =>
          Date.parse(i.controlAt) >= since &&
          !gone.has(i.name) &&
          !ctx.seen(id, i.name),
      )
      .reverse();
    let left = todo.length > MAX_DENBUN;
    for (const i of todo.slice(0, MAX_DENBUN)) {
      if (signal.aborted) return;
      let body: string;
      try {
        const res = await http.get(bosaiDenbun(i.name), signal, false);
        if (!res) continue;
        body = res.text;
      } catch (err) {
        const code = err instanceof BosaiHttpError ? err.status : undefined;
        log(`${tag} ${err}`);
        if (code === 404 || code === 410) gone.add(i.name);
        else left = true;
        continue;
      }
      let incoming: Incoming;
      try {
        const info = parseBosaiDenbun(body);
        incoming = {
          source: id,
          key: i.name,
          code: "VPBS50",
          body,
          items: info
            ? [{ type: "weather", info }]
            : [{ type: "other", code: "VPBS50" }],
        };
      } catch (err) {
        // 読めない本文も原文は残す (読み方を直したら流し直す)
        log(`${tag} ${i.name} を読めませんでした: ${err}`);
        incoming = {
          source: id,
          key: i.name,
          code: "VPBS50",
          body,
          items: [],
          error: String(err),
        };
      }
      ctx.emit(incoming);
      status.seen(true);
    }
    // 取り残しがあれば、次の回も一覧を 304 にせず読み直す
    if (!left) http.remember(BOSAI_INFORMATION, r.validators);
  }

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
        // 主が落ちている間は主の最後に取れた時刻が動かないので、境は落ちてから変わらない。
        // 一覧が 304 の間に境が動いても、受けた報は ctx.seen で除くので二重にはならない
        const since = cutoff();
        // 警報・注意報と気象防災速報は別の一覧なので、片方が取れなくても、もう片方は取る
        const errors: string[] = [];
        for (const part of [warnings, information]) {
          try {
            await part(signal, since);
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
          status.set("connected");
          status.recovered();
        } else {
          fail++;
          status.set("retrying", errors.join(" / "));
        }
        // 待ちを延ばしている間も 1 分ごとに主を見て、戻っていれば切り上げる (待ちが明けるまで「再接続中」に残さない)
        let left =
          fail === 0
            ? INTERVAL_MS
            : Math.min(MAX_BACKOFF_MS, INTERVAL_MS * 2 ** (fail - 1));
        while (left > 0 && !signal.aborted) {
          const step = Math.min(left, INTERVAL_MS);
          await wait(step, signal);
          left -= step;
          if (left > 0 && !primaryDown(opts.primary(), now())) break;
        }
      }
      status.set("stopped");
    },
  };
}
