import { redirect } from "@sveltejs/kit";
import type { Handle, ServerInit } from "@sveltejs/kit/hooks";

import { enabled } from "#lib/server/oidc.ts";
import { startReceiving, startVoice } from "#lib/server/receiver.ts";
import { COOKIE, find, SESSION_TTL } from "#lib/server/session.ts";
import {
  checkTrusted,
  crossSiteWrite,
  reportForeignHost,
  trustConfig,
  TRUSTED_USER,
  trustEnabled,
  type TrustResult,
  trustWarnings,
} from "#lib/server/trust.ts";
import { legacyRedirect } from "#lib/view.ts";

/** 手元の開発でだけ、ログインを飛ばせる (本番の NODE_ENV=production では効かない) */
const authSkipped = () =>
  process.env.AUTH_DISABLED === "1" && process.env.NODE_ENV !== "production";

/**
 * 起動したときに 1 回だけ、受信を起こす。`SONAE_RECEIVE=off` で止められる
 * (情報源につながずに画面だけ触りたいとき)。設定漏れはここで知らせる。
 */
export const init: ServerInit = () => {
  const trust = trustConfig();
  for (const w of trustWarnings(trust)) console.warn(`[auth] ${w}`);
  if (trustEnabled(trust))
    console.warn(
      `[auth] 信頼するネットワーク (${trust.networks.join(", ")}) からは、ログインなしで開けます。その中の誰でも設定を変えられます (docs/install.md の「ログイン」)`,
    );
  if (!enabled() && !trustEnabled(trust)) {
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
  startVoice();
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

/**
 * ログイン無しで開けるところ (docs/design.md の 2.6)。Service Worker とマニフェストは、ブラウザが
 * Cookie の無い要求で取り直すことがある (中に秘密は無い)
 */
const PUBLIC = new Set([
  "/health",
  "/auth/login",
  "/auth/callback",
  "/service-worker.js",
  "/manifest.webmanifest",
]);

/**
 * ロールを持ってログインした人だけが開ける。IdP とのやり取りは /auth/login と /auth/callback に
 * 閉じてあり、普段の要求で外へ出ることはない。ロールはログインを通った時点で確かめてある。
 */
export const handle: Handle = async ({ event, resolve }) => {
  const { pathname, search } = event.url;
  if (PUBLIC.has(pathname)) return resolve(event);

  // 信頼するネットワークの中から、知っている名前で来た人は、ログインなしで通す (`#lib/server/trust.ts`)
  const trust = trustConfig();
  let outside: Extract<TrustResult, { ok: false }> | undefined;
  if (trustEnabled(trust)) {
    const r = checkTrusted(
      event.getClientAddress(),
      event.request.headers,
      trust,
    );
    if (r.ok) {
      // ログインなしで通すので、ほかのサイトから送らせた書き込みはここで断る (Cookie の SameSite が効かないため)
      if (crossSiteWrite(event.request, event.url.origin))
        return new Response("ほかのサイトからの書き込みは受けません", {
          status: 403,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      event.locals.user = { ...TRUSTED_USER };
      return pass({ event, resolve });
    }
    if (r.reason === "host") reportForeignHost(r.address, r.host);
    outside = r;
  }

  if (!enabled()) {
    if (authSkipped()) {
      event.locals.user = { subject: "dev", name: "開発" };
      return pass({ event, resolve });
    }
    // 理由を出す (相手のアドレスを相手に返すだけ。本人が何を足せばよいか分かるように)
    if (outside)
      return new Response(
        outside.reason === "host"
          ? `信頼するネットワークの中からでも、この名前ではログインなしで開けません。この名前で開くなら ALLOWED_HOSTS に足してください (docs/install.md)`
          : `信頼するネットワーク (TRUSTED_NETWORKS) の中からでないと開けません (接続元: ${outside.address || "不明"})`,
        {
          status: 403,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
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
