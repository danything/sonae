<script lang="ts">
  import Intensity from "#lib/components/Intensity.svelte";
  import { depthText, jst, jstFull, magnitudeText } from "#lib/format.ts";
  import { live } from "#lib/live.svelte.ts";
  import {
    type AreaIntensity,
    INTENSITIES,
    intensityRank,
    type ObservedIntensity,
    type StationIntensity,
    UNRECEIVED,
  } from "#lib/model.ts";

  let { data } = $props();
  // SSE で続報が来たら差し替える
  const q = $derived(
    live.quakes.find((x) => x.id === data.quake.id) ?? data.quake,
  );

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
</script>

<svelte:head>
  <title>{q.hypocenter?.name ?? "地震"} {jst(q.originTime)} - sonae</title>
</svelte:head>

<article class="stack">
  <p class="small"><a href="/">← 地震の一覧</a></p>
  <header class="head">
    <Intensity int={q.maxInt} size="lg" />
    <div>
      <h1>{q.hypocenter?.name ?? "震源は調査中"}</h1>
      <p class="muted">
        {jstFull(q.originTime)} 頃 発生・{magnitudeText(q)}・深さ {depthText(
          q.hypocenter,
        )}
      </p>
      <p class="tags">
        {#if q.status !== "normal"}<span class="tag"
            >{q.status === "training" ? "訓練" : "試験"}</span
          >{/if}
        {#if q.cancelled}<span class="tag">取り消されました</span>{/if}
        {#if q.provisional}<span class="tag"
            >P2P地震情報の速報 (気象庁の XML はまだ)</span
          >{/if}
        {#if q.foreign}<span class="tag">遠地地震</span>{/if}
      </p>
    </div>
  </header>

  {#if q.comments.length > 0}
    <section class="panel">
      {#each q.comments as c (c)}
        <p class="small">{c}</p>
      {/each}
    </section>
  {/if}

  {#if areas.length > 0}
    <section class="panel">
      <h2>各地域の震度</h2>
      <dl class="ints">
        {#each areas as g (g.int)}
          <dt><Intensity int={g.int} size="sm" /></dt>
          <dd class="small">{g.items.map((a) => a.name).join("・")}</dd>
        {/each}
      </dl>
    </section>
  {/if}

  {#if stations.length > 0}
    <section class="panel">
      <details>
        <summary><h2>観測点の震度 ({q.stations.length} 点)</h2></summary>
        <dl class="ints">
          {#each stations as g (g.int)}
            <dt><Intensity int={g.int} size="sm" /></dt>
            <dd class="small">{g.items.map((s) => s.name).join("・")}</dd>
          {/each}
        </dl>
      </details>
    </section>
  {/if}

  <section class="panel">
    <h2>発表された情報</h2>
    <ol class="reports small">
      {#each q.reports.toReversed() as r (`${r.source}-${r.code}-${r.reportedAt}-${r.infoType}`)}
        <li class:gone={r.cancelled}>
          {jst(r.reportedAt)}・{KIND[r.kind] ?? r.kind}{r.infoType === "発表"
            ? ""
            : ` (${r.infoType})`}
          <span class="muted"
            >— {r.source === "jma" ? "気象庁 XML" : "P2P地震情報"}</span
          >
          {#if r.cancelled}<span class="tag">取消済み</span>{/if}
        </li>
      {/each}
    </ol>
  </section>
</article>

<style>
  .head {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.3rem;
  }
  .ints {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: baseline;
    gap: 0.5rem 0.75rem;
    margin: 0.75rem 0 0;
  }
  .ints dt,
  .ints dd {
    margin: 0;
  }
  summary h2 {
    display: inline;
  }
  .reports {
    margin: 0.5rem 0 0;
    padding-left: 1.2rem;
  }
  .gone {
    text-decoration: line-through;
    opacity: 0.7;
  }
</style>
