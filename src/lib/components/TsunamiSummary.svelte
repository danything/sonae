<script lang="ts">
  import TriangleAlert from "~icons/lucide/triangle-alert";

  import { jst } from "#lib/format.ts";
  import {
    type Tsunami,
    TSUNAMI_ORDER,
    type TsunamiGrade,
    tsunamiGradeLabel,
  } from "#lib/model.ts";

  import Grade from "./Grade.svelte";
  import Icon from "./Icon.svelte";

  /**
   * いま出ている津波の警報・注意報・予報。一覧の上にページの中の通知の形 (淡い面・先頭に ⚠) で出す。
   * 区分ごとに予報区の名前を並べる (色だけに頼らず、区分の名前も出す)。`href` があれば押すとその津波を選ぶ
   */
  let { tsunami, href }: { tsunami: Tsunami; href?: string } = $props();
  const groups = $derived(
    TSUNAMI_ORDER.filter((g) => g !== "none")
      .map((g) => ({
        grade: g,
        areas: tsunami.areas.filter((a) => a.grade === g),
      }))
      .filter((x) => x.areas.length > 0),
  );
  const top = $derived<TsunamiGrade>(groups[0]?.grade ?? "none");
  const title = $derived(
    tsunami.cancelled
      ? "津波の情報は取り消されました"
      : tsunami.ended
        ? "津波の警報・注意報・予報は解除されました"
        : `${tsunamiGradeLabel(top)}${top === "major" || top === "warning" ? "。ただちに避難してください" : ""}`,
  );
</script>

<svelte:element
  this={href ? "a" : "section"}
  class="notice warning tsunami"
  {href}
  aria-label="津波"
>
  <Icon icon={TriangleAlert} />
  <div class="body">
    <p class="bold">{title}</p>
    <p class="small muted">
      {jst(tsunami.issuedAt)} 発表{tsunami.provisional
        ? "・P2P地震情報の速報 (気象庁の XML はまだ)"
        : ""}
    </p>
    {#each groups as g (g.grade)}
      <p class="group small">
        <Grade grade={g.grade} />
        <span>{g.areas.map((a) => a.name).join("、")}</span>
      </p>
    {/each}
  </div>
</svelte:element>

<style>
  .tsunami {
    color: inherit;
    text-decoration: none;
  }
  a.tsunami:hover {
    background: var(--so-item-hover);
  }
  .body {
    display: grid;
    gap: var(--so-space-1);
    min-width: 0;
  }
  .group {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--so-space-1) var(--so-space-2);
  }
</style>
