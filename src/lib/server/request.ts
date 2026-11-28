/** routes の +server.ts と hooks が共通で使う、要求の読み方と応答の組み方 */

import { error, json } from "@sveltejs/kit";

import type { PushPayload } from "#lib/push.ts";

/** 文字だけの応答。日本語の理由が文字化けしないよう charset を付ける */
export const plain = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/** ログインした人 (信頼するネットワークの人も) の subject。無ければ 401 (hooks の内側なので、ふつうは来ない) */
export function subjectOf(locals: App.Locals): string {
  if (!locals.user) error(401, "login required");
  return locals.user.subject;
}

/**
 * 本文の JSON のオブジェクト。読めなければ 400。`jsonOnly` なら、Content-Type が JSON でないと 415
 * (ほかのサイトから JSON で送るにはプリフライトが要り、通らない)
 */
export async function jsonBody(
  request: Request,
  jsonOnly = false,
): Promise<Record<string, unknown>> {
  if (
    jsonOnly &&
    !(request.headers.get("content-type") ?? "").startsWith("application/json")
  )
    error(415, "JSON の本文が要ります");
  try {
    const v: unknown = await request.json();
    if (typeof v === "object" && v !== null)
      return v as Record<string, unknown>;
  } catch {
    // 下で 400
  }
  error(400, "JSON の本文が要ります");
}

/** 試しの通知を続けて送ったときの 429。`wait` は送れるようになるまでの秒数 (`rate.ts`) */
export const tooSoon = (wait: number) =>
  json(
    { message: `試しの通知は続けて送れません。${wait} 秒後に送れます` },
    { status: 429, headers: { "retry-after": String(wait) } },
  );

/** 試しの通知の中身 (Web Push と Webhook で見出しを同じにする) */
export const testPayload = (body: string): PushPayload => ({
  title: "sonae の試しの通知",
  body,
  tag: "test",
  url: "/",
  renotify: true,
  sticky: false,
  timestamp: Date.now(),
});
