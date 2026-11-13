/**
 * 正規化したイベントのモデル (docs/design.md の 2.2)。情報源の違いはアダプターの中で吸収し、
 * 画面・SSE・DB にはここの形だけを出す。画面からも読むので、サーバーだけの物は置かない。
 */

/** 通常 / 訓練 / 試験。通常以外は保存するが知らせず、一覧では既定で隠す */
export type Status = "normal" | "training" | "test";

export type SourceId = "jma" | "p2p" | "wolfx";

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
 * **予想震度は持たない** (docs/design.md の 5 章)。画面にも知らせにも出さないので、
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

/** 南海トラフ地震臨時情報・関連解説情報・後発地震注意情報・地震・津波に関するお知らせ */
export interface Advisory {
  id: string;
  code: "VYSE50" | "VYSE51" | "VYSE52" | "VYSE60" | "VZSE40";
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

export type EventType = "eew" | "quake" | "tsunami" | "advisory";

/** SSE と DB の events に載る 1 件。中身はその時点のまるごとの姿 */
export type SonaeEvent =
  | { seq: number; type: "eew"; data: Eew }
  | { seq: number; type: "quake"; data: Quake }
  | { seq: number; type: "tsunami"; data: Tsunami }
  | { seq: number; type: "advisory"; data: Advisory };

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
