import { describe, expect, test } from "bun:test";

import {
  endpointBlock,
  isAndroidEdge,
  permissionDeniedText,
  pushBlockOf,
  pushBlockText,
  registerFailedText,
} from "#lib/push-support.ts";
import { pushEndpointOk } from "#lib/push.ts";

const ALL = {
  serviceWorker: true,
  pushManager: true,
  notification: true,
  standalone: undefined,
};

const EDGE_ANDROID =
  "Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 EdgA/143.0.3650.97";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.3650.96";

test("機能がそろっていれば、登録してみるまで止めない", () => {
  expect(pushBlockOf(ALL)).toBeNull();
  // ホーム画面から開いた iPhone (standalone が true) も同じ
  expect(pushBlockOf({ ...ALL, standalone: true })).toBeNull();
});

test("無い機能を名前で並べる", () => {
  expect(pushBlockOf({ ...ALL, pushManager: false })).toEqual({
    kind: "missing",
    missing: ["Push API"],
  });
  expect(
    pushBlockOf({ ...ALL, serviceWorker: false, notification: false }),
  ).toEqual({
    kind: "missing",
    missing: ["Service Worker", "Notification API"],
  });
});

test("iPhone・iPad の Safari でホーム画面に追加せずに開いたときは、追加を案内する", () => {
  expect(
    pushBlockOf({
      ...ALL,
      pushManager: false,
      notification: false,
      standalone: false,
    }),
  ).toEqual({ kind: "ios" });
});

test("受け付ける配信サービスの https の宛先だけを届く宛先とみる", () => {
  expect(pushEndpointOk("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
  expect(
    pushEndpointOk("https://updates.push.services.mozilla.com/wpush/v2/x"),
  ).toBe(true);
  expect(pushEndpointOk("https://web.push.apple.com/QK")).toBe(true);
  expect(pushEndpointOk("https://wns2-par02p.notify.windows.com/w/?t=1")).toBe(
    true,
  );
  // Android の Edge が返す宛先
  expect(
    pushEndpointOk("https://permanently-removed.invalid/fcm/send/abc"),
  ).toBe(false);
  expect(pushEndpointOk("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
  expect(pushEndpointOk("https://fcm.googleapis.com:8443/fcm/send/abc")).toBe(
    false,
  );
  expect(pushEndpointOk("https://evil-fcm.googleapis.com.example/x")).toBe(
    false,
  );
  expect(pushEndpointOk("not a url")).toBe(false);
});

test("届かない宛先は、その宛先の名前と一緒に止める", () => {
  expect(endpointBlock("https://fcm.googleapis.com/fcm/send/abc")).toBeNull();
  expect(
    endpointBlock("https://permanently-removed.invalid/fcm/send/abc"),
  ).toEqual({ kind: "endpoint", host: "permanently-removed.invalid" });
  expect(endpointBlock("")).toEqual({ kind: "endpoint", host: "宛先なし" });
});

test("Android の Edge は UA の EdgA で見分ける (パソコンの Edge・Chrome は違う)", () => {
  expect(isAndroidEdge(EDGE_ANDROID)).toBe(true);
  expect(isAndroidEdge(CHROME_ANDROID)).toBe(false);
  expect(isAndroidEdge(EDGE_WINDOWS)).toBe(false);
});

test("文は、何ができないかと代わりの道を言う", () => {
  const edge = pushBlockText(
    { kind: "endpoint", host: "permanently-removed.invalid" },
    EDGE_ANDROID,
  );
  expect(edge).toContain("このブラウザ (Android の Edge)");
  expect(edge).toContain("permanently-removed.invalid");
  expect(edge).toContain("Web Push は使えません");
  expect(edge).toContain("Android の Chrome");
  expect(edge).toContain("「開いているとき」");

  const missing = pushBlockText(
    { kind: "missing", missing: ["Push API"] },
    CHROME_ANDROID,
  );
  expect(missing).toStartWith("このブラウザは Web Push に対応していません");
  expect(missing).toContain("Push API がありません");
  expect(missing).not.toContain("Edge)");
  expect(missing).toContain("「開いているとき」");

  const ios = pushBlockText({ kind: "ios" }, "");
  expect(ios).toContain("ホーム画面に追加");
  expect(ios).toContain("「開いているとき」");
});

test("登録が例外で止まったときも、訳と代わりの道を言う", () => {
  const err = new Error("Registration failed - push service error");
  err.name = "AbortError";
  const t = registerFailedText(err);
  expect(t).toStartWith(
    "登録できませんでした (AbortError: Registration failed - push service error)",
  );
  expect(t).toContain("「開いているとき」");
  expect(registerFailedText("x")).toStartWith("登録できませんでした (x)");
});

test("登録でサーバーにつながらないときは、ブラウザの英語を出さない", () => {
  const t = registerFailedText(new TypeError("Failed to fetch"));
  expect(t).toStartWith(
    "登録できませんでした (つながりません)。つながってから、もう一度押してください。",
  );
  expect(t).not.toContain("Failed to fetch");
  // ほかのブラウザに替えても変わらないので、勧めない
  expect(t).not.toContain("ほかのブラウザ");
});

describe("通知の許可が無いときの文", () => {
  const EDGE_DESKTOP =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.3650.97";

  test("Android の Edge は、通知に対応していないことと Chrome を言う (設定の道筋は出さない)", () => {
    for (const t of [
      permissionDeniedText(EDGE_ANDROID, { asked: true, quiet: true }),
      permissionDeniedText(EDGE_ANDROID),
    ]) {
      expect(t).toStartWith(
        "Android の Edge は、サイトの通知に対応していません",
      );
      expect(t).toContain("Android の Chrome");
      expect(t).not.toContain("サイトのアクセス許可");
    }
  });

  test("窓を出さずに断られたら、そう書く", () => {
    const t = permissionDeniedText(EDGE_DESKTOP, { asked: true, quiet: true });
    expect(t).toContain("許可の窓を出さずに");
  });

  test("聞いて断られたとき・前から断っているときは、許可されていないとだけ書く", () => {
    expect(
      permissionDeniedText(EDGE_DESKTOP, { asked: true, quiet: false }),
    ).toStartWith("通知が許可されていません。");
    expect(permissionDeniedText(EDGE_DESKTOP)).toStartWith(
      "通知が許可されていません。",
    );
  });

  test("Edge (PC) は静かな通知の要求に触れ、ほかのブラウザは鍵の印の道筋", () => {
    expect(permissionDeniedText(EDGE_DESKTOP)).toContain(
      "通知の要求を静かにする",
    );
    expect(permissionDeniedText("Mozilla/5.0 Firefox/140.0")).toContain(
      "鍵の印",
    );
  });
});
