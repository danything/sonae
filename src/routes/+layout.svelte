<script lang="ts">
  import { browser } from "$app/env";
  import { invalidateAll } from "$app/navigation";
  import { page } from "$app/state";

  import EewBanner from "#lib/components/EewBanner.svelte";
  import { activeEews } from "#lib/eew.ts";
  import { live } from "#lib/live.svelte.ts";
  import { CREDITS, NOTICE } from "#lib/notice.ts";
  import { applyTheme, type ThemeMode } from "#lib/prefs.ts";
  import "../app.css";

  let { children, data } = $props();

  // load の中身を入れ、SSE の差分で更新する。帯はブラウザでだけ出す (時刻で下ろすので)
  $effect.pre(() => {
    live.seed(data.snapshot);
  });
  // 埋め直しが多すぎると SSE が resync を送ってくる。load を走らせ直して一覧を取り直す
  $effect(() => live.connect(() => void invalidateAll()));

  const eews = $derived(browser ? activeEews(live.eews, live.now) : []);
  const down = $derived(
    live.statuses.filter((s) => s.state !== "connected").map((s) => s.id),
  );

  const NAV = [
    { href: "/", label: "地震" },
    { href: "/map", label: "地図" },
    { href: "/tsunami", label: "津波" },
    { href: "/eew", label: "緊急地震速報" },
    { href: "/about", label: "出典・状況" },
  ];
  const current = (href: string) =>
    href === "/"
      ? page.url.pathname === "/" || page.url.pathname.startsWith("/quakes")
      : page.url.pathname.startsWith(href);

  // テーマは 暗い → 明るい → 端末に合わせる の順に替える (既定は暗い。denpa と同じ)
  const MODES: ThemeMode[] = ["dark", "light", "system"];
  const MODE_LABEL: Record<ThemeMode, string> = {
    dark: "暗い",
    light: "明るい",
    system: "端末に合わせる",
  };
  let mode = $state<ThemeMode>("dark");
  $effect(() => {
    const m = document.documentElement.dataset.themeMode;
    if (m === "light" || m === "system" || m === "dark") mode = m;
  });
  function nextTheme() {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length] ?? "dark";
    applyTheme(mode);
  }
</script>

<svelte:head>
  <title>sonae</title>
  <meta name="description" content="地震・津波の情報" />
</svelte:head>

<div class="site">
  <div class="top">
    {#if eews.length > 0}
      <div class="alerts">
        {#each eews as eew (eew.eventId)}
          <EewBanner {eew} />
        {/each}
      </div>
    {/if}
    <header class="bar">
      <nav class="page inner" aria-label="画面">
        <a class="logo" href="/">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="currentColor" />
            <path
              d="M4 17h5l3-7 4 13 3-9 2 3h7"
              fill="none"
              stroke="#fff"
              stroke-width="2.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          sonae
        </a>
        <ul class="links">
          {#each NAV as item (item.href)}
            <li>
              <a
                href={item.href}
                aria-current={current(item.href) ? "page" : undefined}
                >{item.label}</a
              >
            </li>
          {/each}
        </ul>
        <div class="end cluster">
          {#if browser && (!live.connected || down.length > 0)}
            <a class="tag error" href="/about#status">
              {!live.connected
                ? "配信につながっていません"
                : `受信に問題: ${down.join("・")}`}
            </a>
          {/if}
          {#if data.user && data.user.subject !== "dev"}
            <form method="POST" action="/auth/logout" class="logout">
              <span class="tiny muted">{data.user.name}</span>
              <button type="submit" class="link tiny">ログアウト</button>
            </form>
          {/if}
          <button
            type="button"
            class="theme"
            onclick={nextTheme}
            title="テーマ: {MODE_LABEL[mode]} (押すと替わる)"
            aria-label="テーマを替える (いまは{MODE_LABEL[mode]})"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {#if mode === "dark"}
                <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
              {:else if mode === "light"}
                <circle cx="12" cy="12" r="4.5" />
                <path
                  d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"
                />
              {:else}
                <rect x="3" y="4" width="18" height="12" rx="2" />
                <path d="M8 20h8M12 16v4" />
              {/if}
            </svg>
          </button>
        </div>
      </nav>
    </header>
  </div>
  <main class="page grow">
    {@render children()}
  </main>
  <footer class="foot">
    <div class="page stack">
      <p class="small">{NOTICE}</p>
      <ul class="tiny muted credits">
        {#each CREDITS as c (c)}
          <li>{c}</li>
        {/each}
      </ul>
      <p class="tiny"><a href="/about">出典と注意</a></p>
    </div>
  </footer>
</div>

<style>
  .site {
    display: flex;
    min-height: 100vh;
    flex-direction: column;
  }
  .top {
    position: sticky;
    top: 0;
    z-index: var(--so-z-header);
  }
  /* 操作の層の面 (denpa の浮いたヘッダーと同じ半透明の面と影) */
  .bar {
    background: var(--so-float);
    box-shadow: var(--so-shadow-pop);
  }
  .inner {
    display: flex;
    min-height: 3.25rem;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--so-space-1) var(--so-space-4);
  }
  .logo {
    display: flex;
    align-items: center;
    gap: var(--so-space-2);
    color: var(--pico-primary);
    font-size: var(--so-text-lg);
    font-weight: var(--so-weight-bold);
    text-decoration: none;
  }
  .logo svg {
    width: 1.6rem;
    height: 1.6rem;
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--so-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .links li {
    margin: 0;
    list-style: none;
  }
  .links a {
    display: inline-block;
    border-radius: var(--so-radius-full);
    padding: var(--so-space-1) var(--so-space-3);
    color: var(--so-fg);
    font-size: var(--so-text-sm);
    text-decoration: none;
  }
  .links a:hover {
    background: var(--so-hover-soft);
  }
  /* いまいる所は主の色の字と短い下線 (denpa の「選んでいる印」) */
  .links a[aria-current="page"] {
    color: var(--so-primary-text);
    font-weight: var(--so-weight-bold);
    box-shadow: inset 0 calc(-1 * var(--so-mark)) 0 var(--pico-primary);
  }
  .end {
    margin-left: auto;
  }
  .end .tag {
    text-decoration: none;
  }
  .logout {
    display: flex;
    align-items: center;
    gap: var(--so-space-2);
    margin: 0;
  }
  .link {
    min-height: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--so-primary-text);
    text-decoration: underline;
  }
  .theme {
    display: inline-grid;
    width: 2.25rem;
    height: 2.25rem;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: var(--so-radius-full);
    background: transparent;
    color: var(--so-fg);
  }
  .theme:hover {
    background: var(--so-hover-soft);
  }
  .theme svg {
    width: 1.25rem;
    height: 1.25rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
  }
  main {
    padding-block: var(--so-space-5) var(--so-space-6);
  }
  .foot {
    border-top: 1px solid var(--so-line);
    background: var(--so-surface);
  }
  .foot .page {
    padding-block: var(--so-space-5);
  }
  .credits {
    margin: 0;
    padding-left: 1.1rem;
  }
</style>
