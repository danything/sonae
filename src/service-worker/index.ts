/**
 * Service Worker (docs/design.md の 2.4)。Web Push を受けて通知を出し、押されたらその事象の画面を開く。
 * 画面やデータの控え (オフライン) はしない (古い地震情報を出さないため)。fetch も横取りしない。
 * SvelteKit が自動で登録する (/service-worker.js)。
 */

/// <reference types="@sveltejs/kit" />

import { isShown, quiet, toNotification } from "#lib/push.ts";

const sw = self as unknown as ServiceWorkerGlobalScope;

// 新しいバージョンはすぐ入れ替える (控えを持たないので、待つ理由が無い)
sw.addEventListener("install", () => {
  void sw.skipWaiting();
});
sw.addEventListener("activate", (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener("push", (event) => {
  let raw: unknown;
  try {
    raw = event.data?.json();
  } catch {
    raw = undefined;
  }
  const n = toNotification(raw);
  event.waitUntil(
    (async () => {
      // 開いている画面が同じ事象の同じ中身をもう出していたら、鳴らさずに置き換える (2 度鳴らさない)。
      // 出すこと自体はやめない (iOS は Web Push で通知を出さないと購読を止める)
      const shown = await sw.registration
        .getNotifications({ tag: n.options.tag })
        .catch(() => []);
      const out = isShown(n, shown) ? quiet(n) : n;
      // renotify は DOM の型に無いが、Chrome などは読む (同じ tag の置き換えで鳴らし直す)
      await sw.registration.showNotification(
        out.title,
        out.options as NotificationOptions,
      );
    })(),
  );
});

sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: unknown } | null;
  const path = typeof data?.url === "string" ? data.url : "/";
  const url = new URL(path, sw.location.origin).href;
  event.waitUntil(
    (async () => {
      // 開いている sonae の画面があれば、それをその事象の画面にして前に出す
      const wins = await sw.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const w of wins) {
        if (new URL(w.url).origin !== sw.location.origin) continue;
        const moved = (await w.navigate(url).catch(() => null)) ?? w;
        await moved.focus();
        return;
      }
      await sw.clients.openWindow(url);
    })(),
  );
});
