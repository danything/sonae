import type { Eew } from "./model.ts";

/** 緊急地震速報の帯を出しておく時間。最終報・取消の後もしばらく残す */
export const EEW_SHOW_MS = 3 * 60_000;

/** いま帯に出す緊急地震速報 (訓練・試験は出さない) */
export const activeEews = (eews: Eew[], now: number) =>
  eews.filter(
    (e) => e.status === "normal" && now - Date.parse(e.updatedAt) < EEW_SHOW_MS,
  );
