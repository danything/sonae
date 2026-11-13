import { COOKIE, destroy } from "#lib/server/session.ts";

import type { RequestHandler } from "./$types";

/**
 * POST だけ。リンクを踏ませてログアウトさせられないように。
 * ログインの画面へ送ると IdP がそのまま通してしまう (シングル サインオン) ので、ここで止まる
 */
export const POST: RequestHandler = ({ cookies }) => {
  destroy(cookies.get(COOKIE));
  cookies.delete(COOKIE, { path: "/" });
  return new Response(
    '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>sonae</title><p>ログアウトしました。<a href="/auth/login">もう一度ログインする</a></p></html>',
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
};
