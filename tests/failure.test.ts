import { expect, test } from "bun:test";

import { failureReason, failureText } from "#lib/failure.ts";
import { createQueue } from "#lib/prefs-queue.ts";

test("つながらない fetch の英語を出さず、決まった文にする", () => {
  // ブラウザごとに文は違うが、どれも TypeError
  for (const m of [
    "Failed to fetch",
    "NetworkError when attempting to fetch resource.",
    "Load failed",
  ]) {
    const t = failureText("送れませんでした", new TypeError(m));
    expect(t).toBe("送れませんでした (つながりません)");
    expect(t).not.toContain(m);
  }
});

test("応答を読めない・ブラウザの例外・自分で投げた文", () => {
  expect(failureReason(new SyntaxError("Unexpected token '<'"))).toBe(
    "応答を読めません",
  );
  expect(
    failureReason(new DOMException("Registration failed", "AbortError")),
  ).toBe("AbortError");
  expect(failureText("Webhook を読めませんでした", new Error("500"))).toBe(
    "Webhook を読めませんでした (500)",
  );
  expect(failureReason("x")).toBe("x");
});

test("条件を送る列も、つながらないときは決まった文", async () => {
  const q = createQueue();
  const r = await q.push(() =>
    Promise.reject(new TypeError("Failed to fetch")),
  );
  expect(r).toBe("保存できませんでした (つながりません)");
});
