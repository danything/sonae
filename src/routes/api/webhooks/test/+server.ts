import { error, json } from "@sveltejs/kit";

import { webhookTestLimit } from "#lib/server/rate.ts";
import { app } from "#lib/server/receiver.ts";

import type { RequestHandler } from "./$types";

/**
 * 試しの通知を、自分の Webhook に 1 つ送る。`{ id }`。1 人 10 分に 5 回まで (`rate.ts`)。
 * 返すのは結果 (`ok` か、HTTP の状態・決まった言葉の理由) だけで、相手の本文は返さない
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) error(401, "login required");
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
  const hook = hooks.list(locals.user.subject).find((w) => w.id === id);
  if (!hook) error(404, "この Webhook は登録されていません");
  const wait = webhookTestLimit.take(locals.user.subject);
  if (wait > 0) {
    return json(
      { message: `試しの通知は続けて送れません。${wait} 秒後に送れます` },
      { status: 429, headers: { "retry-after": String(wait) } },
    );
  }
  const result = await hooks.send(hook, {
    title: "sonae の試しの通知",
    body: "この Webhook に通知が届きます。",
    tag: "test",
    url: "/",
    renotify: true,
    sticky: false,
    timestamp: Date.now(),
  });
  return json({ result });
};
