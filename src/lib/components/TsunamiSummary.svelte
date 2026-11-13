<script lang="ts">
  import { jst, TSUNAMI_COLORS } from "#lib/format.ts";
  import {
    type Tsunami,
    TSUNAMI_ORDER,
    type TsunamiGrade,
    tsunamiGradeLabel,
  } from "#lib/model.ts";

  /** 津波の区分ごとに、予報区の名前を並べる (色だけに頼らず、区分の名前も出す) */
  let { tsunami, link = true }: { tsunami: Tsunami; link?: boolean } = $props();
  const groups = $derived(
    TSUNAMI_ORDER.filter((g) => g !== "none")
      .map((g) => ({
        grade: g,
        areas: tsunami.areas.filter((a) => a.grade === g),
      }))
      .filter((x) => x.areas.length > 0),
  );
  const top = $derived<TsunamiGrade>(groups[0]?.grade ?? "none");
</script>

<section
  class="tsunami panel"
  style:--edge={TSUNAMI_COLORS[top]?.bg}
  aria-label="津波"
>
  <h2>
    {#if tsunami.cancelled}
      津波の情報は取り消されました
    {:else if tsunami.ended}
      津波の警報・注意報・予報は解除されました
    {:else}
      {tsunamiGradeLabel(top)}{top === "major" || top === "warning"
        ? "　ただちに避難を"
        : ""}
    {/if}
  </h2>
  <p class="tiny muted">
    {jst(tsunami.issuedAt)} 発表{tsunami.provisional
      ? "・P2P地震情報の速報 (気象庁の XML はまだ)"
      : ""}
  </p>
  {#if tsunami.headline}
    <p class="small headline">{tsunami.headline}</p>
  {/if}
  {#each groups as g (g.grade)}
    <div class="group">
      <span
        class="grade"
        style:background={TSUNAMI_COLORS[g.grade]?.bg}
        style:color={TSUNAMI_COLORS[g.grade]?.fg}
        >{tsunamiGradeLabel(g.grade)}</span
      >
      <span class="small">{g.areas.map((a) => a.name).join("・")}</span>
    </div>
  {/each}
  {#if link}
    <p class="small">
      <a href="/tsunami/{encodeURIComponent(tsunami.id)}">詳しく見る</a>
    </p>
  {/if}
</section>

<style>
  .tsunami {
    display: grid;
    gap: 0.4rem;
    border-left: 0.5rem solid var(--edge, var(--so-line));
  }
  .headline {
    white-space: pre-line;
  }
  .group {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.6rem;
  }
  .grade {
    border-radius: 0.35rem;
    padding: 0 0.45rem;
    font-size: 0.8rem;
    font-weight: 700;
    white-space: nowrap;
  }
</style>
