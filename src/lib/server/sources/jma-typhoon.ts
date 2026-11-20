/**
 * 台風の電文の、予報と確率の読み方 (docs/design.md の 2.8)。読み方の部品は jma-xml.ts と同じ。
 *
 * - 台風解析・予報情報 (VPTW60〜65) の実況の暴風域・強風域と、予報 (予報円・暴風警戒域・強さ)
 * - 台風の暴風域に入る確率 (VPTA50〜55)
 *
 * 仕様: 技術資料 (https://xml.kishou.go.jp/tec_material.html) の解説資料「台風解析・予報情報電文（新形式）」と
 * サンプル電文 (`10_04_03_170913_VPTW60.xml`・`76_01_01_200630_VPTA50.xml` など)。値は電文のまま持ち、
 * 計算で予報を足したり変えたりしない (docs/design.md の 5 章)。
 */

import type {
  CircleAxis,
  Status,
  TyphoonCircle,
  TyphoonForecast,
  TyphoonProbability,
} from "#lib/model.ts";

import { attr, child, children, text, textAt, type V } from "./jma-xml.ts";

const num = (v: string | undefined) => {
  const n = v === undefined || v.trim() === "" ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** 「+29.2+127.1/」の緯度・経度 */
function latLon(v: V): { lat: number; lon: number } | undefined {
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(text(v) ?? "");
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : undefined;
}

/** 度で書いた中心 (`type="中心位置（度）"`)。度分のものは読まない */
const degrees = (vs: V[]) =>
  latLon(vs.find((c) => attr(c, "type") === "中心位置（度）"));

/**
 * `jmx_eb:Axes` の半径 (km)。方向が「全域」なら方向を持たない。半径が「なし」(値が空) の軸は持たず、
 * どの軸にも半径が無ければ undefined
 */
function readAxes(circle: V): CircleAxis[] | undefined {
  const axes = children(child(circle, "jmx_eb:Axes"), "jmx_eb:Axis").flatMap(
    (a) => {
      const km = num(
        text(
          children(a, "jmx_eb:Radius").find((r) => attr(r, "unit") === "km"),
        ),
      );
      if (km === undefined) return [];
      const dir = child(a, "jmx_eb:Direction");
      const direction =
        attr(dir, "condition") === "全域" ? undefined : text(dir)?.trim();
      return [direction ? { direction, km } : { km }];
    },
  );
  return axes.length > 0 ? axes : undefined;
}

/** `Kind/Property` の並び (呼称・階級・中心・風) */
const properties = (info: V) =>
  children(child(info, "Item"), "Kind").map((k) => child(k, "Property"));

/** 風の Property の `WarningAreaPart` (暴風域・強風域・暴風警戒域) */
const warningArea = (props: V[], type: string) =>
  props
    .flatMap((p) => children(p, "WarningAreaPart"))
    .find((w) => attr(w, "type") === type);

const windMs = (props: V[], type: string) =>
  num(
    text(
      children(
        props.map((p) => child(p, "WindPart")).find((x) => x !== undefined),
        "jmx_eb:WindSpeed",
      ).find((w) => attr(w, "type") === type && attr(w, "unit") === "m/s"),
    ),
  );

/** 実況の暴風域と強風域。中心は実況の中心 */
export function readNowAreas(
  info: V,
  center: { lat?: number; lon?: number },
): { storm?: TyphoonCircle; gale?: TyphoonCircle } {
  if (center.lat === undefined || center.lon === undefined) return {};
  const { lat, lon } = center;
  const props = properties(info);
  const circle = (type: string): TyphoonCircle | undefined => {
    const axes = readAxes(child(warningArea(props, type), "jmx_eb:Circle"));
    return axes ? { lat, lon, axes } : undefined;
  };
  return { storm: circle("暴風域"), gale: circle("強風域") };
}

/** 「予報 (全角の空白) ２４時間後」の 24 (全角の数字も読む。全角の空白は \s に入る) */
function forecastHours(label: string): number | undefined {
  const half = label.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
  const m = /^予報\s*(\d+)時間後/.exec(half);
  return m ? Number(m[1]) : undefined;
}

/**
 * 台風解析・予報情報の予報 (`DateTime` の type が「予報」と「ｎ時間後」のもの)。時刻の順。実況と推定 (１時間後) は持たない。
 * 予報円の無い予報は持たない
 */
export function readForecasts(body: V): TyphoonForecast[] {
  const infos = children(
    children(body, "MeteorologicalInfos").find(
      (m) => attr(m, "type") === "台風情報",
    ),
    "MeteorologicalInfo",
  );
  const out: TyphoonForecast[] = [];
  for (const info of infos) {
    const dt = child(info, "DateTime");
    const hours = forecastHours(attr(dt, "type") ?? "");
    const time = text(dt)?.trim();
    if (hours === undefined || !time) continue;
    const props = properties(info);
    const center = props
      .map((p) => child(p, "CenterPart"))
      .find((x) => x !== undefined);
    const cls = props
      .map((p) => child(p, "ClassPart"))
      .find((x) => x !== undefined);
    const prob = children(center, "ProbabilityCircle").find(
      (c) => attr(c, "type") === "予報円",
    );
    const at = degrees(children(prob, "jmx_eb:BasePoint"));
    const axes = readAxes(prob);
    if (!at || !axes) continue;
    const speed = children(center, "jmx_eb:Speed").find(
      (s) => attr(s, "unit") === "km/h",
    );
    out.push({
      hours,
      time,
      circle: { ...at, axes },
      stormWarning: readAxes(
        child(warningArea(props, "暴風警戒域"), "jmx_eb:Circle"),
      ),
      className: textAt(cls, "jmx_eb:TyphoonClass"),
      areaClass: textAt(cls, "jmx_eb:AreaClass"),
      intensityClass: textAt(cls, "jmx_eb:IntensityClass"),
      location: textAt(center, "Location"),
      direction: textAt(center, "jmx_eb:Direction"),
      speed: attr(speed, "description") ?? text(speed),
      pressureHpa: num(textAt(center, "jmx_eb:Pressure")),
      maxWindMs: windMs(props, "最大風速"),
      maxGustMs: windMs(props, "最大瞬間風速"),
    });
  }
  return out.sort((a, b) => a.hours - b.hours);
}

/** 「PT24H」の 24 */
const durationHours = (v: string | undefined) => {
  const m = /^PT(\d+)H$/.exec(v?.trim() ?? "");
  return m ? Number(m[1]) : undefined;
};

/**
 * 台風の暴風域に入る確率 (VPTA50〜55) を読む。地域ごとに、3 時間ごとの確率 (`TimeSeriesInfo`) と
 * 1〜5 日の積算 (「台風の暴風域に入る確率（ｎ日積算）」) を持つ。どの値も 0% の地域は持たない
 */
export function readTyphoonProbability(
  head: V,
  body: V,
  status: Status,
  reportedAt: string,
): Omit<TyphoonProbability, "series"> & { eventId?: string } {
  const infos = child(body, "MeteorologicalInfos");
  const list = children(infos, "MeteorologicalInfo");
  const nameInfo = list.find((i) => attr(i, "type") === "台風呼称");
  const namePart = properties(nameInfo)
    .map((p) => child(p, "TyphoonNamePart"))
    .find((x) => x !== undefined);

  const areas: TyphoonProbability["areas"] = {};
  const entry = (item: V) => {
    const code = textAt(child(item, "Area"), "Code");
    if (!code) return undefined;
    const name = textAt(child(item, "Area"), "Name") ?? code;
    areas[code] ??= { name, steps: [], days: [] };
    return areas[code];
  };
  const part = (item: V) =>
    child(
      children(item, "Kind")
        .map((k) => child(k, "Property"))
        .find((p) => textAt(p, "Type") === "台風の暴風域に入る確率"),
      "FiftyKtWindProbabilityPart",
    );

  // 積算 (1 日〜5 日)。電文の並びのまま
  const dayHours: number[] = [];
  for (const info of list) {
    if (!/積算/.test(attr(info, "type") ?? "")) continue;
    const hours = durationHours(textAt(info, "Duration"));
    if (hours === undefined) continue;
    const i = dayHours.length;
    dayHours.push(hours);
    for (const item of children(info, "Item")) {
      const e = entry(item);
      if (e)
        e.days[i] = num(text(child(part(item), "FiftyKtWindProbability"))) ?? 0;
    }
  }

  // 3 時間ごと。時刻は TimeDefines の timeId、値は refID で引く
  const series = child(infos, "TimeSeriesInfo");
  const defines = children(child(series, "TimeDefines"), "TimeDefine");
  const stepTimes = defines.map((d) => textAt(d, "DateTime") ?? "");
  const index = new Map(defines.map((d, i) => [attr(d, "timeId") ?? "", i]));
  for (const item of children(series, "Item")) {
    const e = entry(item);
    if (!e) continue;
    for (const v of children(part(item), "FiftyKtWindProbability")) {
      const i = index.get(attr(v, "refID") ?? "");
      if (i !== undefined) e.steps[i] = num(text(v)) ?? 0;
    }
  }

  // 穴を 0 で埋め、どれも 0 の地域は外す
  for (const [code, e] of Object.entries(areas)) {
    e.steps = stepTimes.map((_, i) => e.steps[i] ?? 0);
    e.days = dayHours.map((_, i) => e.days[i] ?? 0);
    if (![...e.steps, ...e.days].some((p) => p > 0)) delete areas[code];
  }
  return {
    eventId: textAt(head, "EventID"),
    status,
    reportedAt,
    baseTime: textAt(head, "TargetDateTime") ?? reportedAt,
    number: textAt(namePart, "Number"),
    name: textAt(namePart, "Name"),
    stepTimes,
    dayHours,
    areas,
  };
}
