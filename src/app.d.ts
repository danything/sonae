/// <reference types="vite/client" />
// `~icons/*` (unplugin-icons。vite.config.ts) は Svelte の部品として読む
import "unplugin-icons/types/svelte";

declare global {
  namespace App {
    interface Locals {
      /** ロールを持ってログインした人。hooks.server.ts が入れる */
      user?: { subject: string; name: string };
    }
  }
}

export {};
