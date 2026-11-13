/**
 * 端末に覚えさせる好み (テーマ・地図の層)。localStorage は、サイトのデータを止めた Safari や
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

export type ThemeMode = "dark" | "light" | "system";

/** テーマを当てる (app.html の描く前のスクリプトと同じ決め方) */
export function applyTheme(mode: ThemeMode): void {
  const dark =
    mode === "dark" ||
    (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themeMode = mode;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#0b0c0f" : "#ffffff");
  writePref("theme", mode);
}
