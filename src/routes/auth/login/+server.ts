import { redirect } from "@sveltejs/kit";

import { enabled, redirectUri, safeReturn, start } from "#lib/server/oidc.ts";
import { PENDING_COOKIE, PENDING_TTL } from "#lib/server/session.ts";
import { siteOrigin } from "#lib/server/site.ts";

import type { RequestHandler } from "./$types";

/** ログインを始める。IdP へ送るだけで、こちらでは何も決めない。 */
export const GET: RequestHandler = async ({ url, cookies }) => {
  if (!enabled())
    return new Response("OIDC が設定されていません", { status: 404 });
  const { url: authorize, pending } = await start(
    redirectUri(siteOrigin(url)),
    safeReturn(url.searchParams.get("to")),
  );
  cookies.set(PENDING_COOKIE, JSON.stringify(pending), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: url.protocol === "https:",
    maxAge: PENDING_TTL,
  });
  redirect(302, authorize, { external: true });
};
