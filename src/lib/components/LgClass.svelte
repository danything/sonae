<script lang="ts">
  import { LG_COLORS } from "#lib/format.ts";
  import { type LgClass, lgWords } from "#lib/model.ts";

  /** 長周期地震動階級のラベル。色だけに頼らず「階級3」と字でも出す (震度のラベルと同じ形) */
  let { lg, size = "md" }: { lg: LgClass; size?: "sm" | "md" } = $props();
  const c = $derived(LG_COLORS[lg]);
</script>

{#if c}
  <span
    class="lg {size}"
    style:background={c.bg}
    style:color={c.fg}
    title="長周期地震動階級{lg} ({lgWords(lg)})"
  >
    <span class="visually-hidden">長周期地震動</span>階級{lg}
  </span>
{:else}
  <span class="lg none {size}" title={lgWords(lg)}>階級1未満</span>
{/if}

<style>
  .lg {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgb(0 0 0 / 0.15);
    border-radius: var(--so-radius-sm);
    padding: 0 0.35em;
    font-weight: var(--so-weight-bold);
    line-height: 1.7;
    white-space: nowrap;
  }
  .sm {
    font-size: var(--so-text-xs);
  }
  .none {
    color: var(--so-muted);
  }
</style>
