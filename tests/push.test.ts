import { describe, expect, test } from "bun:test";

import type { SonaeEvent } from "#lib/model.ts";
import { DEFAULT_PREFS, normalizePrefs, toNotification } from "#lib/push.ts";
import { openDb } from "#lib/server/db.ts";
import {
  digestOf,
  matches,
  noticeOf,
  plan,
  type Sent,
} from "#lib/server/notify.ts";
import { parseSubscription, Pusher, vapidFromEnv } from "#lib/server/push.ts";
import { RateLimit } from "#lib/server/rate.ts";
import { parseJmaXml } from "#lib/server/sources/jma-xml.ts";

import { eew, NOW, prefs, quake, tsunami } from "./events.ts";
import { codeOf, fixture, memoryStore } from "./helpers.ts";

const b64url = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString(
    "base64url",
  );

/** 試しの VAPID の鍵 (テストの中でだけ作る) */
async function testJwk(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

/** ブラウザの購読の代わり (鍵は本物の P-256 の点) */
async function testSubscription(endpoint: string) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return {
    endpoint,
    keys: {
      p256dh: b64url(raw),
      auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

describe("通知の条件", () => {
  test("読めない項目は既定値に戻す", () => {
    expect(normalizePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(
      normalizePrefs({
        eew: "loud",
        quakeMinInt: "8",
        area: { code: "x", name: "a" },
        tsunami: "major",
        advisory: false,
      }),
    ).toEqual({ ...DEFAULT_PREFS, tsunami: "major", advisory: false });
    expect(
      normalizePrefs({ area: { code: "340", name: "千葉県北西部" } }).area,
    ).toEqual({ code: "340", name: "千葉県北西部" });
  });

  test("既定は 警報だけ・最大震度 4 以上・津波注意報以上・南海トラフ等はオン", () => {
    expect(DEFAULT_PREFS).toEqual({
      eew: "warning",
      quakeMinInt: "4",
      area: null,
      areaMinInt: "3",
      tsunami: "watch",
      advisory: true,
      volcano: "warning",
    });
  });
});

describe("何を知らせるか", () => {
  test("最大震度が閾値に届けば通知し、届かなければ現在地の震度で見る", () => {
    const n3 = noticeOf(
      quake({
        maxInt: "3",
        areas: [{ code: "350", name: "東京都２３区", int: "3" }],
      }),
      NOW,
    );
    if (!n3) throw new Error("通知が無い");
    expect(matches(n3, prefs())).toBe(false);
    expect(
      matches(n3, prefs({ area: { code: "350", name: "東京都２３区" } })),
    ).toBe(true);
    expect(
      matches(
        n3,
        prefs({ area: { code: "350", name: "東京都２３区" }, areaMinInt: "4" }),
      ),
    ).toBe(false);
    // P2P の震度速報には地域のコードが無い。名前で見る
    const p2p = noticeOf(
      quake({ maxInt: "3", areas: [{ name: "東京都２３区", int: "3" }] }),
      NOW,
    );
    expect(
      p2p &&
        matches(p2p, prefs({ area: { code: "350", name: "東京都２３区" } })),
    ).toBe(true);

    const n4 = noticeOf(quake(), NOW);
    expect(n4 && matches(n4, prefs())).toBe(true);
    expect(n4?.title).toBe("最大震度4 千葉県北西部");
    expect(n4?.url).toBe("/?q=20261114090000");
    expect(n4 && matches(n4, prefs({ quakeMinInt: "off" }))).toBe(false);
  });

  test("訓練・試験・遠地地震・古いものは知らせない", () => {
    expect(noticeOf(quake({ status: "training" }), NOW)).toBeNull();
    expect(noticeOf(quake({ foreign: true }), NOW)).toBeNull();
    // 起動したときに長期フィードで埋めた昔の地震
    expect(
      noticeOf(quake({ originTime: "2026-11-13T09:05:00+09:00" }), NOW),
    ).toBeNull();
    // 緊急地震速報は 3 分で古い
    expect(noticeOf(eew({ issuedAt: "2026-11-14T00:06:00Z" }), NOW)).toBeNull();
  });

  test("緊急地震速報は既定で警報だけ。予想震度は書かない", () => {
    const f = noticeOf(eew(), NOW);
    expect(f && matches(f, prefs())).toBe(false);
    expect(f && matches(f, prefs({ eew: "all" }))).toBe(true);
    const w = noticeOf(
      eew({
        kind: "warning",
        serial: 3,
        warnAreas: ["茨城県南部", "千葉県北西部"],
      }),
      NOW,
    );
    expect(w && matches(w, prefs())).toBe(true);
    expect(w?.title).toContain("強い揺れに警戒");
    expect(w?.body).toContain("茨城県南部・千葉県北西部");
    expect(w?.body).not.toMatch(/震度/);
    expect(w?.urgency).toBe("high");
    expect(w?.ttl).toBe(120);
    expect(w?.sticky).toBe(true);
  });

  test("津波は一番重い区分で決め、解除は前に知らせた購読にだけ置き換えに行く", () => {
    const t = noticeOf(tsunami(), NOW);
    if (!t) throw new Error("通知が無い");
    expect(t.title).toBe("津波注意報");
    expect(t.body).toBe("岩手県");
    expect(matches(t, prefs())).toBe(true);
    expect(matches(t, prefs({ tsunami: "warning" }))).toBe(false);

    const ended = noticeOf(tsunami({ ended: true }), NOW);
    if (!ended) throw new Error("通知が無い");
    expect(ended.closing).toBe(true);
    expect(plan(ended, prefs(), undefined)).toEqual({ send: false });
    expect(
      plan(ended, prefs(), { level: t.level, digest: digestOf(t) }),
    ).toEqual({ send: true, renotify: false });
  });
});

describe("同じ事象で何度も鳴らさない", () => {
  test("初めては鳴らし、同じ中身は送らず、重さが上がれば鳴らし直し、ほかは黙って置き換える", () => {
    const first = noticeOf(quake(), NOW);
    if (!first) throw new Error("通知が無い");
    expect(plan(first, prefs(), undefined)).toEqual({
      send: true,
      renotify: true,
    });
    const sent = { level: first.level, digest: digestOf(first) };
    expect(plan(first, prefs(), sent)).toEqual({ send: false });

    const detail = noticeOf(quake({ magnitude: 5.3 }), NOW);
    if (!detail) throw new Error("通知が無い");
    expect(detail.tag).toBe(first.tag);
    expect(plan(detail, prefs(), sent)).toEqual({
      send: true,
      renotify: false,
    });

    const stronger = noticeOf(quake({ maxInt: "5-" }), NOW);
    if (!stronger) throw new Error("通知が無い");
    expect(plan(stronger, prefs(), sent)).toEqual({
      send: true,
      renotify: true,
    });
  });
});

describe("VAPID の鍵", () => {
  test("無ければ機能を切る (エラーにしない)", () => {
    expect(vapidFromEnv({})).toEqual({ vapid: null });
  });

  test("秘密鍵の JWK から公開鍵を作る", async () => {
    const jwk = await testJwk();
    const { vapid } = vapidFromEnv({
      VAPID_PRIVATE_JWK: jwk,
      PUBLIC_URL: "https://s.example/",
    });
    expect(vapid?.subject).toBe("https://s.example");
    const pub = Buffer.from(vapid?.publicKey ?? "", "base64url");
    expect(pub.length).toBe(65);
    expect(pub[0]).toBe(4);
  });

  test("読めない鍵・連絡先が無いときは、理由を付けて切る", async () => {
    expect(
      vapidFromEnv({ VAPID_PRIVATE_JWK: "{", PUBLIC_URL: "https://s.example" })
        .problem,
    ).toContain("JSON");
    expect(
      vapidFromEnv({
        VAPID_PRIVATE_JWK: '{"kty":"RSA"}',
        PUBLIC_URL: "https://s.example",
      }).problem,
    ).toContain("P-256");
    expect(
      vapidFromEnv({ VAPID_PRIVATE_JWK: await testJwk() }).problem,
    ).toContain("VAPID_SUBJECT");
    expect(
      vapidFromEnv({
        VAPID_PRIVATE_JWK: await testJwk(),
        VAPID_SUBJECT: "mailto:a@example.com",
      }).vapid,
    ).not.toBeNull();
  });
});

describe("購読の受け付け", () => {
  test("主な配信サービスの https だけ受ける", async () => {
    const ok = await testSubscription(
      "https://fcm.googleapis.com/fcm/send/abc",
    );
    expect(parseSubscription(ok)?.endpoint).toBe(ok.endpoint);
    expect(
      parseSubscription({ ...ok, endpoint: "https://web.push.apple.com/x" }),
    ).not.toBeNull();
    expect(
      parseSubscription({ ...ok, endpoint: "http://fcm.googleapis.com/x" }),
    ).toBeNull();
    expect(
      parseSubscription({ ...ok, endpoint: "https://evil.example/x" }),
    ).toBeNull();
    expect(
      parseSubscription({
        ...ok,
        endpoint: "https://fcm.googleapis.com.evil.example/x",
      }),
    ).toBeNull();
    expect(
      parseSubscription({ ...ok, endpoint: "https://10.0.0.1/x" }),
    ).toBeNull();
    expect(
      parseSubscription({ ...ok, keys: { ...ok.keys, auth: "AAAA" } }),
    ).toBeNull();
    expect(parseSubscription(null)).toBeNull();
  });
});

describe("Service Worker に渡す形", () => {
  test("外の URL は開かせず、読めない中身でも何か出す", () => {
    expect(
      toNotification({ title: "t", url: "https://evil.example/" }).options.data
        .url,
    ).toBe("/");
    expect(toNotification({ url: "//evil.example/" }).options.data.url).toBe(
      "/",
    );
    expect(
      toNotification({ url: "/quakes/1", renotify: true, sticky: true })
        .options,
    ).toMatchObject({
      data: { url: "/quakes/1" },
      renotify: true,
      requireInteraction: true,
    });
    expect(toNotification(null).title).toBe("sonae");
  });
});

describe("送り手", () => {
  async function setup(status: (url: string) => number) {
    const db = openDb(":memory:");
    const { vapid } = vapidFromEnv({
      VAPID_PRIVATE_JWK: await testJwk(),
      PUBLIC_URL: "https://s.example",
    });
    if (!vapid) throw new Error("鍵が無い");
    const calls: { url: string; headers: Headers }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: new Headers(init?.headers) });
      return new Response(null, { status: status(url) });
    }) as unknown as typeof fetch;
    const pusher = new Pusher(db, vapid, { fetch: fakeFetch, now: () => NOW });
    return { db, pusher, calls };
  }

  test("条件に合う購読にだけ送り、続報は控えで鳴らし直さない", async () => {
    const { pusher, calls } = await setup(() => 201);
    const a = parseSubscription(
      await testSubscription("https://fcm.googleapis.com/fcm/send/a"),
    );
    const b = parseSubscription(
      await testSubscription(
        "https://updates.push.services.mozilla.com/wpush/v2/b",
      ),
    );
    if (!a || !b) throw new Error("購読が読めない");
    pusher.save("me", a, prefs(), "Chrome");
    pusher.save("me", b, prefs({ quakeMinInt: "5+" }), "Firefox");

    expect(await pusher.handle(quake())).toEqual(["ok"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(a.endpoint);
    const h = calls[0]?.headers;
    expect(h?.get("ttl")).toBe("3600");
    expect(h?.get("urgency")).toBe("normal");
    expect(h?.get("topic")).toMatch(/^[0-9a-f]{32}$/);
    expect(h?.get("content-encoding")).toBe("aes128gcm");
    expect(h?.get("authorization")).toStartWith("vapid t=");

    // 同じ中身の続報は送らない
    expect(await pusher.handle(quake())).toEqual([]);
    // 震度 5 強に上がったら、両方に送る (a は鳴らし直し、b は初めて)
    expect(await pusher.handle(quake({ maxInt: "5+" }))).toEqual(["ok", "ok"]);
  });

  test("410・404 が返った購読は消す。ほかの失敗は控えを消して次に送り直す", async () => {
    const { db, pusher } = await setup((url) =>
      url.endsWith("/gone") ? 410 : url.endsWith("/missing") ? 404 : 500,
    );
    for (const tail of ["gone", "missing", "flaky"]) {
      const s = parseSubscription(
        await testSubscription(`https://fcm.googleapis.com/fcm/send/${tail}`),
      );
      if (!s) throw new Error("購読が読めない");
      pusher.save("me", s, prefs(), tail);
    }
    expect((await pusher.handle(quake())).sort()).toEqual([
      "error",
      "gone",
      "gone",
    ]);
    expect(pusher.list("me").map((s) => s.label)).toEqual(["flaky"]);
    expect(db.query("SELECT COUNT(*) AS n FROM push_log").get()).toEqual({
      n: 0,
    });
  });

  test("登録は 1 人 20 まで。解除は自分のものだけ", async () => {
    const { pusher } = await setup(() => 201);
    const s = await testSubscription("https://fcm.googleapis.com/fcm/send/0");
    for (let i = 0; i < 20; i++) {
      const sub = parseSubscription({
        ...s,
        endpoint: `https://fcm.googleapis.com/fcm/send/${i}`,
      });
      if (!sub) throw new Error("購読が読めない");
      expect(pusher.save("me", sub, prefs(), "")).toBe("ok");
    }
    const extra = parseSubscription({
      ...s,
      endpoint: "https://fcm.googleapis.com/fcm/send/x",
    });
    if (!extra) throw new Error("購読が読めない");
    expect(pusher.save("me", extra, prefs(), "")).toBe("full");
    expect(pusher.remove("you", "https://fcm.googleapis.com/fcm/send/0")).toBe(
      false,
    );
    expect(pusher.remove("me", "https://fcm.googleapis.com/fcm/send/0")).toBe(
      true,
    );
  });
});

/** RFC 8291 の受け手 (ブラウザ) の側の復号。送った本文が仕様どおりかを確かめる */
async function decrypt(
  body: Uint8Array<ArrayBuffer>,
  ua: CryptoKeyPair,
  auth: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const salt = body.slice(0, 16);
  expect(view.getUint32(16)).toBe(4096);
  const idlen = body[20] ?? 0;
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const uaPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", ua.publicKey),
  );
  const asKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const secret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: asKey },
    ua.privateKey,
    256,
  );
  const hkdf = async (
    salt: Uint8Array<ArrayBuffer>,
    ikm: ArrayBuffer,
    info: Uint8Array<ArrayBuffer>,
    bytes: number,
  ) =>
    crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
      bytes * 8,
    );
  const enc = new TextEncoder();
  const keyInfo = new Uint8Array([
    ...enc.encode("WebPush: info\0"),
    ...uaPublic,
    ...asPublic,
  ]);
  const ikm = await hkdf(auth, secret, keyInfo, 32);
  const cek = await hkdf(
    salt,
    ikm,
    enc.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    enc.encode("Content-Encoding: nonce\0"),
    12,
  );
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]),
      ciphertext,
    ),
  );
  // 最後の記録は 0x02 で区切り、後ろは 0 で埋まる
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  expect(plain[end]).toBe(2);
  return new TextDecoder().decode(plain.slice(0, end));
}

test("送った本文は RFC 8291 (aes128gcm) でブラウザが復号できる", async () => {
  const { vapid } = vapidFromEnv({
    VAPID_PRIVATE_JWK: await testJwk(),
    PUBLIC_URL: "https://s.example",
  });
  if (!vapid) throw new Error("鍵が無い");
  const ua = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = parseSubscription({
    endpoint: "https://fcm.googleapis.com/fcm/send/r",
    keys: {
      p256dh: b64url(await crypto.subtle.exportKey("raw", ua.publicKey)),
      auth: b64url(auth),
    },
  });
  if (!sub) throw new Error("購読が読めない");
  let sent: { headers: Headers; body: Uint8Array<ArrayBuffer> } | undefined;
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    sent = {
      headers: new Headers(init?.headers),
      body: new Uint8Array(init?.body as Uint8Array),
    };
    return new Response(null, { status: 201 });
  }) as unknown as typeof fetch;
  const pusher = new Pusher(openDb(":memory:"), vapid, { fetch: fakeFetch });
  const payload = {
    title: "最大震度4 千葉県北西部",
    body: "11/14 09:05 頃 M5.1",
    tag: "quake:1",
    url: "/quakes/1",
    renotify: true,
    sticky: false,
    timestamp: NOW,
  };
  expect(await pusher.send(sub, payload, { ttl: 60, urgency: "high" })).toBe(
    "ok",
  );
  if (!sent) throw new Error("送っていない");
  expect(sent.headers.get("content-encoding")).toBe("aes128gcm");
  expect(sent.headers.get("authorization")).toEndWith(`k=${vapid.publicKey}`);
  expect(JSON.parse(await decrypt(sent.body, ua, auth))).toEqual(payload);
});

test("緊急地震速報は報ごとに M が変わっても送り直さず、警報の地域が増えたら置き換える", () => {
  const p = prefs({ eew: "all" });
  const first = noticeOf(eew(), NOW);
  if (!first) throw new Error("通知が無い");
  const sent = { level: first.level, digest: digestOf(first) };
  const next = noticeOf(eew({ serial: 2, magnitude: 5.2 }), NOW);
  if (!next) throw new Error("通知が無い");
  expect(plan(next, p, sent)).toEqual({ send: false });

  const warn = noticeOf(
    eew({ serial: 3, kind: "warning", warnAreas: ["茨城県南部"] }),
    NOW,
  );
  if (!warn) throw new Error("通知が無い");
  expect(plan(warn, p, sent)).toEqual({ send: true, renotify: true });
  const warned = { level: warn.level, digest: digestOf(warn) };
  const more = noticeOf(
    eew({
      serial: 4,
      kind: "warning",
      warnAreas: ["茨城県南部", "千葉県北西部"],
    }),
    NOW,
  );
  if (!more) throw new Error("通知が無い");
  expect(plan(more, p, warned)).toEqual({ send: true, renotify: false });

  const cancel = noticeOf(eew({ serial: 5, cancelled: true }), NOW);
  if (!cancel) throw new Error("通知が無い");
  expect(plan(cancel, p, warned)).toEqual({ send: true, renotify: false });
});

test("前に届いた事象の続報が送れなかったら、控えを送る前に戻す (次の続報で鳴らし直さない)。持ち主が替わったら控えを捨てる", async () => {
  const db = openDb(":memory:");
  const { vapid } = vapidFromEnv({
    VAPID_PRIVATE_JWK: await testJwk(),
    PUBLIC_URL: "https://s.example",
  });
  if (!vapid) throw new Error("鍵が無い");
  let status = 201;
  const fakeFetch = (async () =>
    new Response(null, { status })) as unknown as typeof fetch;
  const pusher = new Pusher(db, vapid, { fetch: fakeFetch, now: () => NOW });
  const sub = parseSubscription(
    await testSubscription("https://fcm.googleapis.com/fcm/send/z"),
  );
  if (!sub) throw new Error("購読が読めない");
  pusher.save("me", sub, prefs(), "");
  const log = () =>
    db.query("SELECT level, digest FROM push_log").all() as {
      level: number;
      digest: string;
    }[];

  expect(await pusher.handle(quake())).toEqual(["ok"]);
  const before = log();
  expect(before).toHaveLength(1);

  status = 500;
  expect(await pusher.handle(quake({ magnitude: 5.4 }))).toEqual(["error"]);
  expect(log()).toEqual(before);

  // 転送 (3xx) は追わず、失敗として扱う
  status = 307;
  expect(await pusher.handle(quake({ magnitude: 5.5 }))).toEqual(["error"]);

  pusher.save("you", sub, prefs(), "");
  expect(log()).toEqual([]);
});

describe("震源が決まる前の通知の文言", () => {
  test("気象庁の震度速報 (VXSE51): 見出しは最大震度と最初の地域「など」、本文は検知の時刻 (分まで) と「頃」", () => {
    const file = "32-35_01_01_100806_VXSE51.xml";
    const body = fixture(`jma/${file}`);
    const { store } = memoryStore("2009-08-10T20:09:00Z");
    const [e] = store.ingest({
      source: "jma",
      key: file,
      code: codeOf(file),
      body,
      items: parseJmaXml(body, codeOf(file)),
    });
    if (!e) throw new Error("イベントが無い");
    const n = noticeOf(e, Date.parse("2009-08-10T20:10:00Z"));
    expect(n && { title: n.title, body: n.body, level: n.level }).toEqual({
      title: "最大震度6弱 静岡県中部 など",
      body: "8/11 05:07 頃",
      level: 7,
    });
  });

  test("震源も M も時刻も無いときは、本文を「震度速報」にする", () => {
    const n = noticeOf(
      quake({
        hypocenter: undefined,
        magnitude: undefined,
        originTime: undefined,
        reports: [
          {
            kind: "scale",
            source: "p2p",
            infoType: "発表",
            reportedAt: "2026-11-14T00:06:30Z",
            targetTime: "2026-11-14T00:05:00Z",
            areas: [],
            stations: [],
            comments: [],
          },
        ],
      }),
      NOW,
    );
    expect(n && { title: n.title, body: n.body }).toEqual({
      title: "最大震度4 千葉県北西部 など",
      body: "震度速報",
    });
  });

  test("震源が決まった続報は、同じ tag で鳴らさずに置き換える (見出しは震源の名前)", () => {
    const p = prefs();
    const first = noticeOf(
      quake({
        hypocenter: undefined,
        magnitude: undefined,
        originTime: undefined,
      }),
      NOW,
    );
    if (!first) throw new Error("通知が無い");
    const sent = { level: first.level, digest: digestOf(first) };
    const next = noticeOf(quake(), NOW);
    if (!next) throw new Error("通知が無い");
    expect(next.tag).toBe(first.tag);
    expect(next.title).toBe("最大震度4 千葉県北西部");
    expect(next.body).toBe("11/14 09:05 頃 M5.1");
    expect(plan(next, p, sent)).toEqual({ send: true, renotify: false });
  });
});

describe("送れなかったことと続報が重なるとき", () => {
  /** 返事を後から決められる fetch。呼ばれた順に resolve を持つ */
  function heldFetch() {
    const waiting: ((status: number) => void)[] = [];
    const fetch = ((_url: string) =>
      new Promise<Response>((resolve) => {
        waiting.push((status) => resolve(new Response(null, { status })));
      })) as unknown as typeof globalThis.fetch;
    const called = async (n: number) => {
      for (let i = 0; i < 200 && waiting.length < n; i++) await Bun.sleep(5);
      if (waiting.length < n) throw new Error(`fetch が ${n} 回呼ばれていない`);
    };
    return { fetch, waiting, called };
  }

  async function setup() {
    const db = openDb(":memory:");
    const { vapid } = vapidFromEnv({
      VAPID_PRIVATE_JWK: await testJwk(),
      PUBLIC_URL: "https://s.example",
    });
    if (!vapid) throw new Error("鍵が無い");
    const held = heldFetch();
    const pusher = new Pusher(db, vapid, { fetch: held.fetch, now: () => NOW });
    const sub = parseSubscription(
      await testSubscription("https://fcm.googleapis.com/fcm/send/held"),
    );
    if (!sub) throw new Error("購読が読めない");
    pusher.save("me", sub, prefs(), "");
    const log = () =>
      db.query("SELECT level, digest FROM push_log").all() as Sent[];
    return { pusher, held, log };
  }

  const digestOfEvent = (e: SonaeEvent) => {
    const n = noticeOf(e, NOW);
    if (!n) throw new Error("通知が無い");
    return { level: n.level, digest: digestOf(n) };
  };

  test("初めての通知を送っている間に続報が来て、初めての通知が失敗しても、続報の控えを消さない", async () => {
    const { pusher, held, log } = await setup();
    const first = pusher.handle(quake());
    await held.called(1);
    // 重さが上がった続報は、初めての通知が届く前でも鳴らし直す
    const next = pusher.handle(quake({ maxInt: "5-" }));
    await held.called(2);
    held.waiting[0]?.(500);
    held.waiting[1]?.(201);
    expect(await first).toEqual(["error"]);
    expect(await next).toEqual(["ok"]);
    expect(log()).toEqual([digestOfEvent(quake({ maxInt: "5-" }))]);
    // 同じ中身はもう送らない
    expect(await pusher.handle(quake({ maxInt: "5-" }))).toEqual([]);
  });

  test("続報を送っている間に次の続報が来て、前の続報が失敗しても、控えを前に戻さない", async () => {
    const { pusher, held, log } = await setup();
    const first = pusher.handle(quake());
    await held.called(1);
    held.waiting[0]?.(201);
    expect(await first).toEqual(["ok"]);

    const update1 = pusher.handle(quake({ magnitude: 5.3 }));
    await held.called(2);
    const update2 = pusher.handle(quake({ magnitude: 5.4 }));
    await held.called(3);
    held.waiting[1]?.(500);
    held.waiting[2]?.(201);
    expect(await update1).toEqual(["error"]);
    expect(await update2).toEqual(["ok"]);
    expect(log()).toEqual([digestOfEvent(quake({ magnitude: 5.4 }))]);
  });

  test("初めての通知も続報も失敗したら、控えを消して次の続報を初めてとして鳴らす", async () => {
    const { pusher, held, log } = await setup();
    const first = pusher.handle(quake());
    await held.called(1);
    const next = pusher.handle(quake({ magnitude: 5.3 }));
    await held.called(2);
    // 続報が先に失敗すると控えを初めての通知のものに戻し、初めての通知が失敗するとそれも消す
    held.waiting[1]?.(500);
    expect(await next).toEqual(["error"]);
    held.waiting[0]?.(500);
    expect(await first).toEqual(["error"]);
    expect(log()).toEqual([]);
    // どれも届いていないので、次の続報は初めてとして送る
    const again = pusher.handle(quake({ magnitude: 5.4 }));
    await held.called(3);
    held.waiting[2]?.(201);
    expect(await again).toEqual(["ok"]);
    expect(log()).toEqual([digestOfEvent(quake({ magnitude: 5.4 }))]);
  });
});

test("試しの通知の回数の制限: 窓の中で max 回まで、超えたら待つ秒数を返す。人ごとに数える", () => {
  let t = 0;
  const limit = new RateLimit(2, 60_000, () => t);
  expect(limit.take("me")).toBe(0);
  t = 10_000;
  expect(limit.take("me")).toBe(0);
  t = 20_000;
  expect(limit.take("me")).toBe(40);
  expect(limit.take("you")).toBe(0);
  t = 60_000;
  expect(limit.take("me")).toBe(0);
});
