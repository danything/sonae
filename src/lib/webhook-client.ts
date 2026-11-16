/**
 * Webhook を読む・足す・消す・試す道と、条件を Webhook にも送る道 (画面だけで使う。docs/design.md の 2.4)。
 * 「通知」の窓 (`WebhookSettings.svelte`・`PushSettings.svelte`) と、地図のメニュー (`#lib/push-client.ts` の `saveHome`) が使う。
 *
 * Webhook の条件は、登録した人が「通知」で最後に変えた条件。条件を変えたら、その人の Webhook 全部に送る。
 * 続けて変えたときに前の送信と追い越さないよう、送るのは 1 つずつ順に
 */

import { createQueue } from "./prefs-queue.ts";
import type { PushPrefs } from "./push.ts";
import type { WebhookView } from "./webhook.ts";

/** この人の Webhook の数。まだ読んでいなければ undefined (そのときは条件を送ってみる) */
let count: number | undefined;

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** サーバーが返した理由 (本文の message か、ただの文) */
async function reason(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message;
    if (typeof m === "string") return m;
  } catch {
    // ただの文
  }
  return text ? `${res.status}: ${text}` : String(res.status);
}

export async function readWebhooks(): Promise<WebhookView[]> {
  const res = await fetch("/api/webhooks");
  if (!res.ok) throw new Error(`Webhook を読めませんでした (${res.status})`);
  const { webhooks } = (await res.json()) as { webhooks: WebhookView[] };
  count = webhooks.length;
  return webhooks;
}

/** 足す。うまくいけば null、だめなら理由 */
export async function addWebhook(
  url: string,
  prefs: PushPrefs,
): Promise<string | null> {
  const res = await fetch("/api/webhooks", json("POST", { url, prefs }));
  if (res.ok) {
    count = (count ?? 0) + 1;
    return null;
  }
  return `追加できませんでした (${await reason(res)})`;
}

/** 解除。うまくいけば null、だめなら理由 */
export async function removeWebhook(id: number): Promise<string | null> {
  const res = await fetch("/api/webhooks", json("DELETE", { id }));
  if (res.ok) {
    count = undefined;
    return null;
  }
  return `解除できませんでした (${await reason(res)})`;
}

/** 試しの通知を送り、結果の文を返す */
export async function testWebhook(id: number): Promise<string> {
  const res = await fetch("/api/webhooks/test", json("POST", { id }));
  if (res.status === 429) return await reason(res);
  if (!res.ok) return `送れませんでした (${await reason(res)})`;
  const { result } = (await res.json()) as { result: string };
  return result === "ok"
    ? "送りました。届いたか、送り先のチャンネルを見てください。"
    : `送れませんでした (${result})`;
}

const queue = createQueue();

/**
 * 条件を、この人の Webhook 全部に送る。Webhook が無いと分かっていれば送らない。
 * 返すのは、送れなかったときの理由 (送れたとき・送らなかったときは null)
 */
export async function syncWebhookPrefs(
  prefs: PushPrefs,
): Promise<string | null> {
  if (count === 0) return null;
  const r = await queue.push(async () => {
    const res = await fetch("/api/webhooks", json("PUT", { prefs }));
    return res.ok
      ? ""
      : `Webhook の条件を保存できませんでした (${await reason(res)})`;
  });
  return r ? r : null;
}
