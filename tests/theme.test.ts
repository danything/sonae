import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { manifestHref } from "#lib/prefs.ts";

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("テーマの既定は端末に合わせる", () => {
  const html = read("src/app.html");

  test("<html> に決めたテーマを書かない (描く前のスクリプトが付ける)", () => {
    expect(html).toMatch(/<html lang="ja">/);
    expect(html).not.toMatch(/<html[^>]*data-theme=/);
  });

  test("保存が無ければ端末に合わせる", () => {
    expect(html).toContain(
      'saved === "light" || saved === "dark" ? saved : "system"',
    );
    expect(html).toContain("prefers-color-scheme: dark");
  });
});

describe("マニフェストの地の色", () => {
  const dark = JSON.parse(read("static/manifest.webmanifest"));
  const light = JSON.parse(read("static/manifest-light.webmanifest"));

  test("暗いのは暗いテーマの地、明るいのは白", () => {
    expect(dark.background_color).toBe("#0b0c0f");
    expect(dark.theme_color).toBe("#0b0c0f");
    expect(light.background_color).toBe("#ffffff");
    expect(light.theme_color).toBe("#ffffff");
  });

  test("色のほかは同じ", () => {
    const strip = (m: Record<string, unknown>) => ({
      ...m,
      background_color: null,
      theme_color: null,
    });
    expect(strip(light)).toEqual(strip(dark));
  });

  test("app.html の描く前のスクリプトも同じ置き換えをする", () => {
    const html = read("src/app.html");
    expect(html).toContain("/manifest(-light)?\\.webmanifest$/");
    expect(html).toContain(
      'dark ? "manifest.webmanifest" : "manifest-light.webmanifest"',
    );
  });

  test("テーマで読むマニフェストを替える (行き来しても崩れない)", () => {
    const l = manifestHref("/manifest.webmanifest", false);
    expect(l).toBe("/manifest-light.webmanifest");
    expect(manifestHref(l, false)).toBe("/manifest-light.webmanifest");
    expect(manifestHref(l, true)).toBe("/manifest.webmanifest");
    expect(manifestHref("./manifest.webmanifest", false)).toBe(
      "./manifest-light.webmanifest",
    );
  });
});
