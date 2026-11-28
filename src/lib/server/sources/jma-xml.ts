/**
 * 気象庁防災情報 XML の電文を、正規化したモデルに読む。
 *
 * 仕様: 気象庁防災情報 XML フォーマット 技術資料 (https://xml.kishou.go.jp/tec_material.html)。
 * 読むのは Bun 組み込みの `Bun.XML.parse` (外部の DTD・実体を読まない)。compact の形式では、
 * 属性も子も無い要素は文字列、そうでなければ `@属性`・`#text`・子の名前をキーにしたオブジェクトになる。
 */

import { XML } from "bun";

import {
  type AreaIntensity,
  type AreaLongPeriod,
  type AshArea,
  type AshWindow,
  type EarthquakeCount,
  type Hypocenter,
  isIntensity,
  isLgClass,
  type LgClass,
  type ObservedIntensity,
  type QuakeKind,
  type QuakeReport,
  type StationIntensity,
  type StationLongPeriod,
  type Status,
  type TsunamiArea,
  type TsunamiGrade,
  type TsunamiObservation,
  UNRECEIVED,
  type Volcano,
  VOLCANO_CODES,
  type VolcanoArea,
  type VolcanoAsh,
  type VolcanoCode,
  volcanoLevel,
} from "#lib/model.ts";

import type { Normalized } from "./types.ts";

export type V = XML.Value | XML.Value[] | undefined;

export const first = (v: V): XML.Value | undefined =>
  Array.isArray(v) ? v[0] : v;
export const all = (v: V): XML.Value[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

export function child(v: V, name: string): XML.Value | undefined {
  const el = first(v);
  return typeof el === "object" ? first(el[name]) : undefined;
}
export function children(v: V, name: string): XML.Value[] {
  const el = first(v);
  return typeof el === "object" ? all(el[name]) : [];
}
/** 子をたどる (`a/b/c`)。途中が並びなら最初のものをたどる */
export function at(v: V, path: string): XML.Value | undefined {
  let cur: XML.Value | undefined = first(v);
  for (const name of path.split("/")) cur = child(cur, name);
  return cur;
}
export function text(v: V): string | undefined {
  const el = first(v);
  if (el === undefined) return undefined;
  if (typeof el === "string") return el;
  const t = el["#text"];
  return typeof t === "string" ? t : undefined;
}
export const textAt = (v: V, path: string) => {
  const t = text(at(v, path))?.trim();
  return t === "" ? undefined : t;
};
export function attr(v: V, name: string): string | undefined {
  const el = first(v);
  if (typeof el !== "object") return undefined;
  const a = el[`@${name}`];
  return typeof a === "string" ? a : undefined;
}

/** 数の文字列を数に。空や読めないものは undefined */
export const num = (v: string | undefined) => {
  const n = v === undefined || v.trim() === "" ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export const STATUS: Record<string, Status> = {
  通常: "normal",
  訓練: "training",
  試験: "test",
};

export type InfoType = "発表" | "訂正" | "取消";
export const infoTypeOf = (v: string | undefined): InfoType =>
  v === "取消" ? "取消" : v === "訂正" ? "訂正" : "発表";

/** 「震度６弱」や `6-`、「震度５弱以上未入電」を震度の階級に */
export function readIntensity(
  value: string | undefined,
): ObservedIntensity | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (isIntensity(v)) return v;
  if (v.includes("未入電")) return UNRECEIVED;
  const m = /震度([１-７1-7])([弱強]?)/.exec(v);
  if (!m) return undefined;
  const n = String("１２３４５６７".indexOf(m[1] ?? "") + 1 || m[1]);
  const s = m[2] === "弱" ? "-" : m[2] === "強" ? "+" : "";
  const out = `${n}${s}`;
  return isIntensity(out) ? out : undefined;
}

/**
 * `jmx_eb:Coordinate` (ISO 6709) の `+39.0+140.9-10000/` を緯度・経度・深さに。
 * 深さはメートルで、下向きが負。`+0` は「ごく浅い」。深さが無ければ「深さ不明」。空なら震源不明
 */
export function readCoordinate(
  value: string | undefined,
): Pick<Hypocenter, "lat" | "lon" | "depthKm"> | undefined {
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+)?\/$/.exec(
    value?.trim() ?? "",
  );
  if (!m) return undefined;
  const depth = m[3] === undefined ? undefined : -Number(m[3]) / 1000;
  return {
    lat: Number(m[1]),
    lon: Number(m[2]),
    depthKm: depth === undefined ? undefined : Math.max(0, depth),
  };
}

function readEarthquake(body: V) {
  const eq = child(body, "Earthquake");
  if (eq === undefined) return {};
  const area = at(eq, "Hypocenter/Area");
  // 度分の座標 (type="震源位置（度分）") ではなく、度の座標を読む
  const coords = children(area, "jmx_eb:Coordinate");
  const coord = coords.find((c) => attr(c, "type") === undefined) ?? coords[0];
  const name = textAt(area, "Name");
  const hypocenter: Hypocenter | undefined =
    name === undefined ? undefined : { name, ...readCoordinate(text(coord)) };
  const mag = child(eq, "jmx_eb:Magnitude");
  const raw = text(mag);
  const n = raw === undefined ? Number.NaN : Number(raw);
  return {
    originTime: textAt(eq, "OriginTime"),
    hypocenter,
    magnitude: mag === undefined ? undefined : Number.isFinite(n) ? n : null,
    magnitudeText: attr(mag, "description"),
  };
}

function readObservation(body: V): {
  maxInt?: ObservedIntensity;
  areas: AreaIntensity[];
  stations: StationIntensity[];
} {
  const obs = at(body, "Intensity/Observation");
  const areas: AreaIntensity[] = [];
  const stations: StationIntensity[] = [];
  for (const pref of children(obs, "Pref")) {
    const prefName = textAt(pref, "Name");
    for (const area of children(pref, "Area")) {
      const int =
        readIntensity(textAt(area, "MaxInt")) ??
        readIntensity(textAt(area, "Condition"));
      const name = textAt(area, "Name");
      if (int && name)
        areas.push({ code: textAt(area, "Code"), name, pref: prefName, int });
      for (const city of children(area, "City")) {
        for (const st of children(city, "IntensityStation")) {
          const sInt = readIntensity(textAt(st, "Int"));
          const sName = textAt(st, "Name");
          if (sInt && sName)
            stations.push({
              code: textAt(st, "Code"),
              name: sName,
              pref: prefName,
              int: sInt,
            });
        }
      }
    }
  }
  return { maxInt: readIntensity(textAt(obs, "MaxInt")), areas, stations };
}

/** 長周期地震動に関する観測情報の観測 (Body/Intensity/Observation。都道府県・地域・観測点の 3 段) */
function readLongPeriod(body: V): {
  maxInt?: ObservedIntensity;
  maxLg: LgClass;
  category?: 1 | 2 | 3 | 4;
  areas: AreaLongPeriod[];
  stations: StationLongPeriod[];
} {
  const obs = at(body, "Intensity/Observation");
  const lg = (v: string | undefined): LgClass | undefined =>
    isLgClass(v) ? v : undefined;
  const areas: AreaLongPeriod[] = [];
  const stations: StationLongPeriod[] = [];
  for (const pref of children(obs, "Pref")) {
    const prefName = textAt(pref, "Name");
    for (const area of children(pref, "Area")) {
      const name = textAt(area, "Name");
      const areaLg = lg(textAt(area, "MaxLgInt"));
      if (name && areaLg)
        areas.push({
          code: textAt(area, "Code"),
          name,
          pref: prefName,
          lg: areaLg,
          maxInt: readIntensity(textAt(area, "MaxInt")),
        });
      for (const st of children(area, "IntensityStation")) {
        const sName = textAt(st, "Name");
        const sLg = lg(textAt(st, "LgInt"));
        const sva = Number(textAt(st, "Sva"));
        if (sName && sLg)
          stations.push({
            name: sName,
            pref: prefName,
            area: name,
            lg: sLg,
            int: readIntensity(textAt(st, "Int")),
            sva: Number.isFinite(sva) ? sva : undefined,
          });
      }
    }
  }
  const category = Number(textAt(obs, "LgCategory"));
  return {
    maxInt: readIntensity(textAt(obs, "MaxInt")),
    maxLg: lg(textAt(obs, "MaxLgInt")) ?? "0",
    category:
      category === 1 || category === 2 || category === 3 || category === 4
        ? category
        : undefined,
    areas,
    stations,
  };
}

function readComments(body: V): string[] {
  const c = child(body, "Comments");
  const out: string[] = [];
  for (const name of ["ForecastComment", "VarComment"]) {
    for (const el of children(c, name)) {
      const t = textAt(el, "Text");
      if (t) out.push(...t.split("\n").filter((s) => s.trim() !== ""));
    }
  }
  const free = textAt(c, "FreeFormComment");
  if (free) out.push(free);
  return out;
}

/** 警報等情報要素／津波警報・注意報・予報 のコード。知らないコードは名前で見る */
export function tsunamiGrade(
  code: string | undefined,
  name: string,
): TsunamiGrade {
  switch (code) {
    case "52":
    case "53":
      return "major";
    case "51":
      return "warning";
    case "62":
      return "watch";
    case "71":
    case "72":
    case "73":
      return "forecast";
    case "00":
    case "50":
    case "60":
      return "none";
  }
  if (name.includes("解除") || name.includes("なし")) return "none";
  if (name.includes("大津波警報")) return "major";
  if (name.includes("津波警報")) return "warning";
  if (name.includes("注意報")) return "watch";
  if (name.includes("予報")) return "forecast";
  return "none";
}

function readTsunamiForecast(body: V): TsunamiArea[] | undefined {
  const fc = at(body, "Tsunami/Forecast");
  if (fc === undefined) return undefined;
  return children(fc, "Item").flatMap((item): TsunamiArea[] => {
    const name = textAt(item, "Area/Name");
    const kind = at(item, "Category/Kind");
    const kindName = textAt(kind, "Name") ?? "";
    if (!name) return [];
    const fh = child(item, "FirstHeight");
    const height = at(item, "MaxHeight/jmx_eb:TsunamiHeight");
    return [
      {
        code: textAt(item, "Area/Code"),
        name,
        grade: tsunamiGrade(textAt(kind, "Code"), kindName),
        kindName,
        immediate:
          textAt(fh, "Condition") === "ただちに津波来襲と予測" || undefined,
        arrivalTime: textAt(fh, "ArrivalTime"),
        condition: textAt(fh, "Condition"),
        maxHeightText:
          // 高さの説明が無いか空なら、条件 (「高い」など) に落とす
          attr(height, "description") || textAt(item, "MaxHeight/Condition"),
      },
    ];
  });
}

function readTsunamiObservation(
  body: V,
  offshore: boolean,
): TsunamiObservation[] {
  const obs = at(body, "Tsunami/Observation");
  return children(obs, "Item").flatMap((item) => {
    const area = textAt(item, "Area/Name");
    return children(item, "Station").flatMap((st): TsunamiObservation[] => {
      const station = textAt(st, "Name");
      if (!station) return [];
      const height = at(st, "MaxHeight/jmx_eb:TsunamiHeight");
      return [
        {
          area,
          station,
          offshore,
          arrivalTime: textAt(st, "FirstHeight/ArrivalTime"),
          initial: textAt(st, "FirstHeight/Initial"),
          maxHeightText: attr(height, "description") || undefined,
          condition:
            textAt(st, "MaxHeight/Condition") ??
            textAt(st, "FirstHeight/Condition"),
        },
      ];
    });
  });
}

const QUAKE_CODES = ["VXSE51", "VXSE52", "VXSE53", "VXSE61"] as const;
type QuakeCode = (typeof QUAKE_CODES)[number];
const ADVISORY_CODES = [
  "VYSE50",
  "VYSE51",
  "VYSE52",
  "VYSE60",
  "VZSE40",
  "VXSE56",
  "VXSE60",
] as const;
type AdvisoryCode = (typeof ADVISORY_CODES)[number];

/** 地震回数に関する情報 (VXSE60) の期間ごとの回数と、次の発表の予定 */
function readEarthquakeCount(body: V): {
  counts: EarthquakeCount[];
  next?: string;
} {
  return {
    counts: children(child(body, "EarthquakeCount"), "Item").map((item) => ({
      type: attr(item, "type") ?? "",
      start: textAt(item, "StartTime"),
      end: textAt(item, "EndTime"),
      number: num(textAt(item, "Number")),
      felt: num(textAt(item, "FeltNumber")),
    })),
    next: textAt(body, "NextAdvisory"),
  };
}

/** 火山: 噴火警報・予報・解説情報・観測報・降灰予報・噴火速報・推定噴煙流向報 (docs/design.md の 3 章) */
const isVolcanoCode = (c: string): c is VolcanoCode =>
  (VOLCANO_CODES as readonly string[]).includes(c);

/** 降灰予報 (定時・速報・詳細) */
const isAshCode = (c: VolcanoCode) =>
  c === "VFVO53" || c === "VFVO54" || c === "VFVO55";

/**
 * 種別ごとの、対象の火山と対象の市町村等の VolcanoInfo の type。
 * 降灰予報は令和 8 年 11 月の資料で「火山灰予報」に名前が変わる予定 (提供の時期は未定) なので、どちらも読む
 */
const VOLCANO_INFO: Record<
  VolcanoCode,
  { target: string[]; cities: string[] }
> = {
  VFVO50: {
    target: ["噴火警報・予報（対象火山）"],
    cities: ["噴火警報・予報（対象市町村等）"],
  },
  VFVO51: { target: ["火山の状況に関する解説情報（対象火山）"], cities: [] },
  VFVO52: { target: ["噴火に関する火山観測報"], cities: [] },
  VFVO53: {
    target: ["降灰予報（対象火山）", "火山灰予報（対象火山）"],
    cities: ["降灰予報（対象市町村等）", "火山灰予報（対象市町村等）"],
  },
  VFVO54: {
    target: ["降灰予報（対象火山）", "火山灰予報（対象火山）"],
    cities: ["降灰予報（対象市町村等）", "火山灰予報（対象市町村等）"],
  },
  VFVO55: {
    target: ["降灰予報（対象火山）", "火山灰予報（対象火山）"],
    cities: ["降灰予報（対象市町村等）", "火山灰予報（対象市町村等）"],
  },
  VFVO56: {
    target: ["噴火速報"],
    cities: ["噴火速報（対象市町村等）"],
  },
  VFVO60: { target: ["推定噴煙流向報"], cities: [] },
};

/**
 * 警戒の段 (噴火警戒レベル) を種類のコードから取る種別。ほかの種別の種類のコード (降灰予報の 06〜08・
 * 観測報の 51 爆発・52 噴火など) は警報の種類ではないので段にしない (火山灰予報 (速報) の 22 は、
 * レベルの無い火山の火口周辺危険と同じ数で、段にすると取り違える)
 */
const LEVELED: ReadonlySet<VolcanoCode> = new Set([
  "VFVO50",
  "VFVO51",
  "VFVO56",
]);

/** 噴煙 (VolcanoObservation/ColorPlume)。電文の説明の文のまま */
function readPlume(body: V): Volcano["plume"] {
  const plume = at(body, "VolcanoObservation/ColorPlume");
  if (plume === undefined) return undefined;
  const desc = (name: string) => {
    const el = child(plume, name);
    return attr(el, "description") ?? textAt(el, "#text");
  };
  const out = {
    height: desc("jmx_eb:PlumeHeightAboveCrater"),
    seaLevel: desc("jmx_eb:PlumeHeightAboveSeaLevel"),
    direction: desc("jmx_eb:PlumeDirection"),
  };
  return out.height || out.seaLevel || out.direction ? out : undefined;
}

/**
 * 降灰予報の範囲の多角形 (`jmx_eb:Polygon`。`+31.5946+130.6400/+31.5902+130.6600/…/`) を [経度, 緯度] の並びに。
 * 点は電文のまま (度)。閉じていなければ閉じる。点が 3 つに満たないものは捨てる
 */
export function readAshPolygon(value: string | undefined): [number, number][] {
  const pts = (value ?? "").split("/").flatMap((s): [number, number][] => {
    const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(s.trim());
    if (!m) return [];
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    return Number.isFinite(lat) && Number.isFinite(lon) ? [[lon, lat]] : [];
  });
  if (pts.length < 3) return [];
  const [a, z] = [pts[0], pts.at(-1)];
  if (a && z && (a[0] !== z[0] || a[1] !== z[1])) pts.push([a[0], a[1]]);
  return pts;
}

/** 降灰予報の範囲 (`Body/AshInfos/AshInfo`。docs/design.md の 2 章の「火山」)。範囲が無ければ空 */
function readAshWindows(body: V): AshWindow[] {
  return children(child(body, "AshInfos"), "AshInfo").flatMap(
    (info): AshWindow[] => {
      const areas = children(info, "Item").flatMap((item): AshArea[] => {
        const kind = child(item, "Kind");
        const name = textAt(kind, "Name");
        const prop = child(kind, "Property");
        const polygons = children(prop, "jmx_eb:Polygon")
          .map((p) => readAshPolygon(text(p)))
          .filter((p) => p.length > 0);
        if (!name || polygons.length === 0) return [];
        const size = child(prop, "Size");
        const dist = child(prop, "Distance");
        const sizeText = text(size)?.trim();
        const distText = text(dist)?.trim();
        const unit = (el: V) => attr(el, "unit");
        const dir = child(prop, "jmx_eb:PlumeDirection");
        return [
          {
            name,
            code: textAt(kind, "Code"),
            size: sizeText
              ? `${sizeText} ${unit(size) ?? ""}`.trim()
              : undefined,
            polygons,
            direction: attr(dir, "description") ?? textAt(dir, "#text"),
            distance: distText
              ? `${distText} ${unit(dist) ?? ""}`.trim()
              : undefined,
          },
        ];
      });
      if (areas.length === 0) return [];
      return [
        {
          label: (attr(info, "type") ?? "")
            .replace(/^予報/, "")
            .replace(/\s+/g, "")
            .trim(),
          start: textAt(info, "StartTime"),
          end: textAt(info, "EndTime"),
          areas,
        },
      ];
    },
  );
}

/**
 * 火山の位置 (`+3624.38+13831.38+2568/`)。緯度・経度は「度分」(36 度 24.38 分) で、最後は標高 (m)。
 * 度で書かれていても (小数点の前が 2〜3 桁) 読む
 */
export function readVolcanoCoordinate(
  value: string | undefined,
): { lat: number; lon: number } | undefined {
  const m = /^([+-])(\d+(?:\.\d+)?)([+-])(\d+(?:\.\d+)?)/.exec(
    value?.trim() ?? "",
  );
  if (!m) return undefined;
  const deg = (sign: string, v: string, degDigits: number) => {
    const [int = "", frac] = v.split(".");
    const n =
      int.length > degDigits
        ? Number(int.slice(0, -2)) +
          Number(`${int.slice(-2)}${frac ? `.${frac}` : ""}`) / 60
        : Number(v);
    return ((sign === "-" ? -1 : 1) * Math.round(n * 1000)) / 1000;
  };
  return {
    lat: deg(m[1] ?? "+", m[2] ?? "", 2),
    lon: deg(m[3] ?? "+", m[4] ?? "", 3),
  };
}

function readVolcano(body: V, code: VolcanoCode) {
  const infos = children(body, "VolcanoInfo");
  const ofType = (types: string[]) =>
    infos.find((i) => types.includes(attr(i, "type") ?? ""));
  const target = ofType(VOLCANO_INFO[code].target);
  const cityInfo = ofType(VOLCANO_INFO[code].cities);
  const leveled = LEVELED.has(code);
  const volcanoes: VolcanoArea[] = children(target, "Item").flatMap((item) => {
    const kind = child(item, "Kind");
    const kindCode = textAt(kind, "Code");
    return children(child(item, "Areas"), "Area").flatMap(
      (area): VolcanoArea[] => {
        const name = textAt(area, "Name");
        const areaCode = textAt(area, "Code");
        if (!name || !areaCode) return [];
        return [
          {
            code: areaCode,
            name,
            ...readVolcanoCoordinate(text(child(area, "Coordinate"))),
            kind: textAt(kind, "Name") ?? "",
            kindCode,
            condition: textAt(kind, "Condition"),
            lastKind: textAt(item, "LastKind/Name"),
            level: leveled ? volcanoLevel(kindCode) : undefined,
          },
        ];
      },
    );
  });
  const cityItems = children(cityInfo, "Item");
  const names = (item: V, key: "Name" | "Code") =>
    children(child(item, "Areas"), "Area").flatMap((a) => {
      const v = textAt(a, key);
      return v ? [v] : [];
    });
  const cities = cityItems.flatMap((item) => names(item, "Name"));
  const cityCodes = cityItems.flatMap((item) => names(item, "Code"));
  const wKind = child(cityItems[0], "Kind");
  const warningName = textAt(wKind, "Name");
  const content = child(body, "VolcanoInfoContent");
  return {
    volcanoes,
    warning:
      code === "VFVO50" && warningName
        ? {
            name: warningName,
            code: textAt(wKind, "Code"),
            condition: textAt(wKind, "Condition"),
          }
        : undefined,
    cities: [...new Set(cities)],
    cityCodes: [...new Set(cityCodes)],
    ash: isAshCode(code)
      ? cityItems.flatMap((item): VolcanoAsh[] => {
          const name = textAt(item, "Kind/Name");
          return name
            ? [
                {
                  name,
                  code: textAt(item, "Kind/Code"),
                  cities: names(item, "Name"),
                  cityCodes: names(item, "Code"),
                },
              ]
            : [];
        })
      : undefined,
    eventTime:
      textAt(at(target, "Item/EventTime"), "EventDateTime") ??
      textAt(at(body, "VolcanoObservation/EventTime"), "EventDateTime"),
    contentHeadline: textAt(content, "VolcanoHeadline"),
    activity: textAt(content, "VolcanoActivity"),
    prevention: textAt(content, "VolcanoPrevention"),
    nextAdvisory: textAt(content, "NextAdvisory"),
    appendix: textAt(content, "Appendix"),
    plume: readPlume(body),
    observation: textAt(body, "VolcanoObservation/OtherObservation"),
  };
}

/** フィードから取る電文の種別。知らない種別は取らない (帯域を使わない) */
export const WANTED_CODES: ReadonlySet<string> = new Set([
  ...QUAKE_CODES,
  "VTSE41",
  "VTSE51",
  "VTSE52",
  ...ADVISORY_CODES,
  "VXSE62",
  ...VOLCANO_CODES,
]);

const isQuakeCode = (c: string): c is QuakeCode =>
  (QUAKE_CODES as readonly string[]).includes(c);
const isAdvisoryCode = (c: string): c is AdvisoryCode =>
  (ADVISORY_CODES as readonly string[]).includes(c);

/**
 * 電文 1 通を読む。code は種別 (フィードのリンクのファイル名から取ったもの)。
 * 読めない形式なら例外を投げる (呼ぶ側が原文を残して記録する)。
 */
export function parseJmaXml(xml: string, code: string): Normalized[] {
  const doc = XML.parse(xml);
  const report = doc.Report;
  if (report === undefined || typeof report === "string")
    throw new Error("Report 要素がありません");
  const control = child(report, "Control");
  const head = child(report, "Head");
  const body = child(report, "Body");
  const status = STATUS[textAt(control, "Status") ?? ""] ?? "test";
  const infoType = infoTypeOf(textAt(head, "InfoType"));
  const reportedAt = textAt(head, "ReportDateTime");
  if (!reportedAt) throw new Error("ReportDateTime がありません");
  const headline = textAt(head, "Headline/Text");
  // 原因の地震が複数のとき、地震識別番号は空白で区切った並びで来る (xs:list)
  const eventIds = (textAt(head, "EventID") ?? "").split(/\s+/).filter(Boolean);
  const title = textAt(head, "Title") ?? textAt(control, "Title") ?? code;

  if (isQuakeCode(code)) {
    const kind: QuakeKind =
      code === "VXSE51"
        ? "scale"
        : code === "VXSE52"
          ? "hypocenter"
          : code === "VXSE61"
            ? "update"
            : title.includes("遠地")
              ? "foreign"
              : "detail";
    const obs = readObservation(body);
    const r: QuakeReport = {
      kind,
      code,
      source: "jma",
      infoType,
      reportedAt,
      headline,
      targetTime: textAt(head, "TargetDateTime"),
      ...readEarthquake(body),
      maxInt: obs.maxInt,
      areas: obs.areas,
      stations: obs.stations,
      comments: readComments(body),
    };
    return [{ type: "quake", eventId: eventIds[0], status, report: r }];
  }

  if (code === "VTSE41" || code === "VTSE51" || code === "VTSE52") {
    return [
      {
        type: "tsunami",
        report: {
          code,
          source: "jma",
          eventIds,
          status,
          infoType,
          reportedAt,
          headline,
          areas: code === "VTSE52" ? undefined : readTsunamiForecast(body),
          observations: readTsunamiObservation(body, code === "VTSE52"),
        },
      },
    ];
  }

  if (isAdvisoryCode(code)) {
    const info = child(body, "EarthquakeInfo");
    const eventId = eventIds[0] ?? reportedAt;
    return [
      {
        type: "advisory",
        advisory: {
          id: `${code}-${eventId}`,
          code,
          eventId,
          title,
          serialName: textAt(info, "InfoSerial/Name"),
          status,
          infoType,
          reportedAt,
          headline: headline ?? "",
          text:
            textAt(info, "Text") ??
            textAt(body, "Text") ??
            // 地震回数に関する情報は、本文の代わりに付加文がある
            textAt(body, "Comments/FreeFormComment") ??
            "",
          ...(code === "VXSE60" ? readEarthquakeCount(body) : {}),
        },
      },
    ];
  }

  if (code === "VXSE62") {
    const eventId = eventIds[0];
    if (!eventId) throw new Error("EventID がありません");
    const serial = Number(textAt(head, "Serial"));
    return [
      {
        type: "longperiod",
        report: {
          eventId,
          status,
          infoType,
          reportedAt,
          serial: Number.isFinite(serial) && serial > 0 ? serial : undefined,
          headline,
          ...readEarthquake(body),
          ...readLongPeriod(body),
          url: jmaUrl(textAt(body, "Comments/URI")),
        },
      },
    ];
  }

  if (isVolcanoCode(code)) {
    const v = readVolcano(body, code);
    const eventId =
      eventIds[0] || v.volcanoes.map((a) => a.code).join("-") || reportedAt;
    return [
      {
        type: "volcano",
        volcano: {
          id: `${code}-${eventId}-${reportedAt.replace(/[^0-9]/g, "").slice(0, 14)}`,
          code,
          eventId,
          status,
          infoType,
          reportedAt,
          eventTime: v.eventTime,
          // 「火山名 浅間山 噴火警報（火口周辺）」の前置きと空白 (全角の空白も \s に入る) を詰める
          title: title
            .replace(/^火山名\s+/, "")
            .replace(/\s+/g, " ")
            .trim(),
          headline: headline ?? v.contentHeadline ?? "",
          volcanoes: v.volcanoes,
          warning: v.warning,
          cities: v.cities,
          cityCodes: v.cityCodes,
          activity: v.activity,
          prevention: v.prevention,
          nextAdvisory: v.nextAdvisory,
          appendix: v.appendix,
          validUntil: textAt(head, "ValidDateTime"),
          ash: v.ash,
          plume: v.plume,
          observation: v.observation,
        },
        ...(isAshCode(code) ? { ash: readAshWindows(body) } : {}),
      },
    ];
  }

  return [{ type: "other", code }];
}

/** Atom のフィードの 1 件 */
export interface FeedEntry {
  id: string;
  url: string;
  updated: string;
  title: string;
  /** 種別 (ファイル名の `_VXSE53_` の部分)。読めなければ空 */
  code: string;
}

/** 高頻度・長期フィード (Atom) を読む。新しい順に並んでいる */
export function parseFeed(xml: string): FeedEntry[] {
  const feed = XML.parse(xml).feed;
  return children(feed, "entry").flatMap((e): FeedEntry[] => {
    const id = textAt(e, "id");
    const links = children(e, "link");
    const url = attr(links[0], "href") ?? id;
    if (!id || !url) return [];
    return [
      {
        id,
        url,
        updated: textAt(e, "updated") ?? "",
        title: textAt(e, "title") ?? "",
        code: /_([A-Z]{4}\d{2})_[^/]*\.xml$/.exec(url)?.[1] ?? "",
      },
    ];
  });
}

/** 電文の中のリンクは、気象庁のサイトのものだけを使う (画面でリンクにするため) */
function jmaUrl(v: string | undefined): string | undefined {
  if (!v) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" &&
      (u.hostname === "www.data.jma.go.jp" || u.hostname === "www.jma.go.jp")
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}
