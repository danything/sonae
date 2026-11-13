import { redirect } from "@sveltejs/kit";
import type { Handle, ServerInit } from "@sveltejs/kit/hooks";

import { enabled } from "#lib/server/oidc.ts";
import { startReceiving } from "#lib/server/receiver.ts";
import { COOKIE, find, SESSION_TTL } from "#lib/server/session.ts";
import { legacyRedirect } from "#lib/view.ts";

/** 手元の開発でだけ、ログインを飛ばせる (本番の NODE_ENV=production では効かない) */
const authSkipped = () =>
  process.env.AUTH_DISABLED === "1" && process.env.NODE_ENV !== "production";

/**
 * 起動したときに 1 回だけ、受信を起こす。`SONAE_RECEIVE=off` で止められる
 * (情報源につながずに画面だけ触りたいとき)。設定漏れはここで知らせる。
 */
export const init: ServerInit = () => {
  if (!enabled()) {
    console.warn(
      authSkipped()
        ? "AUTH_DISABLED=1 なので、ログイン無しで開けます (手元の開発だけ)"
        : "OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET が揃っていません。画面は開きません (/health だけ答えます)",
    );
  }
  if (process.env.NODE_ENV === "production" && !process.env.PUBLIC_URL) {
    console.warn(
      "PUBLIC_URL が空です。ログインの戻り先を要求の Host から組みます (本番では https://s.doany.io を入れてください)",
    );
  }
  if (process.env.SONAE_RECEIVE === "off") {
    console.warn("SONAE_RECEIVE=off なので、情報源につながりません");
    return;
  }
  startReceiving();
};

/**
 * 通した要求を画面へ渡す。前の画面の URL (`/quakes/[id]`・`/map` など) は、1 つの画面の URL へ 301 で送る
 * (`#lib/view.ts` の `legacyRedirect`。共有したリンクとブックマークを生かす)。ログインの後に送るので、
 * ログインへの戻り先には元の URL が残る
 */
const pass: Handle = ({ event, resolve }) => {
  const to = legacyRedirect(event.url);
  if (to !== null) redirect(301, to);
  return resolve(event);
};

/** ログイン無しで開けるところ (docs/design.md の 2.6) */
const PUBLIC = new Set(["/health", "/auth/login", "/auth/callback"]);

/**
 * ロールを持ってログインした人だけが開ける。IdP とのやり取りは /auth/login と /auth/callback に
 * 閉じてあり、普段の要求で外へ出ることはない。ロールはログインを通った時点で確かめてある。
 */
export const handle: Handle = async ({ event, resolve }) => {
  const { pathname, search } = event.url;
  if (PUBLIC.has(pathname)) return resolve(event);

  if (!enabled()) {
    if (authSkipped()) {
      event.locals.user = { subject: "dev", name: "開発" };
      return pass({ event, resolve });
    }
    return new Response("ログインの設定 (OIDC) がまだです", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const session = find(event.cookies.get(COOKIE));
  if (session) {
    event.locals.user = { subject: session.subject, name: session.name };
    // 使うたびに延ばす (延ばしたときだけ Cookie を書き直す)
    if (session.extended) {
      event.cookies.set(COOKIE, session.id, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: event.url.protocol === "https:",
        maxAge: SESSION_TTL,
      });
    }
    return pass({ event, resolve });
  }

  // 画面の読み込みだけログインへ送る。fetch や SSE は 401 のほうが分かる
  const wantsHtml =
    event.request.headers.get("accept")?.includes("text/html") === true;
  if (event.request.method !== "GET" || !wantsHtml) {
    return new Response("login required", { status: 401 });
  }
  redirect(302, `/auth/login?to=${encodeURIComponent(pathname + search)}`);
};
