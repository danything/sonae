import { error, json } from "@sveltejs/kit";

import { pushTestLimit } from "#lib/server/rate.ts";
import { app } from "#lib/server/receiver.ts";
import { subjectOf, testPayload, tooSoon } from "#lib/server/request.ts";

import type { RequestHandler } from "./$types";

/** 試しの通知を、自分のブラウザの購読に 1 つ送る。`{ endpoint }`。1 人 10 分に 5 回まで (`rate.ts`) */
export const POST: RequestHandler = async ({ locals, request }) => {
  const subject = subjectOf(locals);
  const p = app().pusher;
  if (!p) error(404, "Web Push は切ってあります (VAPID の鍵がありません)");
  let endpoint: unknown;
  try {
    endpoint = ((await request.json()) as { endpoint?: unknown }).endpoint;
  } catch {
    error(400, "JSON の本文が要ります");
  }
  const sub = p.list(subject).find((s) => s.endpoint === endpoint);
  if (!sub) error(404, "このブラウザは登録されていません");
  const wait = pushTestLimit.take(subject);
  if (wait > 0) return tooSoon(wait);
  const result = await p.send(
    sub,
    testPayload("このブラウザに通知が届きます。"),
    { ttl: 60, urgency: "normal" },
  );
  return json({ result });
};
