<script lang="ts">
  import { INTENSITY_COLORS } from "#lib/format.ts";
  import { intensityLabel, type ObservedIntensity } from "#lib/model.ts";

  /** 震度の札。色だけに頼らず「5弱」と字でも出す */
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
    border-radius: 0.4rem;
    padding: 0 0.35em;
    font-weight: 700;
    line-height: 1.7;
    white-space: nowrap;
  }
  .sm {
    font-size: 0.8rem;
  }
  .lg {
    min-width: 3.2em;
    font-size: 1.5rem;
  }
  .none {
    color: var(--so-muted);
  }
</style>
