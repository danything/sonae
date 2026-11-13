<script lang="ts">
  import { page } from "$app/state";

  import Intensity from "#lib/components/Intensity.svelte";
  import QuakeMap from "#lib/components/QuakeMap.svelte";
  import { activeEews } from "#lib/eew.ts";
  import { depthText, jst, magnitudeText } from "#lib/format.ts";
  import { live } from "#lib/live.svelte.ts";
  import { LAYERS, type LayerState, readLayers } from "#lib/map/style.ts";
  import { isTsunamiActive } from "#lib/model.ts";
  import { readPref, writePref } from "#lib/prefs.ts";

  let { data } = $props();
  const view = $derived(live.view(data.snapshot));
  // ?quake= で選んだ地震。無ければいちばん新しい地震
  const quake = $derived(
    view.quakes.find((q) => q.id === page.url.searchParams.get("quake")) ??
      view.quakes[0],
  );
  const tsunamis = $derived(
    view.tsunamis.filter((t) => isTsunamiActive(t, live.now)),
  );
  const eews = $derived(activeEews(view.eews, live.now));

  // 層のオン・オフは端末に覚えさせる
  let layers = $state<LayerState>(readLayers(null));
  $effect.pre(() => {
    layers = readLayers(readPref("map.layers"));
  });
  function toggle(id: keyof LayerState) {
    layers[id] = !layers[id];
    writePref("map.layers", JSON.stringify(layers));
  }
</script>

<svelte:head>
  <title>地図 - sonae</title>
</svelte:head>

<div class="wrap">
  <div class="mapbox">
    <QuakeMap {quake} quakes={view.quakes} {tsunamis} {eews} {layers} />
  </div>
  <aside class="side stack">
    <section class="panel stack">
      <h2 class="small muted">重ねる情報</h2>
      <div class="chips">
        {#each LAYERS as l (l.id)}
          <label class="chip" title={l.note}>
            <input
              type="checkbox"
              checked={layers[l.id]}
              onchange={() => toggle(l.id)}
            />
            {l.label}
          </label>
        {/each}
      </div>
      <p class="tiny muted">
        下地は国土地理院のシームレス空中写真。出典は地図の右下の (i) と<a
          href="/about">出典と注意</a
        >。
      </p>
    </section>
    {#if quake}
      <a class="item quake" href="/quakes/{encodeURIComponent(quake.id)}">
        <Intensity int={quake.maxInt} />
        <span class="grow">
          <span class="bold">{quake.hypocenter?.name ?? "震源は調査中"}</span>
          <span class="tiny muted"
            >{jst(quake.originTime)} 頃・{magnitudeText(quake)}・深さ {depthText(
              quake.hypocenter,
            )}</span
          >
        </span>
      </a>
    {/if}
    <section class="panel">
      <h2 class="small muted">ほかの地震</h2>
      <ul class="item-list small others">
        {#each view.quakes.slice(0, 12) as q (q.id)}
          <li>
            <a
              href="/map?quake={encodeURIComponent(q.id)}"
              aria-current={q.id === quake?.id ? "true" : undefined}
            >
              <Intensity int={q.maxInt} size="sm" />
              {jst(q.originTime)}
              {q.hypocenter?.name ?? ""}
            </a>
          </li>
        {/each}
      </ul>
    </section>
  </aside>
</div>

<style>
  .wrap {
    display: grid;
    gap: var(--so-space-3);
  }
  .mapbox {
    height: min(70vh, 40rem);
  }
  @media (width >= 56rem) {
    .wrap {
      grid-template-columns: 1fr 18rem;
    }
    .mapbox {
      height: calc(100vh - 9rem);
    }
  }
  .quake {
    display: flex;
    align-items: center;
    gap: var(--so-space-3);
    padding: var(--so-space-3);
  }
  .quake .grow {
    display: flex;
    flex-direction: column;
  }
  .others a {
    display: flex;
    align-items: center;
    gap: var(--so-space-2);
    border-radius: var(--so-radius);
    padding: var(--so-space-1) var(--so-space-2);
    color: var(--so-fg);
    text-decoration: none;
  }
  .others a:hover {
    background: var(--so-hover-soft);
  }
  .others a[aria-current] {
    color: var(--so-primary-text);
    font-weight: var(--so-weight-bold);
  }
  .others {
    margin-top: var(--so-space-2);
  }
</style>
