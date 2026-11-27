/**
 * **ソフトウェアで描いている端末を見分けて、`<html data-lite>` を付ける** (docs/design.md の 6.3。denpa の `lite.ts` と同じ形)。
 *
 * GPU が無い・ハードウェアアクセラレーションを切った端末では、地図を描き直すたびに CPU を使う。`data-lite` の間は、
 * 時間で動き続けるもの (雨雲 (いま→予測) の自動の再生。docs/map.md) を初めから止めておく。
 *
 * 見分けは 1 回だけ。小さな WebGL の箱を作ってレンダラの名前を読み、すぐ捨てる。
 * 名前を読めるのは Chrome・Edge だけで、Firefox は丸めた名前、Safari は「Apple GPU」しか出さない。
 * 見分けられないときは付けない (動かす側に倒す)
 */

/** ソフトウェアのレンダラの名前。新しい名前が分かったら足す */
const SOFTWARE = [
  "swiftshader",
  "llvmpipe",
  "softpipe",
  "microsoft basic render driver",
];

/**
 * WebGL のレンダラの名前がソフトウェアのものか。null は WebGL を作れなかった (ソフトウェアとみなす)。
 * 名前を読めて形が分からない「見分けられない」とは別で、WebGL が無い端末は GPU で描けないので止める側に倒す
 * (denpa と同じ。止まっても ▶ で替えられる)
 */
export function isSoftwareRenderer(name: string | null): boolean {
  if (name === null) return true;
  const lower = name.toLowerCase();
  return SOFTWARE.some((soft) => lower.includes(soft));
}

/** レンダラの名前を読む。WebGL を作れなければ null */
function rendererName(): string | null {
  const gl = document.createElement("canvas").getContext("webgl");
  if (gl === null) return null;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = String(
    gl.getParameter(info === null ? gl.RENDERER : info.UNMASKED_RENDERER_WEBGL),
  );
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return name;
}

let lite: boolean | undefined;

/** ソフトウェアで描いている端末か。初めて呼んだときに見分けて `<html>` に印を付け、あとは覚えた答えを返す */
export function isLite(): boolean {
  if (lite !== undefined) return lite;
  try {
    lite = isSoftwareRenderer(rendererName());
  } catch {
    // 箱を作るところで投げる端末は、見分けられない側 (動かす) に倒す
    lite = false;
  }
  if (lite) document.documentElement.dataset["lite"] = "";
  return lite;
}
