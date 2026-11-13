import adapter from "@sveltejs/adapter-bun";
import { sveltekit } from "@sveltejs/kit/vite";
import { createLogger, defineConfig } from "vite";

/** ビルドの警告は放置しない: 出たら表示したうえで、ビルドの終了コードを失敗にする(開発サーバーでは何もしない) */
function strictLogger() {
  const logger = createLogger();
  const { warn, warnOnce } = logger;
  logger.warn = (msg, opts) => {
    warn(msg, opts);
    process.exitCode = 1;
  };
  logger.warnOnce = (msg, opts) => {
    warnOnce(msg, opts);
    process.exitCode = 1;
  };
  return logger;
}

export default defineConfig(({ command }) => ({
  customLogger: command === "build" ? strictLogger() : undefined,
  plugins: [sveltekit({ adapter: adapter() })],
  build: {
    // MapLibre GL JS がひとかたまりで約 1.1MB (gzip で約 300KB)。地図の画面を開いたときだけ読む
    // (QuakeMap.svelte の動的 import) ので、ほかの画面は重くならない。それより大きいものは警告にする
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      // プラグインにかかった時間の知らせ。警告ではなく目安なので出さない
      checks: { pluginTimings: false },
    },
  },
  // MapLibre の worker は ES モジュールとして作られる (new Worker(url, { type: "module" }))
  worker: { format: "es" },
  server: {
    host: true,
  },
}));
