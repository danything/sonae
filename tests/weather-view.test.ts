import { describe, expect, test } from "bun:test";

import { WARNING_COLORS } from "#lib/format.ts";
import { warningFill } from "#lib/map/style.ts";
import {
  cityLevels,
  isExpired,
  warningsByOffice,
  type WeatherWarning,
} from "#lib/model.ts";
import { parseWeatherXml } from "#lib/server/sources/jma-weather.ts";
import { readView, selectHref } from "#lib/view.ts";

import { fixture } from "./helpers.ts";

function warning(file: string, code: string): WeatherWarning {
  const [item] = parseWeatherXml(fixture(`jma/${file}`), code);
  if (item?.type !== "warning") throw new Error("警報・注意報ではありません");
  return { ...item.warning, updatedAt: "" };
}

const rain = warning("15_17_01_251222_VPWW55.xml", "VPWW55");
const sediment = warning("15_16_01_241031_VPWW56.xml", "VPWW56");
const wind = warning("15_16_04_251222_VPWW58.xml", "VPWW58");

describe("府県予報区ごとのまとめ", () => {
  test("段の高い府県予報区が先。種類は段の高い順で、対象の市町村等を持つ", () => {
    const offices = warningsByOffice([rain, wind, sediment]);
    expect(offices.map((o) => [o.office.name, o.top])).toEqual([
      ["宗谷地方", 4],
      ["島根県", 3],
    ]);
    const soya = offices[0];
    expect(soya?.kinds[0]?.name).toBe("レベル４土砂災害危険警報");
    expect(soya?.kinds.map((k) => k.level)).toEqual(
      [...(soya?.kinds.map((k) => k.level) ?? [])].sort((a, b) => b - a),
    );
    expect(soya?.headlines.map((h) => h.code)).toEqual(["VPWW56", "VPWW58"]);
    expect(soya?.kinds[0]?.areas[0]).toEqual({
      code: "0121400",
      name: "稚内市",
    });
  });

  test("訓練・試験と、出ているものが無い報は入れない", () => {
    expect(warningsByOffice([{ ...rain, status: "training" }])).toEqual([]);
    expect(warningsByOffice([{ ...rain, areas: [] }])).toEqual([]);
  });
});

describe("地図", () => {
  test("市町村等ごとにいちばん高い段で塗る", () => {
    const levels = cityLevels([sediment, wind]);
    expect(levels.get("0121400")).toBe(4);
    const expr = warningFill(levels) as unknown[];
    expect(expr[0]).toBe("match");
    expect(expr).toContain("0121400");
    expect(expr).toContain(WARNING_COLORS[4]?.bg);
  });
  test("何も出ていなければ透明", () => {
    expect(warningFill(new Map())).toBe("rgba(0,0,0,0)");
  });
});

describe("URL", () => {
  test("気象の一覧と、府県予報区・気象の報を選ぶ", () => {
    const empty = new URLSearchParams();
    const href = selectHref(empty, "weather", "office-320000");
    expect(href).toBe("/?w=office-320000");
    const v = readView(new URL(`https://x${href}`).searchParams);
    expect(v.selected).toEqual({ kind: "weather", id: "office-320000" });
  });
});

test("竜巻注意情報の有効期限", () => {
  const at = Date.parse("2015-07-17T10:00:00+09:00");
  expect(isExpired({ validUntil: "2015-07-17T10:30:00+09:00" }, at)).toBe(
    false,
  );
  expect(isExpired({ validUntil: "2015-07-17T09:30:00+09:00" }, at)).toBe(true);
  expect(isExpired({}, at)).toBe(false);
});
