import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { migrate, openDb } from "#lib/server/db.ts";
import {
  allowed,
  challengeOf,
  forget,
  readPending,
  redirectUri,
  safeReturn,
  verify,
} from "#lib/server/oidc.ts";
import {
  create,
  destroy,
  find,
  hashOf,
  SESSION_TTL,
} from "#lib/server/session.ts";
const ISSUER = "https://login.example/tenant/v2.0";
const CLIENT_ID = "test-client";

const pair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const KID = "test-key";
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const encode = (v: object) =>
  b64url(new TextEncoder().encode(JSON.stringify(v)));

async function idToken(
  claims: object,
  header: object = {},
  key = pair.privateKey,
) {
  const head = encode({ alg: "RS256", kid: KID, typ: "JWT", ...header });
  const body = encode(claims);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const NOW = Date.UTC(2026, 8, 12);
const base = {
  iss: ISSUER,
  aud: CLIENT_ID,
  sub: "user-1",
  name: "テスト 太郎",
  nonce: "n1",
  exp: Math.floor(NOW / 1000) + 3600,
};

const realFetch = globalThis.fetch;
beforeEach(async () => {
  forget();
  process.env.OIDC_ISSUER = `${ISSUER}/`;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = "shhh";
  process.env.OIDC_ROLE = "";
  process.env.OIDC_ROLE_CLAIM = "";
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/keys`,
      });
    }
    if (url.endsWith("/keys"))
      return Response.json({ keys: [{ ...jwk, kid: KID }] });
    throw new Error(`呼ばれるはずのないエンドポイント: ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("oidc", () => {
  test("正しい id_token は通り、中身が読める", async () => {
    const claims = await verify(
      await idToken({ ...base, roles: ["admin"] }),
      "n1",
      NOW,
    );
    expect(claims.sub).toBe("user-1");
    expect(claims.roles).toEqual(["admin"]);
  });
  test("署名・発行元・宛先・期限・nonce・alg のどれが違っても断る", async () => {
    const other = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    await expect(
      verify(await idToken(base, {}, other.privateKey), "n1", NOW),
    ).rejects.toThrow(/署名/);
    await expect(
      verify(await idToken({ ...base, iss: "https://evil" }), "n1", NOW),
    ).rejects.toThrow(/発行元/);
    await expect(
      verify(await idToken({ ...base, aud: "someone-else" }), "n1", NOW),
    ).rejects.toThrow(/宛先/);
    await expect(
      verify(await idToken({ ...base, exp: base.exp - 7200 }), "n1", NOW),
    ).rejects.toThrow(/期限/);
    await expect(verify(await idToken(base), "other", NOW)).rejects.toThrow(
      /合言葉/,
    );
    await expect(
      verify(await idToken(base, { alg: "none" }), "n1", NOW),
    ).rejects.toThrow(/署名方式/);
    await expect(
      verify(await idToken(base, { alg: "HS256" }), "n1", NOW),
    ).rejects.toThrow(/署名方式/);
  });

  test("ロール (既定 admin) を持つ人だけ通す。groups でもよい。ロールの名前は OIDC_ROLE で替えられる", () => {
    expect(allowed({ ...base, roles: ["admin"] })).toEqual({ ok: true });
    expect(allowed({ ...base, groups: ["admin"] })).toEqual({ ok: true });
    expect(allowed({ ...base, roles: ["staff"] }).ok).toBe(false);
    expect(allowed(base).ok).toBe(false);
    expect(
      allowed({ ...base, _claim_names: { groups: "src1" } }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("多すぎ") });
    // 家族と共有するときは family 用のロールに替える
    process.env.OIDC_ROLE = "family";
    expect(allowed({ ...base, roles: ["admin"] })).toMatchObject({
      ok: false,
      reason: "ロール family を持っていません",
    });
    expect(allowed({ ...base, roles: ["family"] })).toEqual({ ok: true });
  });

  test("OIDC_ROLE_CLAIM で入れ子の claim からロールを読む", async () => {
    process.env.OIDC_ROLE_CLAIM = "realm_access.roles";
    const claims = await verify(
      await idToken({
        ...base,
        roles: ["staff"],
        realm_access: { roles: ["admin"] },
      }),
      "n1",
      NOW,
    );
    expect(claims.custom).toEqual(["admin"]);
    expect(allowed(claims)).toEqual({ ok: true });
  });

  test("PKCE と戻り先と途中の控え", async () => {
    expect(
      await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(redirectUri("https://s.doany.io")).toBe(
      "https://s.doany.io/auth/callback",
    );
    expect(safeReturn(null)).toBe("/");
    expect(safeReturn("//evil.example")).toBe("/");
    expect(safeReturn("/\\evil.example")).toBe("/");
    expect(safeReturn("/\t/evil.example")).toBe("/");
    expect(safeReturn("/\n/evil.example")).toBe("/");
    expect(safeReturn("/a\\b")).toBe("/");
    expect(safeReturn("https://evil.example")).toBe("/");
    expect(safeReturn("/quakes/x")).toBe("/quakes/x");
    expect(readPending(undefined)).toBeNull();
    expect(readPending("{bad")).toBeNull();
    expect(
      readPending(
        JSON.stringify({ state: "s", nonce: "n", verifier: "v", to: "/map" }),
      )?.to,
    ).toBe("/map");
  });
});

describe("session", () => {
  test("作った控えは引けて、消せば引けない", () => {
    const d = openDb(":memory:");
    const s = create("user-1", "テスト 太郎", d, NOW);
    expect(find(s.id, d, NOW)).toMatchObject({
      subject: "user-1",
      extended: false,
    });
    expect(find("nope", d, NOW)).toBeNull();
    expect(find(undefined, d, NOW)).toBeNull();
    destroy(s.id, d);
    expect(find(s.id, d, NOW)).toBeNull();
  });

  test("DB には生の ID を持たず、SHA-256 を持つ", () => {
    const d = openDb(":memory:");
    const s = create("user-1", "x", d, NOW);
    const rows = d
      .query<{ id_hash: string }, []>("SELECT id_hash FROM sessions")
      .all();
    expect(rows).toEqual([{ id_hash: hashOf(s.id) }]);
    expect(rows[0]?.id_hash).toMatch(/^[0-9a-f]{64}$/);
    // ハッシュの値を Cookie に入れても通らない
    expect(find(hashOf(s.id), d, NOW)).toBeNull();
    expect(find(s.id, d, NOW)?.id).toBe(s.id);
  });

  test("前のバージョン (平文の ID) の控えは、スキーマのバージョンを上げると捨てる", () => {
    const d = new Database(":memory:", { strict: true });
    d.run(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, subject TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    );
    d.run("INSERT INTO sessions VALUES ('plain', 'u', 'x', 0, 9e15)");
    d.run("PRAGMA user_version = 2");
    migrate(d);
    expect(find("plain", d, NOW)).toBeNull();
    expect(
      d.query<{ n: number }, []>("SELECT count(*) AS n FROM sessions").get()?.n,
    ).toBe(0);
  });

  test("180 日で切れ、使えば延びる (1 日に 1 回まで)", () => {
    const d = openDb(":memory:");
    const DAY = 24 * 60 * 60 * 1000;
    const s = create("user-1", "x", d, NOW);
    expect(find(s.id, d, NOW + DAY / 2)?.extended).toBe(false);
    const later = find(s.id, d, NOW + 100 * DAY);
    expect(later?.extended).toBe(true);
    expect(later?.expiresAt).toBe(NOW + 100 * DAY + SESSION_TTL * 1000);
    // 延ばしたので、作ってから 180 日たっても生きている
    expect(find(s.id, d, NOW + 200 * DAY)).not.toBeNull();
    // 使わずに 180 日たてば切れる
    expect(find(s.id, d, NOW + 200 * DAY + SESSION_TTL * 1000 + 1)).toBeNull();
  });
});
