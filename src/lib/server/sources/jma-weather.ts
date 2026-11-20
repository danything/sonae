/**
 * 気象庁防災情報 XML の気象の電文 (随時のフィード extra.xml) を、正規化したモデルに読む
 * (docs/design.md の 2.8)。読み方の部品は jma-xml.ts と同じ。
 *
 * 仕様: 技術資料 (https://xml.kishou.go.jp/tec_material.html) の解説資料 (`jmaxml_20261104_Manual(pdf).zip`)。
 * 気象警報・注意報 (Ｒ０６) と別表類、記録的短時間大雨情報、気象解説情報形式 (府県気象防災速報)、
 * 竜巻注意情報、指定河川洪水予報、一般報 (熱中症警戒アラート)、台風解析・予報情報電文 (新形式)。
 */

import { XML } from "bun";

import {
  floodLevel,
  NOTE_KINDS,
  type RiverStation,
  type TyphoonNow,
  WARNING_CODES,
  type WarningArea,
  type WarningCode,
  type WarningKind,
  warningLevel,
  type WeatherInfo,
  type WeatherInfoKind,
  type WeatherSection,
} from "#lib/model.ts";

import {
  at,
  attr,
  child,
  children,
  infoTypeOf,
  STATUS,
  text,
  textAt,
  type V,
} from "./jma-xml.ts";
import type { Normalized } from "./types.ts";

const isWarningCode = (c: string): c is WarningCode =>
  (WARNING_CODES as readonly string[]).includes(c);

/**
 * 報ごとの情報の種別。土砂災害警戒情報 (VXWW50) は「レベル４土砂災害危険警報」として VPWW56 に入り、
 * VXWW50 は経過措置の電文 (令和 10 年度に廃止予定) なので取らない (二重になる)
 */
function infoKindOf(code: string): WeatherInfoKind | undefined {
  if (code === "VPOA50") return "rain";
  if (code === "VPBS50") return "bosai";
  if (code === "VPHW50") return "tornado";
  if (code === "VPFT50") return "heat";
  if (/^VXKO(5\d|[6-8]\d)$/.test(code)) return "flood";
  if (/^VPTW6[0-5]$/.test(code)) return "typhoon";
  // 気象解説情報は新しい形式 (VPxJ51) だけ。前の形式 (VPZJ50・VPCJ50・VPFJ50) は同じ中身で、令和 10 年度に廃止の予定
  if (code === "VPZJ51" || code === "VPCJ51" || code === "VPFJ51")
    return "commentary";
  // 潮位も新しい形式 (VMCJ53〜55) だけ。前の形式の潮位情報 (VMCJ50〜52) は令和 10 年度に廃止の予定
  if (/^VMCJ5[3-5]$/.test(code)) return "tide";
  if (code === "VPZI50" || code === "VPCI50") return "climate";
  if (code === "VPAW51") return "earlyClimate";
  return undefined;
}

/** 子孫の要素を順にたどる (Bun.XML の compact の形。属性 `@…` と文字 `#text` は飛ばす) */
function* descendants(v: V): Generator<[string, XML.Value]> {
  for (const el of Array.isArray(v) ? v : v === undefined ? [] : [v]) {
    if (typeof el !== "object" || el === null) continue;
    for (const [name, child] of Object.entries(el)) {
      if (name.startsWith("@") || name === "#text") continue;
      for (const c of Array.isArray(child) ? child : [child]) {
        yield [name, c];
        yield* descendants(c);
      }
    }
  }
}

const lines = (s: string | undefined) =>
  (s ?? "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");

/**
 * 1 つの地域・地点の、時刻 (refID) の値。値の部品 (`…Part`) に文 (Sentence) があればそれを、
 * 無ければ要素の説明の文 (description) を「、」でつなぐ。「値なし」は出さない
 */
function valueAt(item: V, refId: string): string {
  const out: string[] = [];
  for (const kind of children(item, "Kind"))
    for (const prop of children(kind, "Property"))
      for (const [name, part] of Object.entries(
        typeof prop === "object" ? prop : {},
      )) {
        if (!name.endsWith("Part")) continue;
        for (const p of Array.isArray(part) ? part : [part]) {
          const hits = [...descendants(p)].filter(
            ([, el]) => attr(el, "refID") === refId,
          );
          if (hits.length === 0) continue;
          const sentence = textAt(p, "Sentence");
          if (sentence) {
            out.push(sentence);
            continue;
          }
          for (const [, el] of hits) {
            // 満潮・干潮の時刻のように、時刻 (refID) の付いた並び (Sequence) が文を持つもの
            const s = textAt(el, "Sentence");
            if (s) {
              out.push(s);
              continue;
            }
            if (attr(el, "condition") === "値なし") continue;
            const d = attr(el, "description") ?? text(el)?.trim();
            if (d) out.push(d);
          }
        }
      }
  return out.join("、");
}

/** 地域か地点の名前 (`Area/Name`・`Station/Name`) */
const placeOf = (item: V) =>
  textAt(item, "Area/Name") ??
  textAt(item, "Station/Name") ??
  children(child(item, "Areas"), "Area")
    .map((a) => textAt(a, "Name"))
    .filter(Boolean)
    .join("、");

/**
 * 解説の情報の本文を節に分けて読む (気象解説情報形式・天候情報・早期天候情報)。電文の文を言い換えず、順もそのまま。
 * - 文だけの節 (概況・防災事項・付加情報・天候情報の本文) は、Property の Type か Text の type を見出しにする
 * - 時系列の節 (雨の予想・風の実況など) は、時刻ごとの解説の文の下に、地域・地点ごとの値を、全角の空白で字下げして「地域 値」で並べる (電文の文の形)
 */
export function readSections(body: V): WeatherSection[] {
  const out: WeatherSection[] = [];
  const push = (title: string, add: string[]) => {
    if (add.length === 0) return;
    const last = out.at(-1);
    if (last?.title === title) last.lines.push(...add);
    else out.push({ title, lines: [...add] });
  };
  for (const infos of children(body, "MeteorologicalInfos")) {
    const infosType = attr(infos, "type") ?? "";
    for (const mi of children(infos, "MeteorologicalInfo"))
      for (const item of children(mi, "Item")) {
        const place = placeOf(item);
        for (const kind of children(item, "Kind"))
          for (const prop of children(kind, "Property")) {
            const type = textAt(prop, "Type") ?? infosType;
            // 天候情報の本文は Text の type (概況・今後の見通し・防災事項) を見出しにする。ほかは Type
            // (「副振動の実況」) を見出しにする。気象要素 (表の名前) の文は解説の文と重なるので出さない
            for (const t of children(prop, "Text")) {
              const label = attr(t, "type");
              if (type !== "本文" && label === "気象要素") continue;
              const title =
                type === "本文"
                  ? label && label !== "本文"
                    ? label
                    : infosType
                  : type;
              push(title, lines(text(t)));
            }
            // 地点ごとの観測の文 (潮位の気象解説情報の「１９日１２時２０分ごろ 約８０センチ」)
            if (place)
              for (const [name, part] of Object.entries(
                typeof prop === "object" ? prop : {},
              ))
                if (name.endsWith("Part") && name !== "ClimateValuesPart")
                  for (const p of Array.isArray(part) ? part : [part]) {
                    const s = textAt(p, "Sentence");
                    if (s) push(type, [`　${place}　${s}`]);
                  }
            // 早期天候情報の「かなりの高温」などの文
            for (const [name, el] of descendants(prop))
              if (name === "jmx_eb:Text") push(type, lines(text(el)));
            // 天候情報の地点ごとの値 (平均気温・降水量と平年差・平年比)
            const values = children(prop, "ClimateValuesPart").flatMap((p) =>
              [...descendants(p)].flatMap(([, el]) => {
                const v = text(el)?.trim();
                const t = attr(el, "type");
                return v && t ? [`${t} ${v}${attr(el, "unit") ?? ""}`] : [];
              }),
            );
            if (values.length > 0 && place)
              push(type, [`　${place}　${values.join("、")}`]);
          }
      }
    for (const tsi of children(infos, "TimeSeriesInfo")) {
      const ids = children(child(tsi, "TimeDefines"), "TimeDefine").map(
        (d) => ({ id: attr(d, "timeId") ?? "", name: textAt(d, "Name") }),
      );
      const items = children(tsi, "Item");
      const texts = (type: string, ref?: string) =>
        items.flatMap((item) =>
          children(child(child(item, "Kind"), "Property"), "Text").flatMap(
            (t) =>
              attr(t, "type") === type &&
              (ref === undefined || attr(t, "refID") === ref)
                ? lines(text(t))
                : [],
          ),
        );
      const head = items[0];
      const title =
        texts("気象要素")[0] ?? textAt(head, "Kind/Property/Type") ?? infosType;
      const add: string[] = [...texts("解説")];
      const places = items.filter((i) => placeOf(i));
      for (const d of ids) {
        const comment = texts("時系列解説", d.id);
        const values = places.flatMap((i) => {
          const v = valueAt(i, d.id);
          return v ? [`　${placeOf(i)}　${v}`] : [];
        });
        if (comment.length === 0 && values.length === 0) continue;
        add.push(...(comment.length > 0 ? comment : d.name ? [d.name] : []));
        add.push(...values, ...texts("時系列補足", d.id));
      }
      add.push(...texts("補足"));
      push(title, add);
    }
  }
  return out;
}

const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

/** 気象のフィードから取る種別 */
export const WEATHER_CODES: ReadonlySet<string> = new Set<string>([
  ...WARNING_CODES,
  "VPOA50",
  "VPBS50",
  "VPHW50",
  "VPFT50",
  ...range("VXKO", 50, 89),
  ...range("VPTW", 60, 65),
  "VPZJ51",
  "VPCJ51",
  "VPFJ51",
  "VMCJ53",
  "VMCJ54",
  "VMCJ55",
  "VPZI50",
  "VPCI50",
  "VPAW51",
]);

/** その時点の状態をまるごと持つ種別 (府県予報区ごとに、いちばん新しい電文だけを取る) */
export const WEATHER_SNAPSHOT_CODES: ReadonlySet<string> = new Set<string>(
  WARNING_CODES,
);

/** Item の中の Kind (1 つの Item に幾つも並ぶことがある。その他の注意報など) */
function readKinds(item: V): {
  active: WarningKind[];
  released: WarningKind[];
} {
  const active: WarningKind[] = [];
  const released: WarningKind[] = [];
  for (const kind of children(item, "Kind")) {
    const code = textAt(kind, "Code");
    const name = textAt(kind, "Name");
    const status = textAt(kind, "Status") ?? "";
    // 「発表警報・注意報はなし」は Name と Code が無い
    if (!code || !name) continue;
    const k: WarningKind = { code, name, level: warningLevel(code), status };
    if (status === "解除") released.push(k);
    else if (k.level > 0) active.push(k);
  }
  return { active, released };
}

function readWarning(body: V) {
  const warnings = children(body, "Warning");
  const ofType = (t: string) =>
    warnings.find((w) => attr(w, "type") === `気象警報・注意報（${t}）`);
  const offices = children(ofType("府県予報区等"), "Item").flatMap((item) => {
    const code = textAt(item, "Area/Code");
    const name = textAt(item, "Area/Name");
    return code && name ? [{ code, name }] : [];
  });
  // 同じ市町村等が幾つかの Item に分かれて来ても、1 つにまとめる
  const areas = new Map<string, WarningArea>();
  const released = new Map<string, WarningArea>();
  const add = (
    m: Map<string, WarningArea>,
    code: string,
    name: string,
    kinds: WarningKind[],
  ) => {
    if (kinds.length === 0) return;
    const a = m.get(code) ?? { code, name, kinds: [] };
    for (const k of kinds)
      if (!a.kinds.some((x) => x.code === k.code)) a.kinds.push(k);
    m.set(code, a);
  };
  for (const item of children(ofType("市町村等"), "Item")) {
    const code = textAt(item, "Area/Code");
    const name = textAt(item, "Area/Name");
    if (!code || !name) continue;
    const k = readKinds(item);
    add(areas, code, name, k.active);
    add(released, code, name, k.released);
  }
  return {
    offices,
    areas: [...areas.values()],
    released: [...released.values()],
  };
}

/**
 * Headline/Information の地域 (Areas/Area の Code と Name)。「なし」の Kind の地域は入れない。
 * 同じコードは 1 つにまとめる
 */
function headlineAreas(head: V): { code: string; name: string }[] {
  const out = new Map<string, string>();
  for (const info of children(child(head, "Headline"), "Information")) {
    for (const item of children(info, "Item")) {
      const cond = textAt(item, "Kind/Condition");
      if (cond === "なし") continue;
      for (const a of children(child(item, "Areas"), "Area")) {
        const code = textAt(a, "Code");
        const name = textAt(a, "Name");
        if (code && name && !out.has(code)) out.set(code, name);
      }
    }
  }
  return [...out].map(([code, name]) => ({ code, name }));
}

const num = (v: string | undefined) => {
  const n = v === undefined ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * 指定河川洪水予報の水位観測所ごとの実況と予想の水位 (解説資料の「水位・流量情報」)。
 * 基準観測所は Warning の Item の Stations にある観測所 (主文で名前の出るもの)。
 * 基準の水位は AdditionalInfo の FloodForecastAddition の Criteria (有効のものだけ)。
 * 水位の「レベル」(段の数) は意味を解説資料で確かめていないので持たない
 */
function readStations(body: V): RiverStation[] {
  const base = new Set(
    children(
      children(body, "Warning").find(
        (w) => attr(w, "type") === "指定河川洪水予報",
      ),
      "Item",
    )
      .flatMap((i) => children(child(i, "Stations"), "Station"))
      .map((s) => textAt(s, "Code"))
      .filter((c): c is string => !!c),
  );
  const criteria = new Map<string, { name: string; m: number }[]>();
  for (const part of children(
    at(body, "AdditionalInfo/FloodForecastAddition"),
    "HydrometricStationPart",
  )) {
    const code = textAt(part, "Area/Code");
    if (!code) continue;
    criteria.set(
      code,
      children(child(part, "Criteria"), "jmx_eb:WaterLevel").flatMap((w) => {
        const name = attr(w, "type");
        const m = num(text(w));
        return name && m !== undefined && attr(w, "condition") !== "無効"
          ? [{ name, m }]
          : [];
      }),
    );
  }
  const out: RiverStation[] = [];
  for (const info of children(body, "MeteorologicalInfos")) {
    if (attr(info, "type") !== "水位・流量情報") continue;
    for (const series of children(info, "TimeSeriesInfo")) {
      const times = new Map<string, { time: string; label: string }>();
      for (const d of children(child(series, "TimeDefines"), "TimeDefine")) {
        const id = attr(d, "timeId");
        const time = textAt(d, "DateTime");
        if (id && time) times.set(id, { time, label: textAt(d, "Name") ?? "" });
      }
      for (const item of children(series, "Item")) {
        const code = textAt(item, "Station/Code");
        const name = textAt(item, "Station/Name");
        if (!code || !name || out.some((s) => s.code === code)) continue;
        const levels: RiverStation["levels"] = [];
        for (const kind of children(item, "Kind")) {
          const prop = child(kind, "Property");
          if (textAt(prop, "Type") !== "水位") continue;
          for (const w of children(
            child(prop, "WaterLevelPart"),
            "jmx_eb:WaterLevel",
          )) {
            if (attr(w, "type") !== "水位") continue;
            const t = times.get(attr(w, "refID") ?? "");
            if (!t) continue;
            const m = attr(w, "unit") === "m" ? num(text(w)) : undefined;
            levels.push(m === undefined ? { ...t } : { ...t, m });
          }
        }
        if (levels.length === 0) continue;
        out.push({
          name,
          code,
          location: textAt(item, "Station/Location"),
          base: base.has(code),
          levels,
          criteria: criteria.get(code) ?? [],
        });
      }
    }
  }
  // 基準観測所を先に (ほかは電文の順のまま)
  return [...out.filter((s) => s.base), ...out.filter((s) => !s.base)];
}

/** 台風解析・予報情報の、いちばん初めの「実況」 */
function readTyphoon(body: V): TyphoonNow | undefined {
  const infos = children(
    children(body, "MeteorologicalInfos").find(
      (m) => attr(m, "type") === "台風情報",
    ),
    "MeteorologicalInfo",
  );
  const now =
    infos.find((i) => attr(child(i, "DateTime"), "type") === "実況") ??
    infos[0];
  if (!now) return undefined;
  const props = children(child(now, "Item"), "Kind").map((k) =>
    child(k, "Property"),
  );
  const part = (name: string) =>
    props.map((p) => child(p, name)).find((x) => x !== undefined);
  const name = part("TyphoonNamePart");
  const cls = part("ClassPart");
  const center = part("CenterPart");
  const wind = part("WindPart");
  const coord = children(center, "jmx_eb:Coordinate").find(
    (c) => attr(c, "type") === "中心位置（度）",
  );
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(text(coord) ?? "");
  const speed = children(center, "jmx_eb:Speed").find(
    (s) => attr(s, "unit") === "km/h",
  );
  const ms = (type: string) =>
    num(
      text(
        children(wind, "jmx_eb:WindSpeed").find(
          (w) => attr(w, "type") === type && attr(w, "unit") === "m/s",
        ),
      ),
    );
  return {
    number: textAt(name, "Number"),
    name: textAt(name, "Name"),
    nameKana: textAt(name, "NameKana"),
    remark: textAt(name, "Remark"),
    className: textAt(cls, "jmx_eb:TyphoonClass"),
    areaClass: textAt(cls, "jmx_eb:AreaClass"),
    intensityClass: textAt(cls, "jmx_eb:IntensityClass"),
    lat: m ? Number(m[1]) : undefined,
    lon: m ? Number(m[2]) : undefined,
    location: textAt(center, "Location"),
    direction: textAt(center, "jmx_eb:Direction"),
    speed: attr(speed, "description") ?? text(speed),
    pressureHpa: num(textAt(center, "jmx_eb:Pressure")),
    maxWindMs: ms("最大風速"),
    maxGustMs: ms("最大瞬間風速"),
  };
}

/**
 * 電文 1 通を読む。code は種別 (フィードのリンクのファイル名から取ったもの)。
 * 読めない形式なら例外を投げる (呼ぶ側が原文を残して記録する)。
 */
export function parseWeatherXml(xml: string, code: string): Normalized[] {
  const doc = XML.parse(xml);
  const report = doc.Report;
  if (report === undefined || typeof report === "string")
    throw new Error("Report 要素がありません");
  const control = child(report, "Control");
  const head = child(report, "Head");
  const body = child(report, "Body");
  const status = STATUS[textAt(control, "Status") ?? ""] ?? "test";
  const reportedAt = textAt(head, "ReportDateTime");
  if (!reportedAt) throw new Error("ReportDateTime がありません");
  const headline = textAt(head, "Headline/Text") ?? "";
  const title = textAt(head, "Title") ?? textAt(control, "Title") ?? code;
  const suffix = status === "normal" ? "" : `-${status}`;

  if (isWarningCode(code)) {
    const w = readWarning(body);
    const office = w.offices[0];
    if (!office) throw new Error("府県予報区がありません");
    return [
      {
        type: "warning",
        warning: {
          id: `${code}-${office.code}${suffix}`,
          code,
          office,
          status,
          // R06 には取消が無い (発表と訂正だけ)。訂正も置き換え
          infoType: textAt(head, "InfoType") === "訂正" ? "訂正" : "発表",
          reportedAt,
          title,
          headline,
          areas: w.areas,
          released: w.released,
        },
      },
    ];
  }

  const kind = infoKindOf(code);
  if (kind) {
    const eventId = textAt(head, "EventID");
    const areas = headlineAreas(head);
    // 一連の情報の鍵。記録的短時間大雨情報・府県気象防災速報の EventID は「第 1 号の日時_当該号の日時」
    // なので前半だけ。竜巻注意情報は EventID が空なので、発表細分 (府県予報区) のコードで分ける
    const series =
      (kind === "rain" || kind === "bosai"
        ? eventId?.split("_")[0]
        : kind === "tornado"
          ? areas[0]?.code
          : eventId) ||
      // 鍵が取れない報は、ほかの報と結ばない (取消・訂正で関係のない報に触らない)
      `${code}${reportedAt.replace(/[^0-9]/g, "").slice(0, 14)}`;
    const firstKind = at(head, "Headline/Information/Item/Kind");
    const tags = children(child(head, "Headline"), "Information")
      .filter((i) => attr(i, "type") === "情報タグ")
      .flatMap((i) => children(i, "Item"))
      .map((i) => textAt(i, "Kind/Condition"))
      .filter((c): c is string => !!c)
      .join("・");
    const note = NOTE_KINDS.has(kind);
    // 府県気象防災速報と気象解説情報は情報タグ (「大雨」「台風 大雨 高波」)、早期天候情報は条件の文
    // (「１２月１０日頃からの約５日間、かなりの高温の確率30％以上」)
    const kindName =
      kind === "bosai" || kind === "commentary" || kind === "tide"
        ? tags || undefined
        : kind === "earlyClimate"
          ? textAt(firstKind, "Condition")
          : kind === "climate"
            ? undefined
            : textAt(firstKind, "Name");
    // 府県気象防災速報の「記録雨」は記録的短時間大雨情報 (VPOA50) と同じ中身 (経過措置の間は両方が出る)。
    // 二重に並べないよう、記録雨だけの速報は取らない
    if (kind === "bosai" && (kindName === undefined || kindName === "記録雨"))
      return [{ type: "other", code }];
    const info: Omit<WeatherInfo, "updatedAt" | "cancelled"> = {
      id: `${code}-${series}-${reportedAt.replace(/[^0-9]/g, "").slice(0, 14)}${suffix}`,
      kind,
      code,
      series: `${kind}-${series}${suffix}`,
      status,
      infoType: infoTypeOf(textAt(head, "InfoType")),
      reportedAt,
      validUntil: textAt(head, "ValidDateTime"),
      title,
      headline,
      text:
        kind === "heat"
          ? text(
              children(child(body, "Comment"), "Text").find(
                (t) => attr(t, "type") === "本文",
              ),
            )?.trim()
          : undefined,
      level:
        kind === "flood" ? floodLevel(textAt(firstKind, "Code")) : undefined,
      kindName,
      sections: note ? readSections(body) : undefined,
      // 天候情報は見出しに地域が無く、本文の対象の地域 (TargetArea) だけ
      areas:
        areas.length > 0 || kind !== "climate"
          ? areas
          : [child(body, "TargetArea")].flatMap((a) => {
              const c = textAt(a, "Code");
              const n = textAt(a, "Name");
              return c && n ? [{ code: c, name: n }] : [];
            }),
      typhoon: kind === "typhoon" ? readTyphoon(body) : undefined,
      stations: kind === "flood" ? readStations(body) : undefined,
    };
    return [{ type: "weather", info }];
  }

  return [{ type: "other", code }];
}
