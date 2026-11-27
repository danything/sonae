import { expect, test } from "bun:test";

import { EVAC_PORTALS, evacPortalFor } from "#lib/evac.ts";

test("避難情報: 住んでいる地域が神奈川県なら、県の災害情報ポータルへのリンクを出す", () => {
  // 厚木市
  const p = evacPortalFor("1421200");
  expect(p?.name).toBe("神奈川県 災害情報ポータル");
  expect(p?.href).toBe("https://www.bousai.pref.kanagawa.jp/");
});

test("避難情報: 表に無い都道府県・地域を選んでいないときは出さない", () => {
  // 千代田区
  expect(evacPortalFor("1310100")).toBeNull();
  expect(evacPortalFor(null)).toBeNull();
  expect(evacPortalFor(undefined)).toBeNull();
  expect(evacPortalFor("")).toBeNull();
});

test("避難情報: リンクは https の外のページだけ (sonae はページを読まない)", () => {
  for (const p of EVAC_PORTALS) expect(p.href).toStartWith("https://");
});
