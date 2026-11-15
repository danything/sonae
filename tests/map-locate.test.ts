import { expect, test } from "bun:test";

import { autoLocate, readLocate } from "#lib/map/locate.ts";

test("オンを覚えていて許可があるときだけ自動で始める", () => {
  expect(autoLocate(true, "granted")).toBe("start");
});

test("許可をまだ聞いていない・query が無いときは始めず、オンは覚えたまま", () => {
  expect(autoLocate(true, "prompt")).toBe("wait");
  expect(autoLocate(true, "unknown")).toBe("wait");
});

test("拒まれていたら覚えたオンを消す", () => {
  expect(autoLocate(true, "denied")).toBe("forget");
});

test("オンを覚えていなければ、許可があっても何もしない", () => {
  for (const p of ["granted", "prompt", "denied", "unknown"] as const)
    expect(autoLocate(false, p)).toBe("none");
});

test("覚えた値は on だけをオンと読む", () => {
  expect(readLocate("on")).toBe(true);
  expect(readLocate(null)).toBe(false);
  expect(readLocate("true")).toBe(false);
  expect(readLocate("")).toBe(false);
});
