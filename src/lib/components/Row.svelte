<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * **一覧の 1 行** (denpa のホームの行と同じ形)。件の面に乗せた幅いっぱいの 2 段。
   *
   * - 左に震度の札か津波の区分 (`lead`)
   * - 1 段目: 時刻 (控えた字)・タイトル (本文)、右に状態のバッジ (`tags`。取消・速報のような状態だけ)
   * - 2 段目: 控えた字の補足 (M・深さ・地域)。1 行で「…」と切る
   *
   * 押すとその件を選ぶ (URL の query が替わる)。選んでいる件は左の縦線と太字で、面は塗り替えない
   */
  let {
    href,
    current = false,
    time,
    title,
    meta,
    lead,
    tags,
  }: {
    href: string;
    current?: boolean;
    time: string;
    title: string;
    meta: string;
    lead?: Snippet;
    tags?: Snippet;
  } = $props();
</script>

<a
  class="row item"
  {href}
  aria-current={current ? "true" : undefined}
  data-testid="row"
>
  {#if lead}<span class="lead">{@render lead()}</span>{/if}
  <span class="row-body">
    <span class="title-line">
      <span class="t-time num">{time}</span>
      <span class="row-name">{title}</span>
    </span>
    <span class="row-meta">{meta}</span>
  </span>
  {#if tags}<span class="tags">{@render tags()}</span>{/if}
</a>

<style>
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--so-space-1) var(--so-space-3);
    min-height: var(--so-item-h);
    padding: var(--so-space-2) var(--so-space-3);
    color: inherit;
    text-decoration: none;
  }
  /* 件いっぱいを押せる行の焦点の線は内側に引く */
  .row:focus-visible {
    outline-offset: -2px;
  }
  .row[aria-current="true"] .row-name {
    color: var(--so-primary-text);
    font-weight: var(--so-weight-bold);
  }
  .row[aria-current="true"]::before {
    content: "";
    position: absolute;
    inset-block: 0.75rem;
    left: 0;
    width: var(--so-mark);
    border-radius: var(--so-mark);
    background: var(--pico-primary);
  }
  .lead {
    display: flex;
    flex-shrink: 0;
  }
  .row-body {
    display: flex;
    flex: 1 1 0%;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }
  .title-line {
    display: flex;
    align-items: baseline;
    gap: var(--so-space-2);
    min-width: 0;
  }
  .t-time {
    flex-shrink: 0;
    color: var(--so-muted);
    font-size: var(--so-text-sm);
    white-space: nowrap;
  }
  .row-name,
  .row-meta {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-meta {
    color: var(--so-muted);
    font-size: var(--so-text-sm);
  }
  .tags {
    display: flex;
    flex-shrink: 0;
    flex-wrap: wrap;
    gap: var(--so-space-1);
  }
</style>
