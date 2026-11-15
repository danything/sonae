import { expect, test } from "bun:test";

import { planHomeSave } from "#lib/home.ts";
import { DEFAULT_PREFS, normalizePrefs } from "#lib/push.ts";

const home = {
  code: "1310100",
  name: "東京都千代田区",
  quake: null,
  office: "130000",
  ichiji: null,
};
const local = normalizePrefs({ ...DEFAULT_PREFS, quakeMinInt: "5-" });
const server = normalizePrefs({ ...DEFAULT_PREFS, quakeMinInt: "3" });
const info = {
  enabled: true as const,
  publicKey: "key",
  subscriptions: [{ endpoint: "mine", prefs: server }],
};

test("地図から住んでいる地域を変える: 登録してあれば、サーバーの条件の home だけを替えて送る", () => {
  const a = planHomeSave({ info, endpoint: "mine" }, local, home);
  expect(a.publicKey).toBe("key");
  expect(a.prefs.quakeMinInt).toBe("3");
  expect(a.prefs.home?.code).toBe("1310100");
  expect(a.note).toBe("東京都千代田区を住んでいる地域にしました");
});

test("地図から住んでいる地域を変える: 登録が無ければ、端末の条件に足して送らない", () => {
  // ほかのブラウザの登録だけ
  const b = planHomeSave({ info, endpoint: "other" }, local, home);
  expect(b.publicKey).toBeNull();
  expect(b.prefs.quakeMinInt).toBe("5-");
  expect(b.prefs.home?.code).toBe("1310100");
  // Web Push を切ってある (鍵が無い)
  const c = planHomeSave(
    { info: { enabled: false }, endpoint: undefined },
    local,
    home,
  );
  expect(c.publicKey).toBeNull();
  expect(c.note).toBe("東京都千代田区を住んでいる地域にしました");
});

test("地図から住んでいる地域を変える: 登録を読めなければ、端末にだけ覚えてそう知らせる", () => {
  const d = planHomeSave(null, local, home);
  expect(d.publicKey).toBeNull();
  expect(d.prefs.home?.code).toBe("1310100");
  expect(d.note).toContain("このブラウザにだけ覚えました");
});
