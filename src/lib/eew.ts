import type { Eew } from "./model.ts";

/** 緊急地震速報を「いま出ている」とする時間 (自動で開いた詳しい内容・地図・一覧の先頭)。最終報・取消の後もしばらく残す */
export const EEW_SHOW_MS = 3 * 60_000;

/** いま出ている緊急地震速報 (訓練・試験は除く) */
export const activeEews = (eews: Eew[], now: number) =>
  eews.filter(
    (e) => e.status === "normal" && now - Date.parse(e.updatedAt) < EEW_SHOW_MS,
  );
