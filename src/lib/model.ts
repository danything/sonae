/**
 * 正規化したイベントのモデル (docs/design.md の 2.2)。情報源の違いはアダプターの中で吸収し、
 * 画面・SSE・DB にはここの形だけを出す。画面からも読むので、サーバーだけの物は置かない。
 */

/** 通常 / 訓練 / 試験。通常以外は保存するが知らせず、一覧では既定で隠す */
export type Status = "normal" | "training" | "test";

/** 海外の地震の情報源 (docs/design.md の 2.2「海外の地震」) */
export type ForeignSource = "usgs" | "emsc" | "geonet" | "cwa";

export type SourceId =
  "jma" | "p2p" | "wolfx" | ForeignSource | "ptwc" | "jma-bosai";

/** 震度の階級。気象庁の XML の書き方 (`5-` は 5 弱) に合わせる */
export const INTENSITIES = [
  "1",
  "2",
  "3",
  "4",
  "5-",
  "5+",
  "6-",
  "6+",
  "7",
] as const;
export type Intensity = (typeof INTENSITIES)[number];

/** 震度 5 弱以上と思われるが、まだ震度が届いていない (気象庁の「震度５弱以上未入電」) */
export const UNRECEIVED = "5-?";
export type ObservedIntensity = Intensity | typeof UNRECEIVED;

const LABELS: Record<ObservedIntensity, string> = {
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
  "5-": "5弱",
  "5+": "5強",
  "6-": "6弱",
  "6+": "6強",
  "7": "7",
  [UNRECEIVED]: "5弱以上未入電",
};

/** 画面に出す震度の書き方。`5-` ではなく「5弱」(色だけに頼らないよう、数字と字で出す) */
export const intensityLabel = (i: ObservedIntensity) => LABELS[i];

/** 比べるための順位。未入電は 5 弱と同じに数える */
export const intensityRank = (i: ObservedIntensity) =>
  i === UNRECEIVED ? INTENSITIES.indexOf("5-") : INTENSITIES.indexOf(i);

export const isIntensity = (v: unknown): v is Intensity =>
  typeof v === "string" && (INTENSITIES as readonly string[]).includes(v);

export interface Hypocenter {
  name: string;
  lat?: number;
  lon?: number;
  /** 深さ (km)。0 は「ごく浅い」。不明なら無し */
  depthKm?: number;
}

/**
 * 緊急地震速報。鍵は地震識別番号。報数が大きいものだけを採り、取消を受けたら終わり。
 *
 * **予想震度は持たない** (docs/design.md の 5 章)。画面にも通知にも出さないので、
 * SSE でブラウザに渡すこの形にも入れない (P2P の原文には残る)。
 */
export interface Eew {
  eventId: string;
  serial: number;
  issuedAt: string;
  kind: "warning" | "forecast";
  final: boolean;
  cancelled: boolean;
  status: Status;
  /** 仮定震源要素 (PLUM 法・レベル法)。震源と M は目安にすぎない */
  assumed: boolean;
  originTime?: string;
  hypocenter?: Hypocenter;
  magnitude?: number;
  /** 警報の対象の地域名 (警報のときだけ) */
  warnAreas: string[];
  sources: ("wolfx" | "p2p")[];
  updatedAt: string;
}

export type QuakeKind =
  | "scale" // 震度速報 (VXSE51、P2P の ScalePrompt)
  | "hypocenter" // 震源に関する情報 (VXSE52、Destination)
  | "detail" // 震源・震度に関する情報 (VXSE53、ScaleAndDestination・DetailScale)
  | "update" // 顕著な地震の震源要素更新のお知らせ (VXSE61)
  | "foreign" // 遠地地震に関する情報 (VXSE53 の一種、Foreign)
  | "other";

export interface AreaIntensity {
  /** 地震情報／細分区域のコード (P2P の震度速報には無い) */
  code?: string;
  name: string;
  pref?: string;
  int: ObservedIntensity;
}

export interface StationIntensity {
  name: string;
  pref?: string;
  int: ObservedIntensity;
}

/** 地震情報の 1 つの報 */
export interface QuakeReport {
  kind: QuakeKind;
  code?: "VXSE51" | "VXSE52" | "VXSE53" | "VXSE61";
  source: "jma" | "p2p";
  infoType: "発表" | "訂正" | "取消";
  reportedAt: string;
  /** 取消を受けて無効になった */
  cancelled?: boolean;
  headline?: string;
  originTime?: string;
  /** 震度速報の対象の時刻 (震度速報に発生時刻は無いので、結び付けに使う) */
  targetTime?: string;
  hypocenter?: Hypocenter;
  /** マグニチュード。不明や「M8 を超える巨大地震」は null で、文は magnitudeText */
  magnitude?: number | null;
  magnitudeText?: string;
  maxInt?: ObservedIntensity;
  areas: AreaIntensity[];
  stations: StationIntensity[];
  /** 津波の有無などの付加文 */
  comments: string[];
}

/** 1 つの地震。発表された報をまとめ、いまの姿 (震源・M・震度) を報から組む */
export interface Quake {
  id: string;
  eventId?: string;
  status: Status;
  originTime?: string;
  hypocenter?: Hypocenter;
  magnitude?: number | null;
  magnitudeText?: string;
  maxInt?: ObservedIntensity;
  areas: AreaIntensity[];
  stations: StationIntensity[];
  comments: string[];
  foreign: boolean;
  cancelled: boolean;
  /** 気象庁の XML を受けていない (P2P だけの仮の姿) */
  provisional: boolean;
  sources: ("jma" | "p2p")[];
  reports: QuakeReport[];
  updatedAt: string;
}

export type TsunamiGrade = "major" | "warning" | "watch" | "forecast" | "none";

const GRADE_LABELS: Record<TsunamiGrade, string> = {
  major: "大津波警報",
  warning: "津波警報",
  watch: "津波注意報",
  forecast: "津波予報 (若干の海面変動)",
  none: "解除・なし",
};
export const tsunamiGradeLabel = (g: TsunamiGrade) => GRADE_LABELS[g];
export const TSUNAMI_ORDER: TsunamiGrade[] = [
  "major",
  "warning",
  "watch",
  "forecast",
  "none",
];

/** 津波で出ているいちばん強い区分 (解除・なしだけなら "none") */
export const tsunamiTop = (t: Pick<Tsunami, "areas">): TsunamiGrade =>
  TSUNAMI_ORDER.find(
    (g) => g !== "none" && t.areas.some((a) => a.grade === g),
  ) ?? "none";

export interface TsunamiArea {
  code?: string;
  name: string;
  grade: TsunamiGrade;
  /** 電文のままの種類の名前 (「大津波警報：発表」など) */
  kindName: string;
  immediate?: boolean;
  arrivalTime?: string;
  /** 「第１波の到達を確認」「ただちに津波来襲と予測」など */
  condition?: string;
  /** 予想の高さの文 (「巨大」「３ｍ」など) */
  maxHeightText?: string;
}

export interface TsunamiObservation {
  area?: string;
  station: string;
  /** 沖合の観測 (VTSE52) */
  offshore: boolean;
  arrivalTime?: string;
  /** 押し・引き */
  initial?: string;
  maxHeightText?: string;
  condition?: string;
}

/** 津波。VTSE41 と VTSE51 は、その時点の全予報区の状態をまるごと持つので、新しい報で置き換える */
export interface Tsunami {
  id: string;
  eventIds: string[];
  status: Status;
  issuedAt: string;
  headline?: string;
  areas: TsunamiArea[];
  observations: TsunamiObservation[];
  cancelled: boolean;
  /** どの予報区も警報・注意報・予報ではなくなった */
  ended: boolean;
  provisional: boolean;
  sources: ("jma" | "p2p")[];
  updatedAt: string;
}

/**
 * 長周期地震動階級 (気象庁の「長周期地震動に関する観測情報」VXSE62)。0 は階級 1 未満。
 * 高層ビルの高い階の揺れの大きさで、震度とは別の尺度 (1 やや大きな揺れ・2 大きな揺れ・
 * 3 非常に大きな揺れ・4 極めて大きな揺れ)
 */
export const LG_CLASSES = ["0", "1", "2", "3", "4"] as const;
export type LgClass = (typeof LG_CLASSES)[number];
export const isLgClass = (v: unknown): v is LgClass =>
  typeof v === "string" && (LG_CLASSES as readonly string[]).includes(v);

const LG_WORDS: Record<LgClass, string> = {
  "0": "階級 1 未満",
  "1": "やや大きな揺れ",
  "2": "大きな揺れ",
  "3": "非常に大きな揺れ",
  "4": "極めて大きな揺れ",
};
/** 気象庁の電文の「簡易な現象表現」 */
export const lgWords = (c: LgClass) => LG_WORDS[c];

export interface AreaLongPeriod {
  /** 地震情報／細分区域のコード */
  code?: string;
  name: string;
  pref?: string;
  lg: LgClass;
  maxInt?: ObservedIntensity;
}

export interface StationLongPeriod {
  name: string;
  pref?: string;
  area?: string;
  lg: LgClass;
  int?: ObservedIntensity;
  /** 絶対速度応答スペクトルの最大値 (周期 1.6〜7.8 秒、cm/s) */
  sva?: number;
}

/** 長周期地震動に関する観測情報 (VXSE62)。鍵は地震識別番号で、新しい報で置き換える */
export interface LongPeriod {
  id: string;
  eventId: string;
  status: Status;
  reportedAt: string;
  serial?: number;
  infoType: "発表" | "訂正" | "取消";
  cancelled: boolean;
  headline?: string;
  originTime?: string;
  hypocenter?: Hypocenter;
  magnitude?: number | null;
  magnitudeText?: string;
  maxInt?: ObservedIntensity;
  maxLg: LgClass;
  /**
   * 情報の種類 (LgCategory)。1・2 は最大の階級が 2 以下、3・4 は 3 以上。
   * 2・4 は、その階級を観測した地域に最大震度 4 以下の所がある
   */
  category?: 1 | 2 | 3 | 4;
  areas: AreaLongPeriod[];
  stations: StationLongPeriod[];
  /** 気象庁の長周期地震動の観測情報のページ (波形・スペクトル) */
  url?: string;
  updatedAt: string;
}

/**
 * 文の情報。南海トラフ地震臨時情報・関連解説情報・後発地震注意情報・地震・津波に関するお知らせ・
 * 地震の活動状況等に関する情報 (VXSE56)・地震回数に関する情報 (VXSE60)
 */
export interface Advisory {
  id: string;
  code:
    | "VYSE50"
    | "VYSE51"
    | "VYSE52"
    | "VYSE60"
    | "VZSE40"
    | "VXSE56"
    | "VXSE60"
    /** 米国の太平洋津波警報センター (PTWC) の津波の情報 */
    | "PTWC"
    /** 気象庁の国際津波関連情報 (北西太平洋) */
    | "WEPA40";
  /** 気象庁の防災情報 XML 以外から来たとき、その情報源 */
  source?: "ptwc" | "jma-bosai";
  /** 元の電報のページ (英文など) */
  url?: string;
  /** 地震回数 (VXSE60)。期間ごとの回数と、そのうち震度 1 以上の回数 */
  counts?: EarthquakeCount[];
  /** 次の発表の予定 (VXSE60 の NextAdvisory) */
  next?: string;
  eventId: string;
  title: string;
  /** 調査中・巨大地震警戒・巨大地震注意・調査終了など (VYSE50 の InfoSerial) */
  serialName?: string;
  status: Status;
  infoType: "発表" | "訂正" | "取消";
  reportedAt: string;
  headline: string;
  text: string;
  cancelled: boolean;
  updatedAt: string;
}

/** 地震回数に関する情報の 1 つの期間 */
export interface EarthquakeCount {
  /** 電文のままの種類 (「地震回数」「１時間地震回数」「累積地震回数」) */
  type: string;
  start?: string;
  end?: string;
  number?: number;
  /** そのうち震度 1 以上を観測した回数 */
  felt?: number;
}

/** 一覧の上に通知の形で出すお知らせ (南海トラフ等と地震・津波に関するお知らせ。地震回数・活動状況・国際津波の情報は、お知らせの一覧にだけ出す) */
export const isPinnedAdvisory = (a: Pick<Advisory, "code">) =>
  a.code.startsWith("VYSE") || a.code === "VZSE40";

/**
 * 噴火警報・予報 (VFVO50) と噴火速報 (VFVO56) の 1 つの報。一覧には報ごとに並べる。
 * 取消を受けたら、同じ一連の情報 (種別と識別番号) のいちばん新しい報に印を付ける
 */
export interface Volcano {
  /** `<種別>-<識別番号>-<発表の時刻 (数字だけ)>` */
  id: string;
  code: "VFVO50" | "VFVO56";
  /** 識別番号。噴火警報・予報は火山のコード、噴火速報は発表の時刻と火山のコード */
  eventId: string;
  status: Status;
  infoType: "発表" | "訂正" | "取消";
  reportedAt: string;
  /** 噴火の時刻 (噴火速報。分までで「頃」) */
  eventTime?: string;
  title: string;
  headline: string;
  volcanoes: VolcanoArea[];
  /** 警報の種類 (噴火警報・火口周辺警報・噴火予報など)。対象の市町村に出たもの */
  warning?: { name: string; code?: string; condition?: string };
  /** 対象の市町村 */
  cities: string[];
  /** 火山の活動の状況と、防災上の警戒事項 (噴火警報・予報) */
  activity?: string;
  prevention?: string;
  cancelled: boolean;
  updatedAt: string;
}

/** 報の対象の火山 1 つ */
export interface VolcanoArea {
  /** 火山名のコード (気象庁のコード表 PointVolcano) */
  code: string;
  name: string;
  lat?: number;
  lon?: number;
  /** 電文のままの種類の名前 (「レベル３（入山規制）」「噴火」など) */
  kind: string;
  kindCode?: string;
  /** 引上げ・引下げ・継続など */
  condition?: string;
  /** 前の種類の名前 */
  lastKind?: string;
  /** 警戒の段 (1〜5)。噴火警戒レベルが無い火山は「居住地域厳重警戒」を 5 のように読み替えた段 */
  level?: number;
}

/**
 * 噴火警報・予報の種類のコード (コード表 VolcanicWarning) から警戒の段。
 * レベルの無い火山・海底火山は、気象庁の配色の指針 (表 1-2) で同じ色の段に読み替える
 */
export function volcanoLevel(kindCode: string | undefined): number | undefined {
  switch (kindCode) {
    case "11":
    case "21":
    case "35":
      return 1;
    case "12":
    case "22":
      return 2;
    case "13":
    case "23":
    case "36":
      return 3;
    case "14":
    case "24":
      return 4;
    case "15":
    case "25":
      return 5;
  }
  return undefined;
}

/** 噴火警報 (居住地域) に当たる段。警戒レベル 4・5 と、レベルの無い火山の山麓・居住地域厳重警戒 */
export const VOLCANO_RESIDENTIAL = 4;

/** 報の中でいちばん高い段 (無ければ 0) */
export const volcanoTop = (v: Pick<Volcano, "volcanoes">) =>
  Math.max(0, ...v.volcanoes.map((a) => a.level ?? 0));

/**
 * 火山ごとのいまの噴火警報・予報。新しい順に並んだ報から、火山ごとにいちばん新しい VFVO50 を採る
 * (取り消された報は飛ばして、その前の報を採る)。並びは新しい順のまま
 */
export function latestPerVolcano(reports: Volcano[]): Volcano[] {
  const seen = new Set<string>();
  const out: Volcano[] = [];
  for (const r of reports) {
    if (r.code !== "VFVO50" || r.cancelled || r.status !== "normal") continue;
    const fresh = r.volcanoes.filter((a) => !seen.has(a.code));
    if (fresh.length === 0) continue;
    for (const a of fresh) seen.add(a.code);
    out.push(r);
  }
  return out;
}

/** 海外の機関の 1 つの地震の発表 (いまの姿。続報が来たら置き換える) */
export interface ForeignReport {
  source: ForeignSource;
  /** その機関の地震の id */
  sourceId: string;
  /** その機関の地震のページ */
  url?: string;
  originTime: string;
  lat: number;
  lon: number;
  depthKm?: number;
  magnitude?: number;
  /** M の種類 (mww・mb など) */
  magType?: string;
  /** その機関の書いた場所 (英語のことが多い) */
  place: string;
  /** その機関が付けた津波の印 (USGS の tsunami。津波の予報ではない) */
  tsunami?: boolean;
  /** その機関が最後に直した時刻 */
  updatedAt?: string;
}

/**
 * 海外の地震。同じ地震を幾つかの機関が出すので、時刻・位置・M の近いものを 1 つにまとめる
 * (`sameForeignQuake`)。いまの姿は、機関の順 (`FOREIGN_ORDER`) で先のものから採る
 */
export interface ForeignQuake {
  /** `<最初に受けた機関>-<その機関の id>` */
  id: string;
  originTime: string;
  lat: number;
  lon: number;
  depthKm?: number;
  magnitude?: number;
  magType?: string;
  place: string;
  tsunami: boolean;
  reports: ForeignReport[];
  updatedAt: string;
}

/** いまの姿に採る機関の順。地元の機関 (台湾・ニュージーランド) を先に、速報の EMSC を後に */
export const FOREIGN_ORDER: ForeignSource[] = ["cwa", "geonet", "usgs", "emsc"];

/** 同じ地震とみなす近さ: 発生の時刻 60 秒・震央 150 km・M 1.0 (どちらかに M が無ければ見ない) */
export const FOREIGN_MATCH = { ms: 60_000, km: 150, mag: 1.0 } as const;

/** 2 点の距離 (km、球面) */
export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 2 つの発表が同じ地震か (時刻・位置・M の近さ) */
export function sameForeignQuake(
  a: Pick<ForeignReport, "originTime" | "lat" | "lon" | "magnitude">,
  b: Pick<ForeignReport, "originTime" | "lat" | "lon" | "magnitude">,
): boolean {
  const dt = Math.abs(Date.parse(a.originTime) - Date.parse(b.originTime));
  if (!(dt <= FOREIGN_MATCH.ms)) return false;
  if (distanceKm(a, b) > FOREIGN_MATCH.km) return false;
  if (a.magnitude !== undefined && b.magnitude !== undefined)
    return Math.abs(a.magnitude - b.magnitude) <= FOREIGN_MATCH.mag;
  return true;
}

/** 発表の並びから、いまの姿を組む (機関の順で先のものの値を採る) */
export function foreignFromReports(
  id: string,
  reports: ForeignReport[],
  updatedAt: string,
): ForeignQuake {
  const sorted = [...reports].sort(
    (a, b) => FOREIGN_ORDER.indexOf(a.source) - FOREIGN_ORDER.indexOf(b.source),
  );
  const main = sorted[0];
  if (!main) throw new Error("発表がありません");
  return {
    id,
    originTime: main.originTime,
    lat: main.lat,
    lon: main.lon,
    depthKm: main.depthKm,
    magnitude: main.magnitude,
    magType: main.magType,
    place: main.place,
    tsunami: reports.some((r) => r.tsunami === true),
    reports: sorted,
    updatedAt,
  };
}

export type EventType =
  | "eew"
  | "quake"
  | "tsunami"
  | "advisory"
  | "longperiod"
  | "volcano"
  | "foreign";

/** SSE と DB の events に載る 1 件。中身はその時点のまるごとの姿 */
export type SonaeEvent =
  | { seq: number; type: "eew"; data: Eew }
  | { seq: number; type: "quake"; data: Quake }
  | { seq: number; type: "tsunami"; data: Tsunami }
  | { seq: number; type: "advisory"; data: Advisory }
  | { seq: number; type: "volcano"; data: Volcano }
  | { seq: number; type: "longperiod"; data: LongPeriod }
  | { seq: number; type: "foreign"; data: ForeignQuake };

export interface SourceStatus {
  id: SourceId;
  state: "connecting" | "connected" | "retrying" | "stopped";
  /** 最後に何かを受けた時刻 (heartbeat や 304 も含む) */
  lastSeenAt?: string;
  /** 最後に情報を受けた時刻 */
  lastMessageAt?: string;
  lastError?: string;
  since: string;
}

/**
 * 津波予報 (若干の海面変動) は、解除の報が出ないまま終わることがある。警報・注意報が無く、
 * 発表から 6 時間たったものは「いま」の扱いから外す (一覧には残る)
 */
export const TSUNAMI_FORECAST_MS = 6 * 60 * 60_000;
export function isTsunamiActive(t: Tsunami, now: number): boolean {
  if (t.ended || t.cancelled) return false;
  const serious = t.areas.some(
    (a) => a.grade === "major" || a.grade === "warning" || a.grade === "watch",
  );
  return serious || now - Date.parse(t.issuedAt) < TSUNAMI_FORECAST_MS;
}

/** 知らせる種類のお知らせ (南海トラフ地震臨時情報・定例外の解説・後発地震注意情報) */
export const isUrgentAdvisory = (a: Pick<Advisory, "code">) =>
  a.code === "VYSE50" || a.code === "VYSE51" || a.code === "VYSE60";
