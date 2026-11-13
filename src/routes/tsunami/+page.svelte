<script lang="ts">
  import TsunamiSummary from "#lib/components/TsunamiSummary.svelte";
  import { jst } from "#lib/format.ts";
  import { live } from "#lib/live.svelte.ts";
  import { isTsunamiActive } from "#lib/model.ts";

  let { data } = $props();
  const view = $derived(live.view(data.snapshot));
  const active = $derived(
    view.tsunamis.filter((t) => isTsunamiActive(t, live.now)),
  );
  const past = $derived(
    view.tsunamis.filter((t) => !isTsunamiActive(t, live.now)),
  );
</script>

<svelte:head>
  <title>津波 - sonae</title>
</svelte:head>

<div class="stack">
  <h1>津波</h1>
  {#if active.length === 0}
    <p class="panel">いま、津波の警報・注意報・予報は受けていません。</p>
  {/if}
  {#each active as t (t.id)}
    <TsunamiSummary tsunami={t} />
  {/each}

  {#if past.length > 0}
    <section>
      <h2>これまでの津波の情報</h2>
      <ul class="small">
        {#each past as t (t.id)}
          <li>
            <a href="/tsunami/{encodeURIComponent(t.id)}"
              >{jst(t.issuedAt)} 発表</a
            >
            {t.cancelled ? "(取消)" : t.ended ? "(解除)" : "(終わった津波予報)"}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>
