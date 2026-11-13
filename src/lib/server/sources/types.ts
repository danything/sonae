import type {
  Advisory,
  Eew,
  QuakeReport,
  SourceId,
  SourceStatus,
  Status,
  TsunamiArea,
  TsunamiObservation,
  Volcano,
} from "#lib/model.ts";

/** 1 つの情報源の、1 つの報。まとめ方 (新旧の判定) は store.ts がする */
export type EewReport = Omit<Eew, "sources" | "updatedAt"> & {
  source: "wolfx" | "p2p";
};

export interface QuakeIncoming {
  type: "quake";
  eventId?: string;
  status: Status;
  report: QuakeReport;
}

export interface TsunamiReport {
  code: "VTSE41" | "VTSE51" | "VTSE52" | "P2P552";
  source: "jma" | "p2p";
  eventIds: string[];
  status: Status;
  infoType: "発表" | "訂正" | "取消";
  reportedAt: string;
  headline?: string;
  /** 予報区の状態。VTSE52 には無い (undefined)。P2P の解除は空の並び */
  areas?: TsunamiArea[];
  observations: TsunamiObservation[];
}

export type Normalized =
  | { type: "eew"; report: EewReport }
  | QuakeIncoming
  | { type: "tsunami"; report: TsunamiReport }
  | { type: "advisory"; advisory: Omit<Advisory, "updatedAt" | "cancelled"> }
  | { type: "volcano"; volcano: Omit<Volcano, "updatedAt" | "cancelled"> }
  /** 保存だけする電文 (地震の活動状況・地震回数・長周期地震動など) */
  | { type: "other"; code: string };

/** 情報源から受けたもの。raw は原文 (Wolfx は原文を残さないので body が無い) */
export interface Incoming {
  source: SourceId;
  /** 情報源の中での重複の除去の鍵 (気象庁は Atom の id、P2P は id、Wolfx は EventID と報数) */
  key: string;
  code: string;
  body?: string;
  items: Normalized[];
  /** 読めなかったときの理由 (原文だけ残す) */
  error?: string;
}

export interface Source {
  id: SourceId;
  /** 止めるまで受け続ける。切れたら自分で張り直す */
  run(signal: AbortSignal): Promise<void>;
  status(): SourceStatus;
}

export interface SourceContext {
  emit(m: Incoming): void;
  /** もう受けた鍵か (取り直さないため) */
  seen(source: SourceId, key: string): boolean;
  onStatus?(s: SourceStatus): void;
}
