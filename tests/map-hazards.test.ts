import { expect, test } from "bun:test";

import {
  baseStyle,
  HAZARD_CHOICES,
  HAZARD_GROUPS,
  hazardChoice,
  hazardCovers,
  hazardFamily,
  HAZARDS,
  hazardVisibility,
  JSHIS_AMP_LAYER,
  JSHIS_PSHM_LAYER,
  mergeShelters,
  overlayVisibility,
  readHazard,
  SHELTER_LAYERS,
  wmsTiles,
} from "#lib/map/style.ts";
import { CREDITS, mapCredit } from "#lib/notice.ts";

const hazard = (id: string) => {
  const h = HAZARDS.find((x) => x.id === id);
  if (!h) throw new Error(`${id} が無い`);
  return h;
};

test("ハザードマップ: 高潮・内水・浸水継続時間・家屋倒壊等を、オープンデータの URL とズームで読む", () => {
  const url = (layer: string) =>
    `https://disaportaldata.gsi.go.jp/raster/${layer}/{z}/{x}/{y}.png`;
  expect(hazard("hightide").layers.map((l) => l.tiles)).toEqual([
    url("03_hightide_l2_shinsuishin_data"),
  ]);
  expect(hazard("naisui").layers.map((l) => l.tiles)).toEqual([
    url("02_naisui_data"),
  ]);
  expect(hazard("flood-duration").layers.map((l) => l.tiles)).toEqual([
    url("01_flood_l2_keizoku_data"),
  ]);
  expect(hazard("flood-collapse").layers.map((l) => l.tiles)).toEqual([
    url("01_flood_l2_kaokutoukai_hanran_data"),
    url("01_flood_l2_kaokutoukai_kagan_data"),
  ]);
  // オープンデータの一覧のズーム (家屋倒壊等は 4〜17、ほかは 2〜17)
  expect([hazard("hightide").minzoom, hazard("hightide").maxzoom]).toEqual([
    2, 17,
  ]);
  expect([
    hazard("flood-collapse").minzoom,
    hazard("flood-collapse").maxzoom,
  ]).toEqual([4, 17]);
  // 公式の凡例の画像。家屋倒壊等は字の無い画像なので名前を添える
  expect(hazard("naisui").legends[0]?.src).toEndWith("/naisui_legend.png");
  expect(hazard("flood-duration").legends[0]?.src).toEndWith(
    "/shinsui_legend_l2_keizoku.png",
  );
  expect(hazard("flood-collapse").legends.map((l) => l.name)).toEqual([
    "氾濫流",
    "河岸侵食",
  ]);
  // ハザードマップポータルサイトの図は、どれも「色が無くても安全とは限りません」と出典を出す
  for (const h of HAZARDS.filter((x) => x.group === "water")) {
    expect(h.caveat).toContain("色が無くても安全とは限りません");
    expect(h.source?.text).toBe("ハザードマップポータルサイト");
    expect(h.credit).toBe("ハザードマップポータルサイト");
  }
});

test("ハザードマップ: 浸水継続時間と家屋倒壊等は選択肢に並べず、洪水の凡例の上で切り替える", () => {
  expect(HAZARD_CHOICES.map((h) => h.id)).toEqual([
    "flood",
    "naisui",
    "hightide",
    "tsunami",
    "landslide",
    "faults",
    "quake-prob",
    "ground-amp",
  ]);
  expect(HAZARD_GROUPS.map((g) => g.id)).toEqual(["water", "quake"]);
  // 見出しごとの並び: 水害・土砂災害が 5 つ、地震の備えが 3 つ
  expect(HAZARD_CHOICES.filter((h) => h.group === "water").length).toBe(5);
  expect(HAZARD_CHOICES.filter((h) => h.group === "quake").length).toBe(3);
  expect(hazardFamily("flood-duration").map((h) => h.id)).toEqual([
    "flood",
    "flood-duration",
    "flood-collapse",
  ]);
  expect(hazardFamily("flood").map((h) => h.variant)).toEqual([
    "浸水の深さ",
    "浸水が続く時間",
    "家屋倒壊等",
  ]);
  expect(hazardFamily("tsunami")).toEqual([]);
  expect(hazardFamily("none")).toEqual([]);
  expect(hazardChoice("flood-collapse")).toBe("flood");
  expect(hazardChoice("tsunami")).toBe("tsunami");
  expect(hazardChoice("rain")).toBe("rain");
  // 端末に保存した選択は、凡例の上で切り替えた図もそのまま読む
  for (const id of ["flood-duration", "flood-collapse", "naisui", "hightide"])
    expect(readHazard(id)).toBe(id as never);
  // 選んでいるのが何の図か、ボタンに名前を残す (いま洪水が起きているように読めないように)
  expect(hazard("flood-duration").pill).toBe("ハザードマップ: 浸水が続く時間");
  expect(hazard("hightide").pill).toBe("ハザードマップ: 高潮");
  // 家屋倒壊等は 2 つの層を一緒に出す
  expect(
    Object.entries(hazardVisibility("flood-collapse"))
      .filter(([, on]) => on)
      .map(([id]) => id),
  ).toEqual([
    "hazard-01_flood_l2_kaokutoukai_hanran_data",
    "hazard-01_flood_l2_kaokutoukai_kagan_data",
  ]);
});

test("J-SHIS: 確率論的地震動予測地図と表層地盤を WMS の bbox で読み、選んだときだけ出す", () => {
  expect(JSHIS_PSHM_LAYER).toBe("P-Y2024-MAP-AVR-TTL_MTTL-T30_I55_PD");
  expect(JSHIS_AMP_LAYER).toBe("Z-V4-JAPAN-AMP-VS400_M250-IDARV2");
  const prob = hazard("quake-prob");
  const tiles = prob.layers[0]?.tiles ?? "";
  expect(tiles).toStartWith(
    "https://www.j-shis.bosai.go.jp/map/wms/pshm/Y2024?",
  );
  const q = new URL(tiles.replace("{bbox-epsg-3857}", "0,0,1,1")).searchParams;
  expect(q.get("REQUEST")).toBe("GetMap");
  expect(q.get("CRS")).toBe("EPSG:3857");
  expect(q.get("LAYERS")).toBe(JSHIS_PSHM_LAYER);
  expect(q.get("TRANSPARENT")).toBe("TRUE");
  expect(tiles).toContain("BBOX={bbox-epsg-3857}");
  expect(hazard("ground-amp").layers[0]?.tiles).toBe(
    wmsTiles(
      "https://www.j-shis.bosai.go.jp/map/wms/sstrct/V4",
      JSHIS_AMP_LAYER,
    ),
  );
  // 凡例は J-SHIS の GetLegendGraphic
  expect(prob.legends[0]?.src).toContain("REQUEST=GetLegendGraphic");
  // 出典: 隅の短い出典と、凡例の下
  expect(prob.credit).toBe("J-SHIS (防災科研)");
  expect(mapCredit({ hazard: prob.credit, grus: false })).toBe(
    "出典: 国土地理院・気象庁・J-SHIS (防災科研) ほか",
  );
  expect(prob.source?.href).toBe("https://www.j-shis.bosai.go.jp/");
  expect(
    CREDITS.find((c) => c.label === "地震の揺れの確率・地盤の揺れやすさ"),
  ).toBeDefined();
  // 陸の全面を塗る図なので、選んでいる間は面で塗る色を隠す
  expect(hazardCovers("quake-prob", 5)).toBe(true);
  expect(overlayVisibility("ground-amp", 8)["warning-fill"]).toBe(false);
  const style = baseStyle("", "quake-prob") as {
    sources: Record<string, { tiles?: string[] }>;
    layers: { id: string; layout?: { visibility?: string } }[];
  };
  expect(style.sources["hazard-jshis-pshm"]?.tiles).toEqual([tiles]);
  // J-SHIS への負荷を抑える: 512px の 1 枚で読み、ズーム 11 より寄せたら読み足さずに引き伸ばす
  expect(q.get("WIDTH")).toBe("512");
  expect(q.get("HEIGHT")).toBe("512");
  const src = (style.sources as Record<string, Record<string, unknown>>)[
    "hazard-jshis-pshm"
  ];
  expect(src?.tileSize).toBe(512);
  expect(src?.maxzoom).toBe(11);
  // 重ねる層はズーム 11 より寄せても出す (層に maxzoom を付けない)
  expect(hazard("quake-prob").maxzoom).toBe(14);
  expect(hazardCovers("quake-prob", 13)).toBe(true);
  // ほかのハザードマップは 256px のまま
  const flood = (style.sources as Record<string, Record<string, unknown>>)[
    "hazard-01_flood_l2_shinsuishin_data"
  ];
  expect(flood?.tileSize).toBe(256);
  expect(flood?.maxzoom).toBe(17);
  expect(
    style.layers.find((l) => l.id === "hazard-jshis-pshm")?.layout?.visibility,
  ).toBe("visible");
  expect(
    style.layers.find((l) => l.id === "hazard-jshis-amp")?.layout?.visibility,
  ).toBe("none");
});

test("避難場所: 福祉避難所 (sfh) を読み、受け入れる人を添える。同じ施設は 1 つにまとめる", () => {
  expect(SHELTER_LAYERS).toContain("sfh");
  const f = (name: string, props: Record<string, unknown> = {}) => ({
    geometry: { coordinates: [139.6, 35.7] },
    properties: { name, address: "東京都練馬区", ...props },
  });
  const merged = mergeShelters([
    { layer: "sih", features: [f("C小")] },
    {
      layer: "sfh",
      features: [
        f("C小", { accept: " 要配慮者 " }),
        f("Dホーム", { accept: "", necessary_matters: "" }),
      ],
    },
    { layer: "skhb04", features: [f("C小", { disaster4: 1 })] },
  ]);
  expect(merged.map((m) => m.properties)).toEqual([
    {
      name: "C小",
      address: "東京都練馬区",
      disasters: [4],
      shelter: true,
      welfare: true,
      accept: "要配慮者",
    },
    {
      name: "Dホーム",
      address: "東京都練馬区",
      disasters: [],
      shelter: false,
      welfare: true,
      accept: "",
    },
  ]);
});
