/**
 * 気象庁の火山の監視カメラ (docs/map.md の「火山の監視カメラ」)。カメラの位置の表は `tools/cameras/build.sh` で
 * 気象庁ホームページの地図の GeoJSON から作った `static/cameras/volcano-cameras.json`。
 *
 * 印を押したときに、ブラウザがカメラのページを sonae のサーバーの中継 (`#lib/relay.ts`。docs/design.md の 2.14) から
 * 読んでいちばん新しい画像の名前を読み取り、その画像も中継から読んで吹き出しに出す。サーバーは期限 (10 分) の間だけ
 * 覚えて家の中の端末で使い回し、保存も配布もしない。ここは吹き出しの中身と、ページから画像の名前を読み取る所 (画面だけで使う)
 */

import type { PopupLine } from "#lib/map/marine.ts";
import { relayBase } from "#lib/relay.ts";

/** カメラの表 (GeoJSON)。画面が地図を読み終えたときに 1 度だけ読む */
export const CAMERAS_URL = "/cameras/volcano-cameras.json";

/** 気象庁ホームページの「監視カメラ画像」のページ。出典とリンクに使う */
export const VOLCAM_PAGE =
  "https://www.data.jma.go.jp/vois/data/obs/volcam/volcam.php";

/**
 * 中継の頭 (`https://www.data.jma.go.jp/vois/data/obs/` を読む)。画像の置き場は、ページの
 * `../camera/<火山>_<16 進 8 桁>/<撮った時刻>.jpg` をこの `camera/` に足したもの
 */
const VOLCAM_RELAY = relayBase("volcam");
const CAMERA_BASE = `${VOLCAM_RELAY}/camera/`;

/**
 * 吹き出しを開いている間に、カメラのページを読み直す間 (ミリ秒)。画像は 2〜3 分ごとに替わるが、ページには
 * `Cache-Control: max-age=600` が付き、気象庁の配信 (CloudFront) で最大 10 分古いので、それより短く読んでも
 * 新しい画像は来ない (2026-11-28 に確かめた)
 */
export const CAMERA_REFRESH_MS = 10 * 60_000;

/**
 * いちばん新しい画像がこれより古ければ、更新が止まっているかもしれないと書く (ミリ秒)。
 * 配信の遅れ (最大 10 分) と画像の間 (2〜3 分) を足しても、ふつうは 15 分に収まる
 */
export const CAMERA_STALE_MS = 30 * 60_000;

/** 気象庁がこれより小さい画像を返したら、画像が無いとみなす (無い名前にも 200 で 10×10 の画像を返す) */
export const CAMERA_MIN_WIDTH = 100;

/** 点の properties (`static/cameras/volcano-cameras.json`) */
export interface CameraPoint {
  /** カメラの 5 桁の番号 (先頭の 3 桁は火山のコード) */
  vc: string;
  /** 火山の名前 (「箱根山」) */
  volcano: string;
  /** カメラの名前 (「宮城野」) */
  camera: string;
}

/** カメラのページの URL (人が開くリンク)。番号が 5 桁の数でなければ undefined (表の外のものを読まない) */
export function cameraPage(vc: string): string | undefined {
  return /^\d{5}$/.test(vc) ? `${VOLCAM_PAGE}?VC=${vc}` : undefined;
}

/** カメラのページを、サーバーの中継から読む URL (画像の名前を読み取るため)。番号が 5 桁の数でなければ undefined */
export function cameraPageRelay(vc: string): string | undefined {
  return /^\d{5}$/.test(vc)
    ? `${VOLCAM_RELAY}/volcam/volcam.php?VC=${vc}`
    : undefined;
}

/** ページから読み取ったいちばん新しい画像 */
export interface CameraFrame {
  url: string;
  /** 撮った時刻 (ISO 8601、日本の時刻)。画像の名前 (`YYYYMMDDHHmmss.jpg`) から取る */
  takenAt: string;
}

/**
 * カメラのページの HTML から、いちばん新しい画像を読み取る。ページは画像の名前を新しい順に
 * `file_array[0]="../camera/315_820081B0/20261128121001.jpg"` の形で並べる (2026-11-28 に確かめた)。
 * 決まった形 (火山のコードの 3 桁・16 進 8 桁・14 桁の時刻) に合わなければ undefined。ページの中身で読む先が
 * 決まるので、気象庁の画像の置き場の外は読まない
 */
export function latestFrame(html: string): CameraFrame | undefined {
  const m =
    /file_array\[0\]\s*=\s*["']\.\.\/camera\/(\d{3}_[0-9A-Fa-f]{8})\/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.jpg["']/.exec(
      html,
    );
  if (!m) return undefined;
  const [, dir, y, mo, d, h, mi, s] = m;
  const takenAt = `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`;
  if (Number.isNaN(Date.parse(takenAt))) return undefined;
  return {
    url: `${CAMERA_BASE}${dir}/${y}${mo}${d}${h}${mi}${s}.jpg`,
    takenAt,
  };
}

const timeFmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** 「11/28 12:10 の画像」。古ければ、更新が止まっているかもしれないと足す */
export function frameCaption(frame: CameraFrame, now: number): string {
  const at = timeFmt.format(new Date(frame.takenAt));
  return now - Date.parse(frame.takenAt) > CAMERA_STALE_MS
    ? `${at} の画像 (それより後の画像がありません。点検などで止まっていることがあります)`
    : `${at} の画像`;
}

/** 画像の代わりの文 (alt)。何のカメラの、いつの画像か */
export const frameAlt = (p: CameraPoint, frame: CameraFrame) =>
  `${p.volcano} ${p.camera} の監視カメラの画像 (${timeFmt.format(new Date(frame.takenAt))})`;

/** 吹き出しの上の行 (名前と種類)。画像はこの下に画面が足す */
export function cameraHead(p: CameraPoint): PopupLine[] {
  return [
    { text: `${p.volcano} ${p.camera}`, cls: "bold" },
    { text: "火山の監視カメラ (気象庁)", cls: "small" },
  ];
}

/** 画像の下の行。気象庁のページへのリンク・火山の防災の注意・出典 */
export function cameraFoot(p: CameraPoint): PopupLine[] {
  const lines: PopupLine[] = [];
  const page = cameraPage(p.vc);
  if (page)
    lines.push({
      text: "気象庁の監視カメラのページ (前の画像も見られます)",
      cls: "small",
      href: page,
    });
  lines.push(
    {
      text: "火山の防災は、気象庁の噴火警報などの情報と、地元の自治体のお知らせや指示に従ってください。",
      cls: "small muted",
    },
    {
      text: "出典：気象庁ホームページ (監視カメラ画像)。画像は sonae のサーバーが気象庁から取って中継しています",
      cls: "tiny muted",
    },
  );
  return lines;
}

/** 画像を読めなかったときの文 */
export const CAMERA_FAILED =
  "画像を読めませんでした。気象庁のページで見てください。";
/** 画像が無いとき (点検などで止まっているカメラ) の文 */
export const CAMERA_EMPTY =
  "いまは画像がありません。点検などで止まっていることがあります。";

/** 印の地の色 */
const TILE_COLOR = "#2b2f36";

/**
 * 地図の印 (MapLibre の addImage に渡す。pixelRatio 2)。画面だけで呼ぶ。
 * 白い縁の暗い角丸の四角に、白いカメラの形。地理院地図Vector の記号 (白い地に黒) と、噴火警報・予報の火山の三角
 * (段の色) と、海しるの点 (ひし形・三角の輪郭) と見分けられるようにする。色は段や危険の意味を持たない暗い灰色
 */
export const cameraIcon = (): ImageData =>
  darkTileIcon((g) => {
    // 本体とレンズ
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.roundRect(7, 10, 14, 10, 2);
    g.fill();
    g.fillRect(11, 8, 6, 3);
    g.beginPath();
    g.arc(14, 15, 3, 0, Math.PI * 2);
    g.fillStyle = TILE_COLOR;
    g.fill();
  });

/**
 * 白い縁の暗い角丸の四角の印 (28 px 四方)。火山の監視カメラと YouTube のライブカメラで同じ地を使い、中の形
 * (`draw` が描く) で見分ける。画面だけで呼ぶ
 */
export function darkTileIcon(
  draw: (g: CanvasRenderingContext2D) => void,
): ImageData {
  const s = 28;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const g = c.getContext("2d");
  if (!g) return new ImageData(s, s);
  g.lineJoin = "round";
  g.beginPath();
  g.roundRect(3, 3, 22, 22, 5);
  g.fillStyle = TILE_COLOR;
  g.fill();
  g.strokeStyle = "#ffffff";
  g.lineWidth = 2.5;
  g.stroke();
  draw(g);
  return g.getImageData(0, 0, s, s);
}
