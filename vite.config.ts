import adapter from "@sveltejs/adapter-bun";
import { sveltekit } from "@sveltejs/kit/vite";
import Icons from "unplugin-icons/vite";
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
  plugins: [
    sveltekit({ adapter: adapter() }),
    // アイコンは組むときに SVG ごと埋め込む (`~icons/lucide/map` が Svelte の部品になる。denpa と同じ)。
    // 形は @iconify-json/lucide (開発時だけの依存) から読み、束に入るのは使ったアイコンだけ
    Icons({ compiler: "svelte" }),
  ],
  build: {
    // MapLibre GL JS がひとかたまりで約 1.1MB (gzip で約 300KB)。画面を描いた後に読む
    // (QuakeMap.svelte の動的 import) ので、最初の表示と一覧は待たせない。それより大きいものは警告にする
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
