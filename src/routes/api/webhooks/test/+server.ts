import { error, json } from "@sveltejs/kit";

import { webhookTestLimit } from "#lib/server/rate.ts";
import { app } from "#lib/server/receiver.ts";
import { subjectOf, testPayload, tooSoon } from "#lib/server/request.ts";

import type { RequestHandler } from "./$types";

/**
 * 試しの通知を、自分の Webhook に 1 つ送る。`{ id }`。1 人 10 分に 5 回まで (`rate.ts`)。
 * 返すのは結果 (`ok` か、HTTP の状態・決まった言葉の理由) だけで、相手の本文は返さない
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const subject = subjectOf(locals);
  if (
    !(request.headers.get("content-type") ?? "").startsWith("application/json")
  )
    error(415, "JSON の本文が要ります");
  let id: unknown;
  try {
    id = ((await request.json()) as { id?: unknown }).id;
  } catch {
    error(400, "JSON の本文が要ります");
  }
  const hooks = app().webhooks;
  const hook = hooks.list(subject).find((w) => w.id === id);
  if (!hook) error(404, "この Webhook は登録されていません");
  const wait = webhookTestLimit.take(subject);
  if (wait > 0) return tooSoon(wait);
  const result = await hooks.send(
    hook,
    testPayload("この Webhook に通知が届きます。"),
  );
  return json({ result });
};
