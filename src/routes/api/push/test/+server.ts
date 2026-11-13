import { error, json } from "@sveltejs/kit";

import { pushTestLimit } from "#lib/server/rate.ts";
import { app } from "#lib/server/receiver.ts";

import type { RequestHandler } from "./$types";

/** 試しの通知を、自分のブラウザの購読に 1 つ送る。`{ endpoint }`。1 人 10 分に 5 回まで (`rate.ts`) */
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) error(401, "login required");
  const p = app().pusher;
  if (!p) error(404, "Web Push は切ってあります (VAPID の鍵がありません)");
  let endpoint: unknown;
  try {
    endpoint = ((await request.json()) as { endpoint?: unknown }).endpoint;
  } catch {
    error(400, "JSON の本文が要ります");
  }
  const sub = p.list(locals.user.subject).find((s) => s.endpoint === endpoint);
  if (!sub) error(404, "このブラウザは登録されていません");
  const wait = pushTestLimit.take(locals.user.subject);
  if (wait > 0) {
    return json(
      { message: `試しの通知は続けて送れません。${wait} 秒後に送れます` },
      { status: 429, headers: { "retry-after": String(wait) } },
    );
  }
  const result = await p.send(
    sub,
    {
      title: "sonae の試しの通知",
      body: "このブラウザに通知が届きます。",
      tag: "test",
      url: "/",
      renotify: true,
      sticky: false,
      timestamp: Date.now(),
    },
    { ttl: 60, urgency: "normal" },
  );
  return json({ result });
};
