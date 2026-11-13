<script lang="ts">
  import { TSUNAMI_COLORS } from "#lib/format.ts";
  import { type TsunamiGrade, tsunamiGradeLabel } from "#lib/model.ts";

  /**
   * 津波の区分の札。気象庁の「津波の色」で塗り、区分の名前を字でも出す (震度の札 `Intensity` と同じ扱い。docs/design.md の 6 章)
   */
  let { grade, label }: { grade: TsunamiGrade; label?: string } = $props();
  const c = $derived(TSUNAMI_COLORS[grade]);
</script>

<span class="grade" style:background={c?.bg} style:color={c?.fg}
  >{label ?? tsunamiGradeLabel(grade)}</span
>

<style>
  .grade {
    border-radius: var(--so-radius-sm);
    padding: 0 var(--so-space-2);
    font-size: var(--so-text-xs);
    font-weight: var(--so-weight-bold);
    line-height: 1.75;
    white-space: nowrap;
  }
</style>
