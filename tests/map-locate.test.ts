import { expect, test } from "bun:test";

import { autoLocate, readLocate } from "#lib/map/locate.ts";

test("オフを選んでいなければ、許可があるときは自動で始める (既定はオン)", () => {
  expect(autoLocate("on", "granted")).toBe("start");
  expect(autoLocate(null, "granted")).toBe("start");
});

test("まだ選んでいない端末は、許可をまだ聞いていなければ聞く (断られたらオフを保存する)", () => {
  expect(autoLocate(null, "prompt")).toBe("ask");
  expect(autoLocate(null, "unknown")).toBe("ask");
});

test("人がオンにした端末で許可をまだ聞いていない・query が無いときは始めず、オンは保存したまま", () => {
  expect(autoLocate("on", "prompt")).toBe("wait");
  expect(autoLocate("on", "unknown")).toBe("wait");
});

test("拒まれていたらオフを保存する (聞き直さない)", () => {
  expect(autoLocate("on", "denied")).toBe("forget");
  expect(autoLocate(null, "denied")).toBe("forget");
});

test("オフを選んであれば、許可があっても何もしない", () => {
  for (const p of ["granted", "prompt", "denied", "unknown"] as const)
    expect(autoLocate("off", p)).toBe("none");
});

test("保存した値は on と off だけを読み、ほかはまだ選んでいない", () => {
  expect(readLocate("on")).toBe("on");
  expect(readLocate("off")).toBe("off");
  expect(readLocate(null)).toBeNull();
  expect(readLocate("true")).toBeNull();
  expect(readLocate("")).toBeNull();
});
