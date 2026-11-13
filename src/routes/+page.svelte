<script lang="ts">
  import Intensity from "#lib/components/Intensity.svelte";
  import TsunamiSummary from "#lib/components/TsunamiSummary.svelte";
  import { depthText, jst, magnitudeText } from "#lib/format.ts";
  import { live } from "#lib/live.svelte.ts";
  import { isTsunamiActive, isUrgentAdvisory } from "#lib/model.ts";

  let { data } = $props();
  const view = $derived(live.view(data.snapshot));
  const activeTsunamis = $derived(
    view.tsunamis.filter((t) => isTsunamiActive(t, live.now)),
  );
  const WEEK = 7 * 24 * 60 * 60_000;
  const advisories = $derived(
    view.advisories.filter(
      (a) => !a.cancelled && Date.parse(a.reportedAt) > live.now - WEEK,
    ),
  );
</script>

<svelte:head>
  <title>地震の一覧 - sonae</title>
</svelte:head>

<div class="stack">
  {#each activeTsunamis as t (t.id)}
    <TsunamiSummary tsunami={t} />
  {/each}

  {#each advisories as a (a.id)}
    <section class="panel advisory" class:urgent={isUrgentAdvisory(a)}>
      <h2>{a.title}</h2>
      <p class="tiny muted">{jst(a.reportedAt)} 発表</p>
      <p class="small">{a.headline}</p>
    </section>
  {/each}

  <section>
    <h1>地震の一覧</h1>
    {#if view.quakes.length === 0}
      <p class="muted">まだ地震情報を受けていません。</p>
    {:else}
      <ol class="item-list quakes">
        {#each view.quakes as q (q.id)}
          <li>
            <a class="row item" href="/quakes/{encodeURIComponent(q.id)}">
              <Intensity int={q.maxInt} />
              <span class="what">
                <span class="where">
                  {q.hypocenter?.name ??
                    (q.areas[0] ? `${q.areas[0].name} など` : "震源は調査中")}
                </span>
                <span class="tiny muted">
                  {jst(q.originTime)} 頃・{magnitudeText(q)}・深さ {depthText(
                    q.hypocenter,
                  )}
                </span>
              </span>
              <span class="tags">
                {#if q.cancelled}<span class="tag error">取消</span>{/if}
                {#if q.provisional}<span
                    class="tag info"
                    title="気象庁の XML をまだ受けていません">速報</span
                  >{/if}
                {#if q.foreign}<span class="tag">遠地</span>{/if}
              </span>
            </a>
          </li>
        {/each}
      </ol>
    {/if}
  </section>
</div>

<style>
  .quakes {
    margin-top: var(--so-space-3);
  }
  .row {
    display: flex;
    min-height: var(--so-item-h);
    align-items: center;
    gap: var(--so-space-3);
    padding: var(--so-space-2) var(--so-space-3);
  }
  .what {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
  }
  .where {
    font-weight: var(--so-weight-bold);
  }
  .tags {
    display: flex;
    gap: var(--so-space-1);
  }
  .advisory.urgent {
    box-shadow:
      inset var(--so-space-1) 0 0 var(--so-rec),
      var(--so-item-shadow);
  }
</style>
