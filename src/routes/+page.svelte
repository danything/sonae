<script lang="ts">
  import { NOTICE } from "#lib/notice.ts";
</script>

<svelte:head>
  <title>sonae</title>
</svelte:head>

<main>
  <h1>sonae</h1>
  <p>
    地震・津波の情報を家で受けて、見て、知らせるアプリです。まだ作っている途中です。
  </p>
  <p class="notice">{NOTICE}</p>
</main>

<style>
  main {
    max-inline-size: 40rem;
    margin-inline: auto;
    padding: 2rem 1rem;
    font-family: system-ui, sans-serif;
    line-height: 1.7;
    word-break: auto-phrase;
  }
  .notice {
    font-size: 0.875rem;
    opacity: 0.8;
  }
</style>
