<script lang="ts">
  import { VOLCANO_COLORS } from "#lib/format.ts";

  /**
   * 火山の警戒の段のラベル。気象庁の配色の指針 (表 1-2) の噴火警報・予報の色で塗り、字でも書く
   * (震度のラベル `Intensity`・津波の区分 `Grade` と同じ扱い。docs/design.md の 6 章)。
   * 噴火速報は段が無いので、いちばん重い色で「噴火速報」と書く
   */
  let { level, label }: { level: number | undefined; label: string } = $props();
  const c = $derived(level ? VOLCANO_COLORS[level] : undefined);
</script>

<span
  class="volcano-level"
  style:background={c?.bg ?? "rgb(200 200 203)"}
  style:color={c?.fg ?? "#000"}>{label}</span
>

<style>
  .volcano-level {
    border-radius: var(--so-radius-sm);
    padding: 0 var(--so-space-2);
    font-size: var(--so-text-xs);
    font-weight: var(--so-weight-bold);
    line-height: 1.75;
    white-space: nowrap;
  }
</style>
