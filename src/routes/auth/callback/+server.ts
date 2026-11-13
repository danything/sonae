import { redirect } from "@sveltejs/kit";

import {
  complete,
  enabled,
  readPending,
  redirectUri,
} from "#lib/server/oidc.ts";
import {
  COOKIE,
  create,
  PENDING_COOKIE,
  SESSION_TTL,
} from "#lib/server/session.ts";
import { siteOrigin } from "#lib/server/site.ts";

import type { RequestHandler } from "./$types";

// 人が見る画面。何が起きたか読めないと、設定のどこが悪いのか追えない
const failed = (message: string) =>
  new Response(`ログインできませんでした: ${message}`, {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/** IdP から戻ってくるところ。state が合うことが「自分が始めたログイン」の証拠。 */
export const GET: RequestHandler = async ({ url, cookies }) => {
  if (!enabled())
    return new Response("OIDC が設定されていません", { status: 404 });
  const pending = readPending(cookies.get(PENDING_COOKIE));
  cookies.delete(PENDING_COOKIE, { path: "/" });

  const error = url.searchParams.get("error");
  if (error !== null) {
    return failed(
      `${error} ${url.searchParams.get("error_description") ?? ""}`.trim(),
    );
  }
  if (!pending)
    return failed("ログインの途中の控えがありません。もう一度お試しください");
  if (url.searchParams.get("state") !== pending.state)
    return failed("state が合いません");
  const code = url.searchParams.get("code");
  if (!code) return failed("code がありません");

  let who: Awaited<ReturnType<typeof complete>>;
  try {
    who = await complete(code, redirectUri(siteOrigin(url)), pending);
  } catch (cause) {
    console.warn(`[auth] ログインを断りました: ${cause}`);
    return failed(cause instanceof Error ? cause.message : String(cause));
  }
  const session = create(who.subject, who.name);
  console.log(`[auth] ログイン: ${who.name || who.subject}`);
  cookies.set(COOKIE, session.id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: url.protocol === "https:",
    maxAge: SESSION_TTL,
  });
  redirect(303, pending.to);
};
