import { expect, test } from "bun:test";

import { NOTICE } from "#lib/notice.ts";

test("注意文は非公式であることと、公式の情報を優先することを言う", () => {
  expect(NOTICE).toContain("公式のものではありません");
  expect(NOTICE).toContain("優先してください");
});
