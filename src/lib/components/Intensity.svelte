<script lang="ts">
  import { INTENSITY_COLORS } from "#lib/format.ts";
  import { intensityLabel, type ObservedIntensity } from "#lib/model.ts";

  /** 震度のラベル。色だけに頼らず「5弱」と字でも出す */
  let {
    int,
    size = "md",
  }: { int: ObservedIntensity | undefined; size?: "sm" | "md" | "lg" } =
    $props();
  const c = $derived(int ? INTENSITY_COLORS[int] : undefined);
</script>

{#if int && c}
  <span
    class="int {size}"
    style:background={c.bg}
    style:color={c.fg}
    title="震度{intensityLabel(int)}"
  >
    <span class="visually-hidden">震度</span>{intensityLabel(int)}
  </span>
{:else}
  <span class="int none {size}" title="震度の情報なし">—</span>
{/if}

<style>
  .int {
    display: inline-flex;
    min-width: 2.6em;
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
  .lg {
    min-width: 3.2em;
    font-size: var(--so-text-xl);
  }
  .none {
    color: var(--so-muted);
  }
</style>
