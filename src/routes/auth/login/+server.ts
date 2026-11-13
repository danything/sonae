import { redirect } from "@sveltejs/kit";

import { enabled, redirectUri, safeReturn, start } from "#lib/server/oidc.ts";
import { PENDING_COOKIE, PENDING_TTL } from "#lib/server/session.ts";
import { siteOrigin } from "#lib/server/site.ts";

import type { RequestHandler } from "./$types";

/** ログインを始める。IdP へ送るだけで、こちらでは何も決めない。 */
export const GET: RequestHandler = async ({ url, cookies }) => {
  if (!enabled())
    return new Response("OIDC が設定されていません", { status: 404 });
  let started: Awaited<ReturnType<typeof start>>;
  try {
    started = await start(
      redirectUri(siteOrigin(url)),
      safeReturn(url.searchParams.get("to")),
    );
  } catch (cause) {
    // IdP の設定 (discovery) を読めないとき。素の 500 では切り分けられない
    console.warn(`[auth] ログインを始められませんでした: ${cause}`);
    return new Response(
      `ログインを始められませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
      { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  const { url: authorize, pending } = started;
  cookies.set(PENDING_COOKIE, JSON.stringify(pending), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: url.protocol === "https:",
    maxAge: PENDING_TTL,
  });
  redirect(302, authorize, { external: true });
};
