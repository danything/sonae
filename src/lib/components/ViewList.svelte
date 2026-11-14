<script lang="ts">
  import { type LayerId, LAYERS, type LayerState } from "#lib/map/style.ts";

  /**
   * **表示の切り替え** (地図に重ねる層と、緊急地震速報の訓練・試験)。オン/オフは右のスイッチ (`.s-switch`)。
   * 広い形のヘッダーの「状態と表示」と、スマホの形の dock の「⋯」のメニューに同じ中身を出す (denpa の `ViewList`)。
   * 層の説明 (震源の色の意味など) は、指の端末でも読めるよう `title` ではなく名前の下に控えた字で出す
   */
  let {
    layers,
    toggle,
    training,
    trainingHref,
  }: {
    layers: LayerState;
    toggle: (id: LayerId) => void;
    training: boolean;
    /** 訓練・試験の出し入れは URL で切り替えるのでリンク */
    trainingHref: string;
  } = $props();
  const item = "menu-item view-item";
  const role = "menuitemcheckbox";
</script>

{#snippet toggleBody(label: string, on: boolean, note?: string)}
  <span class="view-label"
    >{label}{#if note}<span class="view-note">{note}</span>{/if}</span
  >
  <span class="s-switch" class:on aria-hidden="true"></span>
{/snippet}

{#each LAYERS as l (l.id)}
  <button
    type="button"
    {role}
    class={item}
    aria-checked={layers[l.id]}
    onclick={() => toggle(l.id)}
    data-keep-open
    data-layer={l.id}
  >
    {@render toggleBody(l.label, layers[l.id], l.note)}
  </button>
{/each}
<a {role} class={item} aria-checked={training} href={trainingHref}>
  {@render toggleBody("緊急地震速報の訓練・試験も表示", training)}
</a>

<style>
  .view-item {
    justify-content: space-between;
    gap: var(--so-space-4);
  }
  .view-label {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding-block: var(--so-space-1);
  }
  .view-note {
    color: var(--so-muted);
    font-size: var(--so-text-xs);
    font-weight: var(--so-weight);
    line-height: 1.4;
  }
  /* メニューは高さに収めようと縮めるので、説明の字が次の行に重ならないよう縮めない */
  .menu-item.view-item {
    flex-shrink: 0;
    min-height: 2.5rem;
  }
  @media (pointer: coarse) {
    .menu-item.view-item {
      min-height: 3rem;
    }
  }
</style>
