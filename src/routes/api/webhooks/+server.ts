import { error, json } from "@sveltejs/kit";

import { normalizePrefs } from "#lib/push.ts";
import { app } from "#lib/server/receiver.ts";
import { jsonBody, subjectOf } from "#lib/server/request.ts";
import { hostOf, webhookUrl } from "#lib/server/webhook.ts";
import type { WebhookView } from "#lib/webhook.ts";

import type { RequestHandler } from "./$types";

/**
 * Webhook の送り先 (docs/design.md の 2.4)。ログインした人が、自分の Webhook を足す・条件を替える・消す。
 * **URL は秘密** なので、一覧にはホストだけを返す (足した後は URL を返さない)。
 * 本文は JSON だけ受ける (415。`jsonBody`)
 */

/** この人の Webhook の一覧 (ホストと直近の結果だけ) */
export const GET: RequestHandler = ({ locals }) => {
  const subject = subjectOf(locals);
  const webhooks: WebhookView[] = app()
    .webhooks.list(subject)
    .map((w) => ({
      id: w.id,
      host: hostOf(w.url),
      createdAt: w.createdAt,
      lastStatus: w.lastStatus,
      lastSentAt: w.lastSentAt,
    }));
  return json({ webhooks });
};

/** 足す。`{ url, prefs }`。条件は「通知」の条件 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const subject = subjectOf(locals);
  const b = await jsonBody(request, true);
  const url = typeof b.url === "string" ? b.url.trim() : "";
  if (!webhookUrl(url)) error(400, "http か https の URL を入れてください");
  const id = app().webhooks.add(subject, url, normalizePrefs(b.prefs));
  if (id === "full") {
    error(409, "Webhook の数の上限です。使っていないものを解除してください");
  }
  return json({ id });
};

/** この人の Webhook 全部の条件を替える。`{ prefs }` (「通知」の条件を変えたとき) */
export const PUT: RequestHandler = async ({ locals, request }) => {
  const subject = subjectOf(locals);
  const b = await jsonBody(request, true);
  return json({
    count: app().webhooks.setPrefs(subject, normalizePrefs(b.prefs)),
  });
};

/** 解除。`{ id }`。自分の Webhook だけ消せる */
export const DELETE: RequestHandler = async ({ locals, request }) => {
  const subject = subjectOf(locals);
  const b = await jsonBody(request, true);
  if (typeof b.id !== "number") error(400, "id が要ります");
  return json({ ok: app().webhooks.remove(subject, b.id) });
};
