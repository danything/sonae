/**
 * 正規化したイベントのモデル (docs/design.md の 2.2)。情報源の違いはアダプターの中で吸収し、
 * 画面・SSE・DB にはここの形だけを出す。画面からも読むので、サーバーだけの物は置かない。
 */

/** 通常 / 訓練 / 試験。通常以外は保存するが知らせず、一覧と地図には `SONAE_TRAINING=on` のときだけ出す (docs/design.md の 2.2) */
export type Status = "normal" | "training" | "test";

/** 海外の地震の情報源 (docs/design.md の 2.2「海外の地震」) */
export type ForeignSource = "usgs" | "emsc" | "geonet" | "cwa";

export type SourceId =
  | "jma"
  | "jma-weather"
  | "p2p"
  | "wolfx"
  | ForeignSource
  | "ptwc"
  | "jma-bosai"
  | "trem"
  | "seisjs"
  | "msil"
  | "roads";

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
  /**
   * 電文に並ぶ地域名 (警報の地域と、予報で震度 4 以上が予想される地域。Wolfx の `WarnArea` の全部)。
   * 予想震度は持たない。「住んでいる地域と現在地」の通知の判定だけに使い、画面には出さない
   * (docs/design.md の 2.4 と 5 章)。P2P は警報しか流さず、この並びは無い
   */
  areas?: string[];
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
  /** 震度観測点のコード (7 桁。気象庁の XML だけ。P2P と、コードを読む前に受けた報には無い) */
  code?: string;
  name: string;
  pref?: string;
  int: ObservedIntensity;
}

/** 地震情報の 1 つの報 */
export interface QuakeReport {
  kind: QuakeKind;
  code?: "VXSE51" | "VXSE52" | "VXSE53" | "VXSE61";
  source: "jma" | "p2p" | "wolfx";
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
  /** 気象庁の XML を受けていない (P2P・Wolfx だけの仮の姿) */
  provisional: boolean;
  sources: ("jma" | "p2p" | "wolfx")[];
  /**
   * 震源・M・深さを、震度とは別の情報源から補ったとき、その情報源。いまは、気象庁の XML が無く、
   * P2P が震度速報だけで、Wolfx の一覧に震源があるときの "wolfx" だけ。補っていなければ無い。詳しい内容に出す
   */
  hypocenterSource?: "wolfx";
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

/** 大津波警報か津波警報が出ている (一覧の先頭に、種類のチップにかかわらず出す) */
export const isTsunamiWarning = (t: Pick<Tsunami, "areas">): boolean => {
  const top = tsunamiTop(t);
  return top === "major" || top === "warning";
};

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

/**
 * 一覧の先頭に通知の形で出すお知らせ (南海トラフ地震臨時情報などと、地震・津波に関するお知らせ。この 1 週間のもの)。
 * 決めた種類だけを出す (種類を足したときの既定は「出さない」)。地震回数・活動状況・国際津波の情報は、一覧の行にだけ出す
 */
export const isPinnedAdvisory = (a: Pick<Advisory, "code">) =>
  a.code.startsWith("VYSE") || a.code === "VZSE40";

/**
 * 火山の電文の種別。噴火警報・予報 (VFVO50)・火山の状況に関する解説情報 (VFVO51)・噴火に関する火山観測報 (VFVO52)・
 * 降灰予報 (定時 VFVO53・速報 VFVO54・詳細 VFVO55)・噴火速報 (VFVO56)・推定噴煙流向報 (VFVO60)
 */
export const VOLCANO_CODES = [
  "VFVO50",
  "VFVO51",
  "VFVO52",
  "VFVO53",
  "VFVO54",
  "VFVO55",
  "VFVO56",
  "VFVO60",
] as const;
export type VolcanoCode = (typeof VOLCANO_CODES)[number];

/** 一覧と詳しい内容に出す、種別の名前 */
export const VOLCANO_LABEL: Record<VolcanoCode, string> = {
  VFVO50: "噴火警報・予報",
  VFVO51: "火山の状況に関する解説情報",
  VFVO52: "噴火に関する火山観測報",
  VFVO53: "降灰予報 (定時)",
  VFVO54: "降灰予報 (速報)",
  VFVO55: "降灰予報 (詳細)",
  VFVO56: "噴火速報",
  VFVO60: "推定噴煙流向報",
};

/**
 * 決まった時刻や噴火のたびに出て数の多い種別 (噴火に関する火山観測報・降灰予報 (定時)・推定噴煙流向報)。
 * 一覧には火山と種別ごとにいちばん新しい報だけを並べる (桜島は降灰予報 (定時) が 3 時間ごと、観測報は噴火ごとに出る)
 */
export const isRoutineVolcano = (v: Pick<Volcano, "code">) =>
  v.code === "VFVO52" || v.code === "VFVO53" || v.code === "VFVO60";

/**
 * 新しい順に並んだ火山の報から、いつも出る種別 (`isRoutineVolcano`) を火山と種別ごとに
 * いちばん新しい 1 つにする。ほかの種別はそのまま。並びは新しい順のまま
 */
export function collapseRoutineVolcanoes<
  T extends Pick<Volcano, "code" | "volcanoes" | "eventId">,
>(reports: T[]): T[] {
  const seen = new Set<string>();
  return reports.filter((r) => {
    if (!isRoutineVolcano(r)) return true;
    const key = `${r.code}:${r.volcanoes.map((a) => a.code).join(",") || r.eventId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 降灰予報の、降灰の量などの種類ごとの対象の市町村等 (電文の「降灰予報（対象市町村等）」) */
export interface VolcanoAsh {
  /** 種類の名前 (「やや多量の降灰」「小さな噴石の落下」など。電文のまま) */
  name: string;
  /** 種類のコード (71 少量・72 やや多量・73 多量・75 小さな噴石の落下・70 降灰 (定時) など) */
  code?: string;
  cities: string[];
  /** 市町村等のコード (気象・地震・火山情報／市町村等、7 桁) */
  cityCodes: string[];
}

/** 降灰予報の「多量の降灰」の種類か (コード 73。名前でも見る) */
export const isHeavyAsh = (a: Pick<VolcanoAsh, "name" | "code">) =>
  a.code === "73" || a.name === "多量の降灰";

/**
 * 火山の 1 つの報 (噴火警報・予報・解説情報・観測報・降灰予報・噴火速報・推定噴煙流向報)。一覧には報ごとに並べる。
 * 取消を受けたら、同じ一連の情報 (種別と識別番号) のいちばん新しい報に印を付ける
 */
export interface Volcano {
  /** `<種別>-<識別番号>-<発表の時刻 (数字だけ)>` */
  id: string;
  code: VolcanoCode;
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
  /**
   * 対象の市町村等のコード (気象・地震・火山情報／市町村等、7 桁)。住んでいる地域と現在地に当てる
   * (docs/design.md の 2.4)。2026-11-16 より前に受けた報には無い
   */
  cityCodes?: string[];
  /** 火山の活動の状況と、防災上の警戒事項 (噴火警報・予報・解説情報・降灰予報) */
  activity?: string;
  prevention?: string;
  /** 次の発表の予定 (解説情報) */
  nextAdvisory?: string;
  /** 付け足しの文 (降灰予報の降灰量階級の説明など) */
  appendix?: string;
  /** 有効期限 (降灰予報) */
  validUntil?: string;
  /** 降灰予報の、種類ごとの対象の市町村等 (VFVO53〜55) */
  ash?: VolcanoAsh[];
  /** 噴煙 (観測報・降灰予報・推定噴煙流向報)。電文の説明の文のまま (「火口上2200m」) */
  plume?: { height?: string; seaLevel?: string; direction?: string };
  /** そのほかの観測 (降灰予報の OtherObservation。複数行の文) */
  observation?: string;
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
const FOREIGN_ORDER: ForeignSource[] = ["cwa", "geonet", "usgs", "emsc"];

/** 同じ地震とみなす近さ: 発生の時刻 60 秒・震央 150 km・M 1.0 (どちらかに M が無ければ見ない) */
const FOREIGN_MATCH = { ms: 60_000, km: 150, mag: 1.0 } as const;

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

/**
 * 気象の警報・注意報の段 (警戒レベルの数に合わせた)。5 特別警報・4 危険警報・3 警報・2 注意報。
 * 0 は解除・発表なし
 */
export type WarningLevel = 0 | 2 | 3 | 4 | 5;

const WARNING_LEVEL_LABELS: Record<WarningLevel, string> = {
  5: "特別警報",
  4: "危険警報",
  3: "警報",
  2: "注意報",
  0: "発表なし",
};
export const warningLevelLabel = (l: WarningLevel) => WARNING_LEVEL_LABELS[l];

/**
 * 警報・注意報の種類のコード (気象警報・注意報 (R06) 解説資料の別表 3) から段。
 * 30 番台は特別警報、40 番台は危険警報、01〜09 は警報、10〜29 は注意報、00 は解除
 */
export function warningLevel(code: string | undefined): WarningLevel {
  const n = Number(code);
  if (!code || !Number.isInteger(n) || n <= 0) return 0;
  if (n >= 30 && n <= 39) return 5;
  if (n >= 40 && n <= 49) return 4;
  if (n <= 9) return 3;
  if (n <= 29) return 2;
  return 0;
}

/** 気象警報・注意報 (R06) の電文の種別。現象ごとに分かれる */
export const WARNING_CODES = [
  "VPWW55",
  "VPWW56",
  "VPWW57",
  "VPWW58",
  "VPWW59",
  "VPWW60",
  "VPWW61",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

/** 電文の種別ごとの現象の名前 (Control/Title の括弧の中) */
export const WARNING_PHENOMENON: Record<WarningCode, string> = {
  VPWW55: "大雨",
  VPWW56: "土砂災害",
  VPWW57: "高潮",
  VPWW58: "暴風",
  VPWW59: "波浪",
  VPWW60: "大雪",
  VPWW61: "その他の注意報",
};

/** 1 つの市町村等に出ている 1 つの警報・注意報 */
export interface WarningKind {
  /** 種類のコード (別表 3) */
  code: string;
  /** 電文のままの名前 (「レベル４土砂災害危険警報」) */
  name: string;
  level: WarningLevel;
  /** 発表・継続・危険警報から警報 など (電文のまま) */
  status: string;
}

/** 1 つの市町村等 (気象・地震・火山情報／市町村等のコード、7 桁) と、出ている警報・注意報 */
export interface WarningArea {
  code: string;
  name: string;
  kinds: WarningKind[];
}

/**
 * 気象警報・注意報 (R06、VPWW55〜61)。府県予報区と電文の種別 (現象) ごとに、いまの状態をまるごと持つ。
 * 新しい報で置き換える (取消は無く、訂正も置き換え)
 */
export interface WeatherWarning {
  /** `<種別>-<府県予報区のコード>` (訓練・試験は後ろに -training・-test) */
  id: string;
  code: WarningCode;
  /** 府県予報区 (6 桁のコードと名前) */
  office: { code: string; name: string };
  status: Status;
  infoType: "発表" | "訂正";
  reportedAt: string;
  title: string;
  headline: string;
  /** 警報・注意報が出ている市町村等 (解除された・発表の無い市町村等は入れない) */
  areas: WarningArea[];
  /** この報で解除された市町村等と、解除された種類 */
  released: WarningArea[];
  updatedAt: string;
}

/** 市町村等でいちばん高い段 */
export const areaLevel = (a: Pick<WarningArea, "kinds">): WarningLevel =>
  a.kinds.reduce<WarningLevel>((m, k) => (k.level > m ? k.level : m), 0);

/** 報の中でいちばん高い段 */
export const warningTop = (w: Pick<WeatherWarning, "areas">): WarningLevel =>
  w.areas.reduce<WarningLevel>((m, a) => {
    const l = areaLevel(a);
    return l > m ? l : m;
  }, 0);

/** 1 つの府県予報区に、いま出ている警報・注意報を種類ごとにまとめたもの (一覧の 1 行と詳しい内容) */
export interface OfficeWarnings {
  office: { code: string; name: string };
  /** いちばん新しい報の時刻 */
  reportedAt: string;
  top: WarningLevel;
  /** 種類ごとの対象の市町村等。段の高い順、同じ段は種類のコードの順 */
  kinds: {
    code: string;
    name: string;
    level: WarningLevel;
    areas: { code: string; name: string }[];
  }[];
  /** 種別 (現象) ごとの見出し (電文の Headline/Text) */
  headlines: { code: WarningCode; text: string; reportedAt: string }[];
}

/** 府県予報区ごとにまとめる。出ているものがある府県予報区だけを、段の高い順・新しい順に並べる */
export function warningsByOffice(ws: WeatherWarning[]): OfficeWarnings[] {
  const offices = new Map<string, OfficeWarnings>();
  for (const w of ws) {
    if (w.status !== "normal") continue;
    const o = offices.get(w.office.code) ?? {
      office: w.office,
      reportedAt: w.reportedAt,
      top: 0,
      kinds: [],
      headlines: [],
    };
    if (Date.parse(w.reportedAt) > Date.parse(o.reportedAt))
      o.reportedAt = w.reportedAt;
    if (w.areas.length > 0 && w.headline)
      o.headlines.push({
        code: w.code,
        text: w.headline,
        reportedAt: w.reportedAt,
      });
    for (const a of w.areas)
      for (const k of a.kinds) {
        let kind = o.kinds.find((x) => x.code === k.code && x.name === k.name);
        if (!kind) {
          kind = { code: k.code, name: k.name, level: k.level, areas: [] };
          o.kinds.push(kind);
        }
        if (!kind.areas.some((x) => x.code === a.code))
          kind.areas.push({ code: a.code, name: a.name });
        if (k.level > o.top) o.top = k.level;
      }
    offices.set(w.office.code, o);
  }
  const out = [...offices.values()].filter((o) => o.kinds.length > 0);
  for (const o of out) {
    o.kinds.sort((a, b) => b.level - a.level || a.code.localeCompare(b.code));
    o.headlines.sort((a, b) => a.code.localeCompare(b.code));
  }
  return out.sort(
    (a, b) =>
      b.top - a.top || Date.parse(b.reportedAt) - Date.parse(a.reportedAt),
  );
}

/** 警報・注意報が全部解除された府県予報区 (一覧に無い `?w=office-…` のリンクを開いたときに出す) */
export interface LiftedOffice {
  office: { code: string; name: string };
  /** 解除した報 (その府県予報区のいちばん新しい報) の時刻 */
  reportedAt: string;
}

/**
 * 府県予報区の報 (種別ごと) から、警報・注意報が全部解除されたと分かるかを決める。
 * 受けた報があり、どの種別にも出ている市町村等が無ければ解除された。報が無ければ (受けていない・
 * 訓練と試験だけ) 分からないので null。まだ出ている種別があれば null
 */
export function liftedOffice(
  ws: Pick<WeatherWarning, "office" | "status" | "reportedAt" | "areas">[],
): LiftedOffice | null {
  const normal = ws.filter((w) => w.status === "normal");
  const first = normal[0];
  if (!first || normal.some((w) => w.areas.length > 0)) return null;
  const reportedAt = normal.reduce(
    (t, w) => (Date.parse(w.reportedAt) > Date.parse(t) ? w.reportedAt : t),
    first.reportedAt,
  );
  return { office: first.office, reportedAt };
}

/** 市町村等ごとのいちばん高い段 (地図を塗る) */
export function cityLevels(ws: WeatherWarning[]): Map<string, WarningLevel> {
  const out = new Map<string, WarningLevel>();
  for (const w of ws) {
    if (w.status !== "normal") continue;
    for (const a of w.areas) {
      const l = areaLevel(a);
      if (l > (out.get(a.code) ?? 0)) out.set(a.code, l);
    }
  }
  return out;
}

/** 1 つの市町村等に、いま出ている警報・注意報 (地図の吹き出し) */
export interface CityWarnings {
  code: string;
  name: string;
  /** 発表した府県予報区 */
  office: { code: string; name: string };
  /** この市町村等の警報・注意報の入った報の、いちばん新しい発表の時刻 */
  reportedAt: string;
  /** 重い順 (段の高い順)。同じ段は種類のコードの順 (詳しい内容と同じ) */
  kinds: WarningKind[];
}

/** 市町村等 (7 桁のコード) にいま出ている警報・注意報。出ていなければ null */
export function cityWarnings(
  ws: WeatherWarning[],
  code: string,
): CityWarnings | null {
  let out: CityWarnings | null = null;
  for (const w of ws) {
    if (w.status !== "normal") continue;
    const a = w.areas.find((x) => x.code === code);
    if (!a || a.kinds.length === 0) continue;
    out ??= {
      code,
      name: a.name,
      office: w.office,
      reportedAt: w.reportedAt,
      kinds: [],
    };
    if (Date.parse(w.reportedAt) > Date.parse(out.reportedAt))
      out.reportedAt = w.reportedAt;
    for (const k of a.kinds)
      if (!out.kinds.some((x) => x.code === k.code && x.name === k.name))
        out.kinds.push(k);
  }
  out?.kinds.sort((a, b) => b.level - a.level || a.code.localeCompare(b.code));
  return out;
}

/** 竜巻注意情報の有効期限が過ぎたか (期限の無いものは過ぎない) */
export const isExpired = (i: Pick<WeatherInfo, "validUntil">, now: number) =>
  i.validUntil !== undefined && Date.parse(i.validUntil) < now;

/**
 * 気象の、報ごとに出す情報の種類。記録的短時間大雨情報 (VPOA50)・府県気象防災速報 (VPBS50)・
 * 竜巻注意情報 (VPHW50)・指定河川洪水予報 (VXKO50〜89)・熱中症警戒アラート (VPFT50)・
 * 台風解析・予報情報 (VPTW60〜65)。
 * 文の情報 (`NOTE_KINDS`) は、全般・地方・府県の気象解説情報 (VPZJ51・VPCJ51・VPFJ51)・
 * 同じく潮位 (VMCJ53〜55)・天候に関する情報 (VPZI50・VPCI50)・早期天候情報 (VPAW51)
 */
export type WeatherInfoKind =
  | "rain"
  | "bosai"
  | "tornado"
  | "flood"
  | "heat"
  | "typhoon"
  | "commentary"
  | "tide"
  | "climate"
  | "earlyClimate";

export const WEATHER_INFO_LABEL: Record<WeatherInfoKind, string> = {
  rain: "記録的短時間大雨情報",
  bosai: "気象防災速報",
  tornado: "竜巻注意情報",
  flood: "指定河川洪水予報",
  heat: "熱中症警戒アラート",
  typhoon: "台風情報",
  commentary: "気象解説情報",
  tide: "気象解説情報 (潮位)",
  climate: "天候情報",
  earlyClimate: "早期天候情報",
};

/**
 * 文で読む解説の情報 (気象解説情報・潮位・天候情報・早期天候情報)。知らせず、一覧と詳しい内容に出すだけ。
 * 一覧には一連の情報 (`series`) ごとにいちばん新しい報だけを並べる (台風情報と同じ)
 */
export const NOTE_KINDS: ReadonlySet<WeatherInfoKind> = new Set([
  "commentary",
  "tide",
  "climate",
  "earlyClimate",
]);

/**
 * 新しい順に並んだ気象の報から、解説の情報 (`NOTE_KINDS`) と台風情報を一連の情報ごとにいちばん新しい 1 つにする。
 * ほかの種類はそのまま。並びは新しい順のまま
 */
export function collapseNotes<T extends Pick<WeatherInfo, "kind" | "series">>(
  infos: T[],
): T[] {
  const seen = new Set<string>();
  return infos.filter((x) => {
    if (!NOTE_KINDS.has(x.kind) && x.kind !== "typhoon") return true;
    if (seen.has(x.series)) return false;
    seen.add(x.series);
    return true;
  });
}

/** 解説の情報の本文の 1 つの節 (「気象概況」「防災事項」「雨の予想」など。行は電文の文のまま) */
export interface WeatherSection {
  title: string;
  lines: string[];
}

/** 台風の実況 (台風解析・予報情報のいちばん初めの「実況」) */
export interface TyphoonNow {
  /** 台風番号 (4 桁。2617 は 2026 年の第 17 号)。発生前は無い */
  number?: string;
  name?: string;
  nameKana?: string;
  /** 台風発生・台風消滅 (温帯低気圧化) など */
  remark?: string;
  /** 台風(TY)・熱帯低気圧(TD) など */
  className?: string;
  /** 大型・超大型 */
  areaClass?: string;
  /** 強い・非常に強い・猛烈な */
  intensityClass?: string;
  lat?: number;
  lon?: number;
  location?: string;
  direction?: string;
  /** 「ゆっくり」「２０キロ」などの文 */
  speed?: string;
  pressureHpa?: number;
  /** 中心付近の最大風速 (m/s) */
  maxWindMs?: number;
  /** 最大瞬間風速 (m/s) */
  maxGustMs?: number;
}

/** 気象の、報ごとの情報 1 つ。報ごとに 1 行で、一覧には新しい順に並べる */
export interface WeatherInfo {
  /** `<種別>-<一連の情報の鍵>-<発表の時刻 (数字だけ)>` */
  id: string;
  kind: WeatherInfoKind;
  /** 電文の種別 (VXKO53 など) */
  code: string;
  /** 一連の情報の鍵 (取消・訂正で前の報を引く)。洪水予報は予報区域、台風は TC 番号 */
  series: string;
  status: Status;
  infoType: "発表" | "訂正" | "取消";
  reportedAt: string;
  /** 竜巻注意情報の有効期限 */
  validUntil?: string;
  title: string;
  headline: string;
  /** 本文 (熱中症警戒アラート) */
  text?: string;
  /** 本文の節 (解説の情報。気象概況・防災事項・雨の予想・付加情報など。電文の順) */
  sections?: WeatherSection[];
  /** 段 (指定河川洪水予報だけ。氾濫注意報 2 から氾濫特別警報 5、解除は 0) */
  level?: WarningLevel;
  /** 種類の名前 (「レベル３氾濫警報」「記録雨」など) */
  kindName?: string;
  /**
   * 対象の地域。府県予報区・一次細分区域等 (6 桁)、市町村等 (7 桁) のコードと名前。
   * 洪水予報は河川の名前も入る (コードは河川のもの)
   */
  areas: { code: string; name: string }[];
  typhoon?: TyphoonNow;
  cancelled: boolean;
  updatedAt: string;
}

/**
 * 指定河川洪水予報の種類のコードから段 (解説資料の表 2。令和 8 年度出水期から)。
 * 10 は氾濫注意報の解除、2x は氾濫注意報、3x は氾濫警報、4x は氾濫危険警報、5x は氾濫特別警報
 */
export function floodLevel(code: string | undefined): WarningLevel {
  const n = Number(code);
  if (!code || !Number.isInteger(n)) return 0;
  if (n >= 50 && n <= 59) return 5;
  if (n >= 40 && n <= 49) return 4;
  if (n >= 30 && n <= 39) return 3;
  if (n >= 20 && n <= 29) return 2;
  return 0;
}

/** 警報級の可能性の段 (早期注意情報。「高」「中」だけを持つ。「なし」と値なしは持たない) */
export type OutlookRank = "高" | "中";

/** 1 つの現象 (大雨・土砂災害・雪・風 (風雪)・波・潮位) の、日ごとの警報級の可能性 */
export interface OutlookKind {
  /** 現象の名前 (電文の Type から「の警報級の可能性」を外したもの。「大雨」「風（風雪）」) */
  name: string;
  /** 日ごと (日本時間の暦日) のいちばん高い段。高・中の日だけ */
  days: { date: string; rank: OutlookRank }[];
}

/**
 * 早期注意情報 (警報級の可能性)。明後日まで (VPFD61) と明々後日以降 (VPFW60) を、府県予報区と種別ごとに
 * いまの 1 通だけ持つ (新しい報で置き換える)。知らせない (docs/design.md の 2.8)
 */
export interface WarningOutlook {
  /** `<種別>-<府県予報区のコード>` */
  id: string;
  code: "VPFD61" | "VPFW60";
  office: { code: string; name: string };
  status: Status;
  reportedAt: string;
  title: string;
  /** 一次細分区域ごと (明々後日以降は府県予報区ごとのこともある)。高・中のある現象だけ */
  areas: { code: string; name: string; kinds: OutlookKind[] }[];
  updatedAt: string;
}

/** 段の比べ方 (高いほど大きい) */
export const outlookRank = (r: OutlookRank | undefined) =>
  r === "高" ? 2 : r === "中" ? 1 : 0;

/**
 * 住んでいる地域 (一次細分区域か府県予報区) の警報級の可能性。明後日までと明々後日以降を日の順に並べ、
 * 同じ日・同じ現象は高いほうを採る。高・中が無ければ空
 */
export function outlookFor(
  outlooks: WarningOutlook[],
  place: { office: string | null; ichiji: string | null },
): { date: string; kinds: { name: string; rank: OutlookRank }[] }[] {
  const byDate = new Map<string, Map<string, OutlookRank>>();
  for (const o of outlooks) {
    if (o.status !== "normal" || o.office.code !== place.office) continue;
    const area =
      o.areas.find((a) => a.code === place.ichiji) ??
      o.areas.find((a) => a.code === place.office);
    for (const k of area?.kinds ?? [])
      for (const d of k.days) {
        const m = byDate.get(d.date) ?? new Map<string, OutlookRank>();
        if (outlookRank(d.rank) > outlookRank(m.get(k.name)))
          m.set(k.name, d.rank);
        byDate.set(d.date, m);
      }
  }
  return [...byDate]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, m]) => ({
      date,
      kinds: [...m].map(([name, rank]) => ({ name, rank })),
    }));
}

export type EventType =
  | "eew"
  | "quake"
  | "tsunami"
  | "advisory"
  | "longperiod"
  | "volcano"
  | "foreign"
  | "warning"
  | "weather"
  | "outlook";

/** SSE と DB の events に載る 1 件。中身はその時点のまるごとの姿 */
export type SonaeEvent =
  | { seq: number; type: "eew"; data: Eew }
  | { seq: number; type: "quake"; data: Quake }
  | { seq: number; type: "tsunami"; data: Tsunami }
  | { seq: number; type: "advisory"; data: Advisory }
  | { seq: number; type: "volcano"; data: Volcano }
  | { seq: number; type: "longperiod"; data: LongPeriod }
  | { seq: number; type: "foreign"; data: ForeignQuake }
  | { seq: number; type: "warning"; data: WeatherWarning }
  | { seq: number; type: "weather"; data: WeatherInfo }
  | { seq: number; type: "outlook"; data: WarningOutlook };

export interface SourceStatus {
  id: SourceId;
  /** `off` は設定で受信を切ってあるもの (中央氣象署の授権碼が無いなど)。問題ではないので注意の印は出さない */
  state: "connecting" | "connected" | "retrying" | "stopped" | "off";
  /** 切ってある訳 (`off` のときだけ。「授権碼がありません」) */
  reason?: string;
  /** 最後に何かを受けた時刻 (heartbeat や 304 も含む) */
  lastSeenAt?: string;
  /** 最後に情報を受けた時刻 */
  lastMessageAt?: string;
  lastError?: string;
  since: string;
  /** 災害時の通行止め (`roads`) の、自動で見つけた災害 (docs/design.md の 2.12) */
  roads?: RoadDiscoverStatus;
}

/** 災害時の通行止めの、国土交通省 道路局のページから自動で見つけたもの */
export interface RoadDiscoverStatus {
  /** 自動の発見を使っているか (`SONAE_ROAD_DISCOVER=off` で切る) */
  discover: boolean;
  /** いま一覧にある災害の名前 (「令和8年熊本地震」) */
  disasters: string[];
  /** 環境変数で登録した URL の数 */
  manual: number;
  /** 最後に一覧を読めた時刻 */
  checkedAt?: string;
  /** 一覧や地図のページが読めないときの一言 (「一覧が読めません」) */
  problem?: string;
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
