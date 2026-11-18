/**
 * 端末に覚えさせる好み (テーマ・一覧に出す種類・ハザードマップ・現在地のオン・オフ・開いているときの知らせ)。localStorage は、サイトのデータを止めた Safari や
 * プライベートの窓で投げることがあるので、読めなければ既定のまま、書けなければ覚えないだけにする。
 */

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(`sonae.${key}`);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(`sonae.${key}`, value);
  } catch {
    // 覚えられないだけ
  }
}

export function removePref(key: string): void {
  try {
    localStorage.removeItem(`sonae.${key}`);
  } catch {
    // 消せないだけ (読む所はもう無い)
  }
}

export type ThemeMode = "dark" | "light" | "system";

/**
 * テーマを選んで当てる (app.html の描く前のスクリプトと同じ決め方と付ける所)。既定は端末に合わせる。
 * 端末の設定が変わったときの付け直しは app.html が `data-theme-mode` を見てする
 */
export function applyTheme(mode: ThemeMode): void {
  const dark =
    mode === "dark" ||
    (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themeMode = mode;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#0b0c0f" : "#ffffff");
  const manifest = document.querySelector('link[rel="manifest"]');
  const href = manifest?.getAttribute("href");
  if (manifest && href) manifest.setAttribute("href", manifestHref(href, dark));
  writePref("theme", mode);
}

/** テーマの地の色のマニフェスト (暗いのは `manifest.webmanifest`、明るいのは `manifest-light.webmanifest`) */
export function manifestHref(href: string, dark: boolean): string {
  return href.replace(
    /manifest(-light)?\.webmanifest$/,
    dark ? "manifest.webmanifest" : "manifest-light.webmanifest",
  );
}
