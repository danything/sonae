/**
 * Webhook の、画面とサーバーの間で受け渡す形 (docs/design.md の 2.4)。
 * URL は秘密なので、画面にはホストだけを渡す (`GET /api/webhooks`)。
 */

export interface WebhookView {
  id: number;
  /** 送り先のホスト (`discord.com` など)。パスとクエリは出さない */
  host: string;
  createdAt: number;
  /** 最後に送った結果 (`ok` か、HTTP の状態・決まった言葉の理由)。まだ送っていなければ null */
  lastStatus: string | null;
  lastSentAt: number | null;
}

/** 直近の結果を 1 行で (「成功」「404」「時間切れです」) */
export const statusLabel = (status: string | null): string =>
  status === null ? "未送信" : status === "ok" ? "成功" : status;
