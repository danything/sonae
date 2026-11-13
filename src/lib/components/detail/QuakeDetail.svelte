<script lang="ts">
  import "@anyblades/blades/components/accordion";

  import {
    depthText,
    jst,
    jstFull,
    magnitudeText,
    quakeName,
    SOURCE_LABEL,
    STATUS_LABEL,
  } from "#lib/format.ts";
  import {
    type AreaIntensity,
    INTENSITIES,
    intensityRank,
    type ObservedIntensity,
    type Quake,
    type StationIntensity,
    UNRECEIVED,
  } from "#lib/model.ts";

  import Intensity from "../Intensity.svelte";

  /**
   * 地震の詳しい内容。節は見出しと余白で分け、囲まない
   */
  let { q }: { q: Quake } = $props();

  /** 震度の大きい順に、地域 (または観測点) の名前を束ねる */
  function byIntensity<T extends AreaIntensity | StationIntensity>(items: T[]) {
    const order: ObservedIntensity[] = [...INTENSITIES].reverse();
    order.splice(order.indexOf("5-"), 0, UNRECEIVED);
    return order
      .map((int) => ({ int, items: items.filter((x) => x.int === int) }))
      .filter((g) => g.items.length > 0)
      .sort((a, b) => intensityRank(b.int) - intensityRank(a.int));
  }
  const areas = $derived(byIntensity(q.areas));
  const stations = $derived(byIntensity(q.stations));

  const KIND: Record<string, string> = {
    scale: "震度速報",
    hypocenter: "震源に関する情報",
    detail: "震源・震度に関する情報",
    update: "震源要素更新のお知らせ",
    foreign: "遠地地震に関する情報",
    other: "その他の情報",
  };
  /** 事実は控えた字を「・」でつなぐ (バッジにしない) */
  const facts = $derived(
    [
      `${jstFull(q.originTime)} 頃 発生`,
      magnitudeText(q),
      `深さ ${depthText(q.hypocenter)}`,
      q.foreign ? "遠地地震" : "",
      STATUS_LABEL[q.status],
    ].filter(Boolean),
  );
</script>

<div class="detail stack">
  <header class="head">
    <Intensity int={q.maxInt} size="lg" />
    <div class="grow">
      <h1 id="detail-title">{quakeName(q)}</h1>
      <p class="small muted">{facts.join("・")}</p>
      {#if q.cancelled || q.provisional}
        <p class="tags">
          {#if q.cancelled}<span class="tag error">取消</span>{/if}
          {#if q.provisional}<span class="tag info"
              >速報 (気象庁の XML はまだ)</span
            >{/if}
        </p>
      {/if}
    </div>
  </header>

  {#each q.comments as c (c)}
    <p class="small">{c}</p>
  {/each}

  {#if areas.length > 0}
    <section>
      <h2>各地域の震度</h2>
      <dl class="ints">
        {#each areas as g (g.int)}
          <dt><Intensity int={g.int} size="sm" /></dt>
          <dd class="small">{g.items.map((a) => a.name).join("、")}</dd>
        {/each}
      </dl>
    </section>
  {/if}

  {#if stations.length > 0}
    <details>
      <summary>観測点の震度 ({q.stations.length} 点)</summary>
      <dl class="ints">
        {#each stations as g (g.int)}
          <dt><Intensity int={g.int} size="sm" /></dt>
          <dd class="small">{g.items.map((s) => s.name).join("、")}</dd>
        {/each}
      </dl>
    </details>
  {/if}

  <section>
    <h2>発表された情報</h2>
    <ol class="reports small">
      {#each q.reports.toReversed() as r (`${r.source}-${r.code}-${r.reportedAt}-${r.infoType}`)}
        <li class:gone={r.cancelled}>
          {jst(r.reportedAt)}・{KIND[r.kind] ?? r.kind}{r.infoType === "発表"
            ? ""
            : ` (${r.infoType})`}
          <span class="muted">・{SOURCE_LABEL[r.source]}</span>
          {#if r.cancelled}<span class="tag">取消済み</span>{/if}
        </li>
      {/each}
    </ol>
  </section>
</div>

<style>
  .head {
    display: flex;
    align-items: flex-start;
    gap: var(--so-space-3);
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--so-space-1);
    margin-top: var(--so-space-1);
  }
  .ints {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: baseline;
    gap: var(--so-space-2) var(--so-space-3);
    margin: var(--so-space-2) 0 0;
  }
  .ints dt,
  .ints dd {
    margin: 0;
  }
  details {
    margin: 0;
    padding: 0;
    border: 0;
  }
  summary {
    font-weight: var(--so-weight-bold);
  }
  .reports {
    margin: var(--so-space-2) 0 0;
    padding-left: var(--so-space-5);
  }
  .gone {
    color: var(--so-muted);
    text-decoration: line-through;
  }
</style>
