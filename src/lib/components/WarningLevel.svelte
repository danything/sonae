<script lang="ts">
  import { WARNING_COLORS } from "#lib/format.ts";
  import { type WarningLevel, warningLevelLabel } from "#lib/model.ts";

  /**
   * 気象警報・注意報の段のラベル。配色の指針の表 1-1 の色で塗り、段の名前を字でも出す
   * (震度・津波のラベルと同じ扱い。docs/design.md の 6 章)
   */
  let {
    level,
    label,
    size = "md",
  }: { level: WarningLevel; label?: string; size?: "sm" | "md" } = $props();
  const c = $derived(WARNING_COLORS[level]);
</script>

<span
  class="level"
  class:sm={size === "sm"}
  style:background={c?.bg}
  style:color={c?.fg}>{label ?? warningLevelLabel(level)}</span
>

<style>
  .level {
    border-radius: var(--so-radius-sm);
    padding: 0 var(--so-space-2);
    font-size: var(--so-text-xs);
    font-weight: var(--so-weight-bold);
    line-height: 1.75;
    white-space: nowrap;
  }
  .sm {
    padding: 0 var(--so-space-1);
  }
</style>
