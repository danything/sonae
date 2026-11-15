import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isRedirect } from "@sveltejs/kit";
import type { Handle } from "@sveltejs/kit/hooks";

import {
  checkTrusted,
  crossSiteWrite,
  knownHost,
  trustConfig,
  TRUSTED_USER,
  trustWarnings,
} from "#lib/server/trust.ts";

import { handle } from "../src/hooks.server.ts";

process.env.SONAE_DATA = mkdtempSync(join(tmpdir(), "sonae-trust-"));

const LAN = "127.0.0.0/8,::1/128,192.168.0.0/16,10.0.0.0/8";
const h = (o: Record<string, string>) => new Headers(o);

describe("知っている名前 (DNS リバインディング除け)", () => {
  test("IP の直書き・localhost・ドットの無い名前・家の中の名前は通す", () => {
    for (const host of [
      "192.168.1.5:3030",
      "[fd00::5]:3030",
      "[::1]:3030",
      "localhost:3030",
      "nas:3030",
      "sonae.localhost",
      "pi.local",
      "server.lan",
      "box.home.arpa",
      "sonae.internal",
    ])
      expect(knownHost(host, [])).toBe(true);
  });

  test("ほかの名前は ALLOWED_HOSTS に書いたものだけ", () => {
    expect(knownHost("evil.example.com", [])).toBe(false);
    expect(knownHost("sonae.example.com", ["sonae.example.com"])).toBe(true);
    expect(knownHost("a.tail1234.ts.net", [".tail1234.ts.net"])).toBe(true);
    expect(knownHost("tail1234.ts.net", [".tail1234.ts.net"])).toBe(true);
    expect(knownHost("x.other.ts.net", [".tail1234.ts.net"])).toBe(false);
    // 末尾だけ似せた名前は当たらない
    expect(knownHost("evilsonae.example.com", ["sonae.example.com"])).toBe(
      false,
    );
  });

  test("家の中の接尾辞そのものや、読めない名前は通さない", () => {
    expect(knownHost(".local", [])).toBe(false);
    expect(knownHost("", [])).toBe(false);
    expect(knownHost("a b.local", [])).toBe(false);
  });
});

describe("信頼するネットワークの判定", () => {
  const c = trustConfig({ TRUSTED_NETWORKS: LAN });

  test("中から IP の名前で来れば通す", () => {
    expect(
      checkTrusted("192.168.1.20", h({ host: "192.168.1.10:3030" }), c),
    ).toEqual({
      ok: true,
      address: "192.168.1.20",
    });
    expect(
      checkTrusted("::ffff:127.0.0.1", h({ host: "localhost:3030" }), c).ok,
    ).toBe(true);
  });

  test("外からは通さない", () => {
    const r = checkTrusted("203.0.113.9", h({ host: "192.168.1.10:3030" }), c);
    expect(r).toEqual({ ok: false, address: "203.0.113.9", reason: "network" });
  });

  test("書いていなければ誰も通さない (いままでどおり)", () => {
    expect(
      checkTrusted("127.0.0.1", h({ host: "localhost" }), trustConfig({})).ok,
    ).toBe(false);
  });

  test("中からでも、知らない名前なら通さない", () => {
    expect(
      checkTrusted("192.168.1.20", h({ host: "evil.example.com" }), c),
    ).toEqual({
      ok: false,
      address: "192.168.1.20",
      reason: "host",
      host: "evil.example.com",
    });
    // Host が無いときも
    expect(checkTrusted("192.168.1.20", h({}), c).ok).toBe(false);
  });

  test("HOST_HEADER を設定していれば、そのヘッダの名前も見る", () => {
    const fwd = trustConfig({
      TRUSTED_NETWORKS: LAN,
      HOST_HEADER: "X-Forwarded-Host",
    });
    expect(
      checkTrusted(
        "192.168.1.20",
        h({ host: "192.168.1.10", "x-forwarded-host": "evil.example.com" }),
        fwd,
      ).ok,
    ).toBe(false);
    expect(
      checkTrusted(
        "192.168.1.20",
        h({ host: "192.168.1.10", "x-forwarded-host": "sonae.localhost" }),
        fwd,
      ).ok,
    ).toBe(true);
  });

  test("X-Forwarded-For は前段 (TRUSTED_PROXIES) から来たときだけ読む", () => {
    const xff = h({
      host: "sonae.localhost",
      "x-forwarded-for": "192.168.1.20",
    });
    // 前段を書いていなければ、外の相手がヘッダで LAN を名乗っても通さない
    expect(checkTrusted("203.0.113.9", xff, c).ok).toBe(false);
    // 前段 (genkan のネットワーク) から来たら、ヘッダの接続元で決める
    const genkan = trustConfig({
      TRUSTED_NETWORKS: "192.168.0.0/16,10.0.0.0/8,172.20.0.1",
      TRUSTED_PROXIES: "172.20.0.0/16",
    });
    expect(checkTrusted("172.20.0.5", xff, genkan)).toEqual({
      ok: true,
      address: "192.168.1.20",
    });
    // 前段越しでも、本当の接続元が外なら通さない (前段のネットワークそのものは信頼しない)
    expect(
      checkTrusted(
        "172.20.0.5",
        h({ host: "sonae.localhost", "x-forwarded-for": "203.0.113.9" }),
        genkan,
      ).ok,
    ).toBe(false);
    // 前段の後ろにいる人が、左に偽のアドレスを足して来ても、右から最初の前段でないアドレスを使う
    expect(
      checkTrusted(
        "172.20.0.5",
        h({
          host: "sonae.localhost",
          "x-forwarded-for": "192.168.1.20, 203.0.113.9",
        }),
        genkan,
      ).ok,
    ).toBe(false);
    // このマシンのブラウザ (genkan のゲートウェイから来たように見える)
    expect(
      checkTrusted(
        "172.20.0.5",
        h({ host: "sonae.localhost", "x-forwarded-for": "172.20.0.1" }),
        genkan,
      ).ok,
    ).toBe(true);
  });

  test("ADDRESS_HEADER を設定していたら使わない (接続元を誰でも名乗れるため)", () => {
    const c2 = trustConfig({
      TRUSTED_NETWORKS: LAN,
      ADDRESS_HEADER: "x-forwarded-for",
    });
    expect(
      checkTrusted("192.168.1.20", h({ host: "192.168.1.10" }), c2).ok,
    ).toBe(false);
    expect(trustWarnings(c2).some((w) => w.includes("ADDRESS_HEADER"))).toBe(
      true,
    );
  });

  test("書き損じを知らせる", () => {
    expect(
      trustWarnings(
        trustConfig({ TRUSTED_NETWORKS: "192.168.0/16,10.0.0.0/8" }),
      ),
    ).toEqual(["TRUSTED_NETWORKS の「192.168.0/16」は読めないので無視します"]);
  });
});

// hooks を通したとき
type Event = Parameters<Handle>[0]["event"];
const KEYS = [
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "AUTH_DISABLED",
  "NODE_ENV",
  "TRUSTED_NETWORKS",
  "TRUSTED_PROXIES",
  "ALLOWED_HOSTS",
  "ADDRESS_HEADER",
  "HOST_HEADER",
] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.NODE_ENV = "production";
  process.env.TRUSTED_NETWORKS = LAN;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function run(
  path: string,
  peer: string,
  host: string,
  o: { method?: string; headers?: Record<string, string> } = {},
) {
  const url = new URL(path, `http://${host}`);
  const headers = new Headers({ host, accept: "text/html", ...o.headers });
  const event = {
    url,
    request: new Request(url, { method: o.method ?? "GET", headers }),
    getClientAddress: () => peer,
    cookies: { get: () => undefined, set: () => {} },
    locals: {} as App.Locals,
  } as unknown as Event;
  let resolved = false;
  const resolve = (() => {
    resolved = true;
    return new Response("ok");
  }) as unknown as Parameters<Handle>[0]["resolve"];
  try {
    const res = await handle({ event, resolve });
    return { res, resolved, locals: event.locals };
  } catch (err) {
    if (isRedirect(err))
      return { redirect: err, resolved, locals: event.locals };
    throw err;
  }
}

describe("hooks: 信頼するネットワーク", () => {
  test("中からはログインなしで開け、全員が 1 人の利用者になる", async () => {
    const r = await run("/", "192.168.1.20", "192.168.1.10:3030");
    expect(r.resolved).toBe(true);
    expect(r.locals.user).toEqual({ ...TRUSTED_USER });
  });

  test("OIDC が無いとき、外からは 403 で理由を返す (503 ではない)", async () => {
    const r = await run("/", "203.0.113.9", "198.51.100.1:3030");
    expect(r.resolved).toBe(false);
    expect(r.res?.status).toBe(403);
    expect(await r.res?.text()).toContain("203.0.113.9");
  });

  test("中からでも知らない名前なら 403", async () => {
    const r = await run("/", "192.168.1.20", "evil.example.com");
    expect(r.resolved).toBe(false);
    expect(r.res?.status).toBe(403);
  });

  test("OIDC があれば、外の人はログインへ (中の人はログインなし)", async () => {
    process.env.OIDC_ISSUER = "https://login.example/tenant/v2.0";
    process.env.OIDC_CLIENT_ID = "c";
    process.env.OIDC_CLIENT_SECRET = "s";
    const outside = await run("/", "203.0.113.9", "sonae.example.com");
    expect(outside.redirect?.status).toBe(302);
    const inside = await run("/", "192.168.1.20", "192.168.1.10:3030");
    expect(inside.resolved).toBe(true);
  });

  test("TRUSTED_NETWORKS が無ければ、いままでどおり 503", async () => {
    delete process.env.TRUSTED_NETWORKS;
    const r = await run("/", "127.0.0.1", "localhost:3030");
    expect(r.res?.status).toBe(503);
  });
});

describe("ほかのサイトから送らせた書き込み (ログインなしの経路の CSRF)", () => {
  const origin = "http://192.168.1.10:3030";
  const req = (method: string, headers: Record<string, string>) =>
    new Request(`${origin}/api/speech`, { method, headers });

  test("同じオリジンからの書き込みと、読むだけの要求は通す", () => {
    expect(
      crossSiteWrite(
        req("PUT", { origin, "sec-fetch-site": "same-origin" }),
        origin,
      ),
    ).toBe(false);
    expect(
      crossSiteWrite(req("GET", { "sec-fetch-site": "cross-site" }), origin),
    ).toBe(false);
    // ブラウザでない道具 (Origin も Sec-Fetch-Site も付けない) は、ほかのサイトから送らせることができない
    expect(crossSiteWrite(req("POST", {}), origin)).toBe(false);
    // 前段が TLS を終えて url.origin が http のままでも、ブラウザが same-origin と言えば通す (Origin の scheme は違う)
    expect(
      crossSiteWrite(
        req("POST", {
          origin: "https://sonae.example.com",
          "sec-fetch-site": "same-origin",
        }),
        "http://sonae.example.com",
      ),
    ).toBe(false);
    // Sec-Fetch-Site の無い古いブラウザは Origin で決める
    expect(crossSiteWrite(req("POST", { origin }), origin)).toBe(false);
  });

  test("ほかのサイトからの書き込みは断る", () => {
    expect(
      crossSiteWrite(
        req("POST", { origin: "https://evil.example.com" }),
        origin,
      ),
    ).toBe(true);
    expect(
      crossSiteWrite(req("PUT", { "sec-fetch-site": "cross-site" }), origin),
    ).toBe(true);
    expect(
      crossSiteWrite(
        req("DELETE", {
          "sec-fetch-site": "same-site",
          origin: "http://192.168.1.10:8080",
        }),
        origin,
      ),
    ).toBe(true);
  });

  test("hooks: 信頼するネットワークの中でも、ほかのサイトから送らせた書き込みは 403", async () => {
    const evil = await run("/api/speech", "192.168.1.20", "192.168.1.10:3030", {
      method: "PUT",
      headers: {
        origin: "https://evil.example.com",
        "content-type": "text/plain",
      },
    });
    expect(evil.resolved).toBe(false);
    expect(evil.res?.status).toBe(403);
    const same = await run("/api/speech", "192.168.1.20", "192.168.1.10:3030", {
      method: "PUT",
      headers: {
        origin: "http://192.168.1.10:3030",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(same.resolved).toBe(true);
  });
});
