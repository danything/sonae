import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { Cities } from "#lib/home.ts";
import type { OfficeTable } from "#lib/map/style.ts";
import {
  cityBounds,
  gsiSearchUrl,
  localPlaces,
  mergePlaces,
  normalize,
  parseGsi,
  type Place,
  shouldQuery,
} from "#lib/places.ts";

const cities = JSON.parse(
  readFileSync("static/areas/cities.json", "utf8"),
) as Cities;
const bounds = cityBounds(
  JSON.parse(readFileSync("static/areas/offices.json", "utf8")) as OfficeTable,
);

test("比べる形: 全角・半角と空白、ヶとケをそろえる", () => {
  expect(normalize("千代田 区")).toBe("千代田区");
  expect(normalize("ＡＢＣ１")).toBe("abc1");
  expect(normalize("霞ヶ浦")).toBe(normalize("霞ケ浦"));
});

test("外へ問い合わせるのは 2 文字から", () => {
  expect(shouldQuery("札")).toBe(false);
  expect(shouldQuery(" 札 ")).toBe(false);
  expect(shouldQuery("札幌")).toBe(true);
});

test("手元の市町村: 名前が同じ・先頭が同じ・どこかに入るの順で、外枠の真ん中へ", () => {
  const r = localPlaces("府中", cities, bounds);
  // 府中市は東京都と広島県にある (府中町も)
  expect(r.length).toBeGreaterThanOrEqual(2);
  expect(r.every((p) => p.kind === "city" && p.label.includes("府中"))).toBe(
    true,
  );
  const chiyoda = localPlaces("千代田区", cities, bounds)[0];
  expect(chiyoda?.label).toBe("東京都千代田区");
  expect(chiyoda?.bounds).toBeDefined();
  const [w, s, e, n] = chiyoda?.bounds ?? [0, 0, 0, 0];
  expect(chiyoda?.at).toEqual([(w + e) / 2, (s + n) / 2]);
  // 府県の名前からでも
  expect(localPlaces("北海道札幌", cities, bounds)[0]?.label).toContain(
    "北海道札幌市",
  );
  // 名前がそのまま同じものが先
  const exact = localPlaces("札幌市", cities, bounds);
  expect(exact[0]?.label).toBe("北海道札幌市");
  expect(localPlaces("", cities, bounds)).toEqual([]);
  expect(localPlaces("存在しない町の名前", cities, bounds)).toEqual([]);
  expect(localPlaces("区", cities, bounds, 3)).toHaveLength(3);
});

test("手元の市町村: 2 つに分けた市町村は、説明の文ではなく府県と名前で出す", () => {
  const sendai = localPlaces("仙台市東部", cities, bounds)[0];
  expect(sendai?.label).toBe("宮城県仙台市東部");
  expect(localPlaces("仙台市", cities, bounds).map((p) => p.label)).toContain(
    "宮城県仙台市西部",
  );
  // 決まり文句の説明の字では当たらない
  expect(localPlaces("気象庁予報警報規程", cities, bounds)).toEqual([]);
  // 区を並べた説明の市町村は、区の名前で探せる (名前は府県と市町村等の名前)
  expect(localPlaces("鶴見区", cities, bounds).map((p) => p.label)).toContain(
    "神奈川県横浜市北部",
  );
});

test("国土地理院の住所検索の応答を候補にする。形の違うものは捨てる", () => {
  const r = parseGsi([
    {
      geometry: { coordinates: [139.750717, 35.672325], type: "Point" },
      type: "Feature",
      properties: { addressCode: "", title: "東京都千代田区霞が関一丁目３番" },
    },
    { geometry: { coordinates: ["x", 1] }, properties: { title: "壊れた" } },
    { geometry: { coordinates: [1, 2] }, properties: {} },
    null,
  ]);
  expect(r).toEqual([
    {
      id: "gsi:東京都千代田区霞が関一丁目３番:139.750717,35.672325",
      kind: "address",
      label: "東京都千代田区霞が関一丁目３番",
      at: [139.750717, 35.672325],
    },
  ]);
  expect(parseGsi({ error: 1 })).toEqual([]);
});

test("並べ方: 手元の市町村が先、住所は後。市町村と同じ名前の住所と重複は捨てる", () => {
  const local = localPlaces("札幌市", cities, bounds);
  const remote: Place[] = [
    { id: "a", kind: "address", label: "北海道札幌市", at: [141.35, 43.06] },
    { id: "b", kind: "address", label: "札幌岳", at: [141.2, 42.9] },
    { id: "c", kind: "address", label: "札幌岳", at: [141.2, 42.9] },
  ];
  const r = mergePlaces(local, remote);
  expect(r[0]?.kind).toBe("city");
  expect(r.filter((p) => p.label === "北海道札幌市")).toHaveLength(1);
  expect(r.filter((p) => p.label === "札幌岳")).toHaveLength(1);
  expect(r.at(-1)?.label).toBe("札幌岳");
  expect(mergePlaces(local, remote, 1)).toHaveLength(1);
});

test("並べ方: 市町村が多く当たる語でも、住所・地名に 3 枠は残す", () => {
  const many = localPlaces("区", cities, bounds);
  expect(many).toHaveLength(8);
  const remote: Place[] = [1, 2, 3, 4].map((i) => ({
    id: `r${i}`,
    kind: "address",
    label: `住所${i}`,
    at: [139, 35],
  }));
  const r = mergePlaces(many, remote);
  expect(r).toHaveLength(8);
  expect(r.filter((p) => p.kind === "city")).toHaveLength(5);
  expect(r.filter((p) => p.kind === "address")).toHaveLength(3);
  // 住所が 1 つなら、市町村は 7 つ
  expect(
    mergePlaces(many, remote.slice(0, 1)).filter((p) => p.kind === "city"),
  ).toHaveLength(7);
  // 住所が無ければ、市町村だけで 8 つ
  expect(mergePlaces(many, [])).toHaveLength(8);
});

test("問い合わせの URL は打った文字だけ", () => {
  expect(gsiSearchUrl(" 霞が関1-3-1 ")).toBe(
    "/relay/gsi-search/AddressSearch?q=%E9%9C%9E%E3%81%8C%E9%96%A21-3-1",
  );
});
