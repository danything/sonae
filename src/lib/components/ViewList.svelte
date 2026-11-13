<script lang="ts">
  import { type LayerId, LAYERS, type LayerState } from "#lib/map/style.ts";

  /**
   * **表示の切り替え** (地図に重ねる層と、緊急地震速報の訓練・試験)。オン/オフは右のスイッチ (`.s-switch`)。
   * サイドバーの並び (`list`) と、dock の「⋯」の中 (`menu`) で同じ中身。形と読み上げの役割だけが変わる (denpa の `ViewList`)
   */
  let {
    layers,
    toggle,
    training,
    trainingHref,
    variant = "list",
  }: {
    layers: LayerState;
    toggle: (id: LayerId) => void;
    training: boolean;
    /** 訓練・試験の出し入れは URL で切り替えるのでリンク */
    trainingHref: string;
    variant?: "list" | "menu";
  } = $props();
  const item = $derived(
    variant === "menu" ? "menu-item view-item" : "side-item view-item",
  );
  const role = $derived(variant === "menu" ? "menuitemcheckbox" : "switch");
</script>

{#snippet toggleBody(label: string, on: boolean)}
  <span>{label}</span>
  <span class="s-switch" class:on aria-hidden="true"></span>
{/snippet}

{#each LAYERS as l (l.id)}
  <button
    type="button"
    {role}
    class={item}
    aria-checked={layers[l.id]}
    title={l.note}
    onclick={() => toggle(l.id)}
    data-keep-open
    data-layer={l.id}
  >
    {@render toggleBody(l.label, layers[l.id])}
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
  .menu-item.view-item {
    min-height: 2.5rem;
  }
  @media (pointer: coarse) {
    .menu-item.view-item {
      min-height: 3rem;
    }
  }
</style>
