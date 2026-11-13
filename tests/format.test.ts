import { expect, test } from "bun:test";

import { jstTime, magnitudeText, quakeName } from "#lib/format.ts";
import { type Tsunami, tsunamiTop } from "#lib/model.ts";

test("地震の名前: 震源が無ければ最初の地域で「など」、地域も無ければ調査中", () => {
  const h = { name: "島根県西部", lat: 35.2, lon: 132.6 };
  expect(quakeName({ hypocenter: h, areas: [] })).toBe("島根県西部");
  expect(quakeName({ areas: [{ name: "熊本県熊本地方", int: "3" }] })).toBe(
    "熊本県熊本地方 など",
  );
  expect(quakeName({ areas: [] })).toBe("震源は調査中");
});

test("一覧の時刻と M の書き方", () => {
  expect(jstTime("2026-11-13T15:03:45Z")).toBe("00:03");
  expect(jstTime(undefined)).toBe("—");
  expect(magnitudeText({ magnitude: 3.5 })).toBe("M3.5");
  expect(magnitudeText({ magnitudeText: "Ｍ不明" })).toBe("Ｍ不明");
});

test("津波のいちばん強い区分 (解除・なしだけなら none)", () => {
  const t = (...grades: Tsunami["areas"][number]["grade"][]) => ({
    areas: grades.map((grade) => ({ name: "", kindName: "", grade })),
  });
  expect(tsunamiTop(t("watch", "warning", "none"))).toBe("warning");
  expect(tsunamiTop(t("none"))).toBe("none");
});
