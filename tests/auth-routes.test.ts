import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { plain } from "#lib/server/request.ts";
import { cookieOptions } from "#lib/server/session.ts";

import { GET as callback } from "../src/routes/auth/callback/+server.ts";
import { GET as login } from "../src/routes/auth/login/+server.ts";

describe("ログインの routes (OIDC を設定していないとき)", () => {
  const saved = process.env.OIDC_ISSUER;
  beforeEach(() => {
    delete process.env.OIDC_ISSUER;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OIDC_ISSUER;
    else process.env.OIDC_ISSUER = saved;
  });

  for (const [name, handler, path] of [
    ["/auth/login", login, "/auth/login"],
    ["/auth/callback", callback, "/auth/callback?code=x&state=y"],
  ] as const)
    test(`${name} は 404 を、文字化けしないよう charset 付きの文で返す`, async () => {
      const url = new URL(`http://sonae.test${path}`);
      const res = (await handler({
        url,
        cookies: { get: () => undefined, set() {}, delete() {} },
      } as never)) as Response;
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await res.text()).toBe("OIDC が設定されていません");
    });
});

test("plain は状態と文と charset 付きの Content-Type を返す", async () => {
  const res = plain(403, "ほかのサイトからの書き込みは受けません");
  expect(res.status).toBe(403);
  expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await res.text()).toBe("ほかのサイトからの書き込みは受けません");
});

test("cookieOptions は https のときだけ secure を付ける", () => {
  expect(cookieOptions(new URL("https://sonae.test/"), 60)).toEqual({
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 60,
  });
  expect(cookieOptions(new URL("http://sonae.test/"), 60).secure).toBe(false);
});
