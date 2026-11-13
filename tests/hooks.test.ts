import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isRedirect } from "@sveltejs/kit";
import type { Handle } from "@sveltejs/kit/hooks";

import { COOKIE, create, SESSION_TTL } from "#lib/server/session.ts";

import { handle } from "../src/hooks.server.ts";

// セッションは db() (SONAE_DATA、初めて呼んだときに開く) に持つ。手元の data/ に書かないよう、使い捨ての場所に
process.env.SONAE_DATA = mkdtempSync(join(tmpdir(), "sonae-hooks-"));

type Event = Parameters<Handle>[0]["event"];

const ENV_KEYS = [
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "AUTH_DISABLED",
  "NODE_ENV",
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.OIDC_ISSUER = "https://login.example/tenant/v2.0";
  process.env.OIDC_CLIENT_ID = "test-client";
  process.env.OIDC_CLIENT_SECRET = "shhh";
  delete process.env.AUTH_DISABLED;
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** hooks に渡す要求。resolve まで届いたら "resolved" を返す */
async function run(
  path: string,
  o: { method?: string; accept?: string; cookie?: string } = {},
) {
  const url = new URL(path, "https://s.example");
  const headers = new Headers();
  if (o.accept) headers.set("accept", o.accept);
  const set: { name: string; value: string; opts: unknown }[] = [];
  const event = {
    url,
    request: new Request(url, { method: o.method ?? "GET", headers }),
    cookies: {
      get: (name: string) => (name === COOKIE ? o.cookie : undefined),
      set: (name: string, value: string, opts: unknown) =>
        set.push({ name, value, opts }),
    },
    locals: {} as App.Locals,
  } as unknown as Event;
  let resolved = false;
  const resolve = (() => {
    resolved = true;
    return new Response("ok");
  }) as unknown as Parameters<Handle>[0]["resolve"];
  try {
    const res = await handle({ event, resolve });
    return { res, resolved, locals: event.locals, set };
  } catch (err) {
    if (isRedirect(err))
      return { redirect: err, resolved, locals: event.locals, set };
    throw err;
  }
}

const HTML = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";

describe("ログイン無しで開けるところ", () => {
  for (const path of ["/health", "/auth/login", "/auth/callback"]) {
    test(`${path} は Cookie が無くても通す`, async () => {
      const r = await run(path, { accept: HTML });
      expect(r.resolved).toBe(true);
      expect(r.locals.user).toBeUndefined();
    });
  }

  test("OIDC の設定が無くても /health は答える", async () => {
    delete process.env.OIDC_ISSUER;
    expect((await run("/health")).resolved).toBe(true);
  });

  test("似たパスは通さない", async () => {
    for (const path of ["/health/x", "/auth/logout", "/auth/login/"]) {
      expect((await run(path)).resolved).toBe(false);
    }
  });
});

describe("ログインしていないとき", () => {
  test("画面の読み込みはログインへ送り、戻り先にパスと問い合わせを付ける", async () => {
    const r = await run("/map?layer=a&b=1", { accept: HTML });
    expect(r.resolved).toBe(false);
    expect(r.redirect?.status).toBe(302);
    expect(r.redirect?.location).toBe(
      `/auth/login?to=${encodeURIComponent("/map?layer=a&b=1")}`,
    );
  });

  test("fetch・SSE (HTML を求めない要求) は 401", async () => {
    for (const accept of ["application/json", "text/event-stream", undefined]) {
      const r = await run("/api/stream", { accept });
      expect(r.resolved).toBe(false);
      expect(r.res?.status).toBe(401);
    }
  });

  test("GET でない要求は、HTML を求めても 401 (ログインへ送らない)", async () => {
    const r = await run("/", { method: "POST", accept: HTML });
    expect(r.res?.status).toBe(401);
  });

  test("知らない Cookie や、切れた控えは、無いのと同じ", async () => {
    expect((await run("/", { cookie: "nope" })).res?.status).toBe(401);
    const old = create(
      "user-1",
      "x",
      undefined,
      Date.now() - SESSION_TTL * 1000 - 1,
    );
    expect((await run("/", { cookie: old.id })).res?.status).toBe(401);
  });
});

describe("ログインしているとき", () => {
  test("前の画面の URL は 1 つの画面の URL へ 301 で送る", async () => {
    const s = create("user-1", "テスト 太郎");
    const r = await run("/quakes/abc", { accept: HTML, cookie: s.id });
    expect(r.resolved).toBe(false);
    expect(r.redirect?.status).toBe(301);
    expect(r.redirect?.location).toBe("/?q=abc");
  });

  test("控えがあれば通し、locals.user を入れる。延ばさないときは Cookie を書かない", async () => {
    const s = create("user-1", "テスト 太郎");
    const r = await run("/", { accept: HTML, cookie: s.id });
    expect(r.resolved).toBe(true);
    expect(r.locals.user).toEqual({ subject: "user-1", name: "テスト 太郎" });
    expect(r.set).toEqual([]);
  });

  test("古くなった控えは延ばし、Cookie を書き直す", async () => {
    const s = create(
      "user-2",
      "x",
      undefined,
      Date.now() - 2 * 24 * 60 * 60 * 1000,
    );
    const r = await run("/api/stream", { cookie: s.id });
    expect(r.resolved).toBe(true);
    expect(r.set).toHaveLength(1);
    expect(r.set[0]).toMatchObject({
      name: COOKIE,
      value: s.id,
      opts: {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: true,
        maxAge: SESSION_TTL,
      },
    });
  });
});

describe("OIDC の設定が無いとき", () => {
  beforeEach(() => {
    delete process.env.OIDC_CLIENT_SECRET;
  });

  test("503 で、画面は開かない", async () => {
    const r = await run("/", { accept: HTML });
    expect(r.resolved).toBe(false);
    expect(r.res?.status).toBe(503);
  });

  test("手元の開発 (AUTH_DISABLED=1) ならログインを飛ばす", async () => {
    process.env.AUTH_DISABLED = "1";
    const r = await run("/", { accept: HTML });
    expect(r.resolved).toBe(true);
    expect(r.locals.user).toEqual({ subject: "dev", name: "開発" });
  });

  test("本番 (NODE_ENV=production) では AUTH_DISABLED=1 が効かない", async () => {
    process.env.AUTH_DISABLED = "1";
    process.env.NODE_ENV = "production";
    expect((await run("/", { accept: HTML })).res?.status).toBe(503);
  });

  test("設定が揃っていれば、AUTH_DISABLED=1 でもログインを求める", async () => {
    process.env.OIDC_CLIENT_SECRET = "shhh";
    process.env.AUTH_DISABLED = "1";
    expect((await run("/")).res?.status).toBe(401);
  });
});
