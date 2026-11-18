import { describe, expect, test } from "bun:test";

import {
  renewFailedText,
  renewIfKeyChanged,
  sameKey,
} from "#lib/push-renew.ts";
import { base64UrlToBytes, DEFAULT_PREFS } from "#lib/push.ts";

const OLD_KEY =
  "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NEW_KEY =
  "BAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const OLD_ENDPOINT = "https://fcm.googleapis.com/fcm/send/old";
const NEW_ENDPOINT = "https://fcm.googleapis.com/fcm/send/new";

/** 前の鍵で作った購読 (消すと `unsubscribed` が立つ) */
function oldSub(key: string | null = OLD_KEY) {
  const s = {
    endpoint: OLD_ENDPOINT,
    options: {
      applicationServerKey: key === null ? null : base64UrlToBytes(key).buffer,
      userVisibleOnly: true,
    } as PushSubscriptionOptions,
    unsubscribed: false,
    unsubscribe: async () => {
      s.unsubscribed = true;
      return true;
    },
  };
  return s;
}

/** 作り直すときの pushManager・fetch の代わり。呼ばれたものを控える */
function fakes(
  opts: { status?: { DELETE?: number; PUT?: number }; endpoint?: string } = {},
) {
  const calls: { method: string; body: unknown }[] = [];
  const created: { key: Uint8Array; unsubscribed: boolean }[] = [];
  const pm = {
    subscribe: async (o?: PushSubscriptionOptionsInit) => {
      const c = {
        key: new Uint8Array(o?.applicationServerKey as ArrayBuffer),
        unsubscribed: false,
      };
      created.push(c);
      return {
        endpoint: opts.endpoint ?? NEW_ENDPOINT,
        toJSON: () => ({
          endpoint: opts.endpoint ?? NEW_ENDPOINT,
          keys: { p256dh: "p", auth: "a" },
        }),
        unsubscribe: async () => {
          c.unsubscribed = true;
          return true;
        },
      } as unknown as PushSubscription;
    },
  };
  const fetchFake = (async (_url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    calls.push({ method, body: JSON.parse(String(init.body)) });
    const status = opts.status?.[method as "DELETE" | "PUT"] ?? 200;
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { calls, created, deps: { pm, fetch: fetchFake, label: "UA" } };
}

describe("sameKey", () => {
  test("同じ鍵なら同じ、1 バイトでも違えば違う", () => {
    const want = base64UrlToBytes(OLD_KEY);
    expect(sameKey(base64UrlToBytes(OLD_KEY).buffer, want)).toBe(true);
    expect(sameKey(base64UrlToBytes(NEW_KEY).buffer, want)).toBe(false);
  });

  test("鍵を持たない購読は違うとみなす", () => {
    expect(sameKey(null, base64UrlToBytes(OLD_KEY))).toBe(false);
  });
});

describe("鍵を替えたときの購読の作り直し", () => {
  test("鍵が同じなら何もしない", async () => {
    const sub = oldSub();
    const f = fakes();
    expect(
      await renewIfKeyChanged(sub, OLD_KEY, DEFAULT_PREFS, f.deps),
    ).toEqual({
      kind: "same",
    });
    expect(sub.unsubscribed).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.created).toEqual([]);
  });

  test("鍵が違えば、前の購読を消し、サーバーの前の endpoint を消してから、新しい鍵で作り直して同じ条件で登録し直す", async () => {
    const sub = oldSub();
    const f = fakes();
    const prefs = { ...DEFAULT_PREFS, quake: "off" as const };
    expect(await renewIfKeyChanged(sub, NEW_KEY, prefs, f.deps)).toEqual({
      kind: "renewed",
      endpoint: NEW_ENDPOINT,
    });
    expect(sub.unsubscribed).toBe(true);
    expect(f.created.map((c) => [...c.key])).toEqual([
      [...base64UrlToBytes(NEW_KEY)],
    ]);
    expect(f.calls.map((c) => c.method)).toEqual(["DELETE", "PUT"]);
    expect(f.calls[0]?.body).toEqual({ endpoint: OLD_ENDPOINT });
    expect(f.calls[1]?.body).toMatchObject({
      subscription: { endpoint: NEW_ENDPOINT },
      prefs,
      label: "UA",
    });
  });

  test("鍵を持たない前の購読も作り直す", async () => {
    const f = fakes();
    const r = await renewIfKeyChanged(
      oldSub(null),
      NEW_KEY,
      DEFAULT_PREFS,
      f.deps,
    );
    expect(r.kind).toBe("renewed");
  });

  test("サーバーに前の endpoint が無ければ (ほかのブラウザから解除した)、消すだけで作り直さない", async () => {
    const sub = oldSub();
    const f = fakes();
    expect(await renewIfKeyChanged(sub, NEW_KEY, null, f.deps)).toEqual({
      kind: "dropped",
    });
    expect(sub.unsubscribed).toBe(true);
    expect(f.calls).toEqual([]);
    expect(f.created).toEqual([]);
  });

  test("サーバーが登録を断ったら、作り直した購読も消して、理由を返す", async () => {
    const f = fakes({ status: { PUT: 409 } });
    const r = await renewIfKeyChanged(oldSub(), NEW_KEY, DEFAULT_PREFS, f.deps);
    expect(r).toEqual({ kind: "failed", reason: "登録できませんでした (409)" });
    expect(f.created[0]?.unsubscribed).toBe(true);
    expect(renewFailedText("登録できませんでした (409)")).toBe(
      "サーバーの鍵が替わったため購読を作り直そうとしましたが、できませんでした (登録できませんでした (409))。「このブラウザで受ける」を押してください",
    );
  });

  test("サーバーの前の endpoint を消せなければ、作り直さない", async () => {
    const f = fakes({ status: { DELETE: 500 } });
    const r = await renewIfKeyChanged(oldSub(), NEW_KEY, DEFAULT_PREFS, f.deps);
    expect(r).toEqual({
      kind: "failed",
      reason: "前の購読を消せませんでした (500)",
    });
    expect(f.created).toEqual([]);
  });

  test("作り直した購読が届かない宛先なら、サーバーに送らずに消す", async () => {
    const f = fakes({
      endpoint: "https://permanently-removed.invalid/fcm/send/x",
    });
    const r = await renewIfKeyChanged(oldSub(), NEW_KEY, DEFAULT_PREFS, f.deps);
    expect(r.kind).toBe("blocked");
    expect(f.calls.map((c) => c.method)).toEqual(["DELETE"]);
    expect(f.created[0]?.unsubscribed).toBe(true);
  });
});
