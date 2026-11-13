import { error, json } from "@sveltejs/kit";

import { normalizePrefs } from "#lib/push.ts";
import { parseSubscription } from "#lib/server/push.ts";
import { app } from "#lib/server/receiver.ts";

import type { RequestHandler } from "./$types";

/**
 * Web Push の購読 (docs/design.md の 2.4)。ログインした人が、自分のブラウザの購読を登録・更新・解除する。
 * VAPID の鍵が無いときは `enabled: false` を返し、登録は受けない。
 */

function who(locals: App.Locals): string {
  if (!locals.user) error(401, "login required");
  return locals.user.subject;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await request.json();
    if (typeof v === "object" && v !== null)
      return v as Record<string, unknown>;
  } catch {
    // 下で 400
  }
  error(400, "JSON の本文が要ります");
}

function pusherOr404() {
  const p = app().pusher;
  if (!p) error(404, "Web Push は切ってあります (VAPID の鍵がありません)");
  return p;
}

/** この人の購読の一覧と、公開鍵。endpoint は自分のブラウザの購読を見分けるのに使う */
export const GET: RequestHandler = ({ locals }) => {
  const subject = who(locals);
  const p = app().pusher;
  if (!p) return json({ enabled: false });
  return json({
    enabled: true,
    publicKey: p.vapid.publicKey,
    subscriptions: p.list(subject).map((s) => ({
      endpoint: s.endpoint,
      label: s.label,
      prefs: s.prefs,
      createdAt: s.createdAt,
    })),
  });
};

/** 登録・条件の更新。`{ subscription: PushSubscription.toJSON(), prefs, label }` */
export const PUT: RequestHandler = async ({ locals, request }) => {
  const subject = who(locals);
  const p = pusherOr404();
  const b = await body(request);
  const sub = parseSubscription(b.subscription);
  if (!sub) error(400, "購読の形が違うか、知らない配信サービスです");
  const label = typeof b.label === "string" ? b.label : "";
  if (p.save(subject, sub, normalizePrefs(b.prefs), label) === "full") {
    error(
      409,
      "登録できるブラウザの数の上限です。使っていないものを解除してください",
    );
  }
  return json({ ok: true });
};

/** 解除。`{ endpoint }`。自分の購読だけ消せる */
export const DELETE: RequestHandler = async ({ locals, request }) => {
  const subject = who(locals);
  const p = pusherOr404();
  const b = await body(request);
  if (typeof b.endpoint !== "string") error(400, "endpoint が要ります");
  return json({ ok: p.remove(subject, b.endpoint) });
};
