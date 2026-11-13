/// <reference types="vite/client" />

declare global {
  namespace App {
    interface Locals {
      /** ロールを持ってログインした人。hooks.server.ts が入れる */
      user?: { subject: string; name: string };
    }
  }
}

export {};
