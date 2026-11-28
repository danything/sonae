import { expect, test } from "bun:test";

import {
  CAMERA_REFRESH_MS,
  CAMERA_STALE_MS,
  cameraFoot,
  cameraHead,
  cameraPage,
  type CameraPoint,
  frameAlt,
  frameCaption,
  latestFrame,
} from "#lib/map/cameras.ts";
import { baseStyle, CAMERA_MINZOOM, MAP_LEGEND } from "#lib/map/style.ts";
import { CREDITS, creditText } from "#lib/notice.ts";

const table = (await Bun.file(
  "static/cameras/volcano-cameras.json",
).json()) as {
  type: string;
  features: {
    properties: CameraPoint;
    geometry: { type: string; coordinates: [number, number] };
  }[];
};
const volcanoes = (await Bun.file(
  "static/areas/volcano-points.json",
).json()) as Record<string, [number, number, string?]>;

// 気象庁のカメラのページの抜き書き (2026-11-28、箱根山 宮城野)
const PAGE = `<script>
var file_array = new Array();
file_array[0]="../camera/315_820081B0/20261128121001.jpg";
file_array[1]="../camera/315_820081B0/20261128120801.jpg";
</script>`;

test("ページからいちばん新しい画像を拾う", () => {
  expect(latestFrame(PAGE)).toEqual({
    url: "https://www.data.jma.go.jp/vois/data/obs/camera/315_820081B0/20261128121001.jpg",
    takenAt: "2026-11-28T12:10:01+09:00",
  });
});

test("決まった形に合わない名前は拾わない (気象庁の画像の置き場の外を読まない)", () => {
  expect(latestFrame("")).toBeUndefined();
  expect(
    latestFrame(`file_array[0]="../camera/../../x/20261128121001.jpg"`),
  ).toBeUndefined();
  expect(
    latestFrame(`file_array[0]="https://example.com/a.jpg"`),
  ).toBeUndefined();
  expect(
    latestFrame(`file_array[0]="../camera/315_820081B0/2026112812.jpg"`),
  ).toBeUndefined();
  expect(
    latestFrame(`file_array[0]="../camera/315_ZZ0081B0/20261128121001.jpg"`),
  ).toBeUndefined();
  // 1 枚目が無く 2 枚目だけのときも拾わない (いちばん新しいとは限らない)
  expect(
    latestFrame(`file_array[1]="../camera/315_820081B0/20261128120801.jpg"`),
  ).toBeUndefined();
  // ありえない日付
  expect(
    latestFrame(`file_array[0]="../camera/315_820081B0/20261399121001.jpg"`),
  ).toBeUndefined();
});

test("カメラのページは 5 桁の番号のときだけ", () => {
  expect(cameraPage("31501")).toBe(
    "https://www.data.jma.go.jp/vois/data/obs/volcam/volcam.php?VC=31501",
  );
  expect(cameraPage("315")).toBeUndefined();
  expect(cameraPage("31501&x=1")).toBeUndefined();
});

test("画像の時刻: 古ければ止まっているかもしれないと書く", () => {
  const frame = latestFrame(PAGE);
  if (!frame) throw new Error("拾えない");
  const at = Date.parse(frame.takenAt);
  expect(frameCaption(frame, at + 5 * 60_000)).toBe("11/28 12:10 の画像");
  expect(frameCaption(frame, at + CAMERA_STALE_MS + 1)).toContain(
    "それより後の画像がありません",
  );
  const p = { vc: "31501", volcano: "箱根山", camera: "宮城野" };
  expect(frameAlt(p, frame)).toBe(
    "箱根山 宮城野 の監視カメラの画像 (11/28 12:10)",
  );
});

test("吹き出し: 名前・種類と、気象庁のページ・注意書き・出典", () => {
  const p = { vc: "31501", volcano: "箱根山", camera: "宮城野" };
  expect(cameraHead(p).map((l) => l.text)).toEqual([
    "箱根山 宮城野",
    "火山の監視カメラ (気象庁)",
  ]);
  const foot = cameraFoot(p);
  expect(foot[0]?.href).toBe(cameraPage("31501"));
  const text = foot.map((l) => l.text).join("\n");
  expect(text).toContain("噴火警報");
  expect(text).toContain("出典：気象庁ホームページ");
  // 安全・危険の判断を書かない
  expect(text).not.toMatch(/安全です|危険です/);
});

test("読み直しの間は、ページの配信の古さ (10 分) より短くしない", () => {
  expect(CAMERA_REFRESH_MS).toBeGreaterThanOrEqual(10 * 60_000);
});

test("カメラの表: 番号・名前・位置がそろい、火山のコードが活火山の一覧にある", () => {
  expect(table.type).toBe("FeatureCollection");
  expect(table.features.length).toBeGreaterThanOrEqual(80);
  const seen = new Set<string>();
  for (const f of table.features) {
    const { vc, volcano, camera } = f.properties;
    expect(vc).toMatch(/^\d{5}$/);
    expect(seen.has(vc)).toBe(false);
    seen.add(vc);
    expect(volcano.length).toBeGreaterThan(0);
    expect(camera.length).toBeGreaterThan(0);
    // 気象庁の名前に混ざる HTML (ルビ) は外してある
    expect(`${volcano}${camera}`).not.toMatch(/[<>]/);
    expect(volcanoes[vc.slice(0, 3)]?.[2]).toBe(volcano);
    expect(f.geometry.type).toBe("Point");
    const [lon, lat] = f.geometry.coordinates;
    expect(lon).toBeGreaterThan(122);
    expect(lon).toBeLessThan(154);
    expect(lat).toBeGreaterThan(24);
    expect(lat).toBeLessThan(46);
    // 火山から 30 km より離れたカメラは無い (位置の取り違えを見つける)
    const v = volcanoes[vc.slice(0, 3)];
    if (v) {
      const dx = (lon - v[0]) * 111 * Math.cos((lat * Math.PI) / 180);
      const dy = (lat - v[1]) * 111;
      expect(Math.hypot(dx, dy)).toBeLessThan(30);
    }
  }
});

test("地図: カメラの層はズーム 7 から、出典つきの source。凡例と出典の窓にも書く", () => {
  const style = baseStyle("https://example.test", undefined) as {
    sources: Record<string, { attribution?: string }>;
    layers: { id: string; minzoom?: number; source?: string }[];
  };
  expect(style.sources.cameras?.attribution).toContain("気象庁ホームページ");
  const layer = style.layers.find((l) => l.id === "cameras");
  expect(layer?.source).toBe("cameras");
  expect(layer?.minzoom).toBe(CAMERA_MINZOOM);
  // 海しるの点の上、観測点ごとの震度の丸の下
  const ids = style.layers.map((l) => l.id);
  expect(ids.indexOf("cameras")).toBeGreaterThan(ids.indexOf("marine"));
  expect(ids.indexOf("cameras")).toBeLessThan(
    ids.indexOf("intensity-stations"),
  );
  expect(MAP_LEGEND.some((l) => l.label === "火山の監視カメラ")).toBe(true);
  const credit = CREDITS.find((c) => c.label === "火山の監視カメラ");
  expect(credit && creditText(credit)).toContain("保存も配布もしません");
});
