<script lang="ts">
  import "@anyblades/blades/content/table";

  import TsunamiSummary from "#lib/components/TsunamiSummary.svelte";
  import { jst, TSUNAMI_COLORS } from "#lib/format.ts";
  import { live } from "#lib/live.svelte.ts";
  import { TSUNAMI_ORDER, tsunamiGradeLabel } from "#lib/model.ts";

  let { data } = $props();
  const t = $derived(
    live.tsunamis.find((x) => x.id === data.tsunami.id) ?? data.tsunami,
  );
  const areas = $derived(
    [...t.areas].sort(
      (a, b) => TSUNAMI_ORDER.indexOf(a.grade) - TSUNAMI_ORDER.indexOf(b.grade),
    ),
  );
  const coast = $derived(t.observations.filter((o) => !o.offshore));
  const offshore = $derived(t.observations.filter((o) => o.offshore));
</script>

<svelte:head>
  <title>津波 {jst(t.issuedAt)} - sonae</title>
</svelte:head>

<article class="stack">
  <p class="small"><a href="/tsunami">← 津波</a></p>
  <TsunamiSummary tsunami={t} link={false} />

  {#if areas.length > 0}
    <section class="panel">
      <h2>津波予報区ごと</h2>
      <table class="small">
        <thead>
          <tr
            ><th>予報区</th><th>区分</th><th>第 1 波</th><th>予想の高さ</th></tr
          >
        </thead>
        <tbody>
          {#each areas as a (a.name)}
            <tr>
              <td>{a.name}</td>
              <td>
                <span
                  class="grade"
                  style:background={TSUNAMI_COLORS[a.grade]?.bg}
                  style:color={TSUNAMI_COLORS[a.grade]?.fg}
                  >{a.grade === "none"
                    ? a.kindName
                    : tsunamiGradeLabel(a.grade)}</span
                >
              </td>
              <td
                >{a.condition ??
                  (a.arrivalTime ? `${jst(a.arrivalTime)} 頃` : "—")}</td
              >
              <td>{a.maxHeightText ?? "—"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}

  {#each [{ title: "沿岸の観測", list: coast }, { title: "沖合の観測", list: offshore }] as part (part.title)}
    {#if part.list.length > 0}
      <section class="panel">
        <h2>{part.title}</h2>
        <table class="small">
          <thead>
            <tr><th>観測点</th><th>第 1 波</th><th>これまでの最大波</th></tr>
          </thead>
          <tbody>
            {#each part.list as o (o.station)}
              <tr>
                <td>{o.station}{o.area ? ` (${o.area})` : ""}</td>
                <td
                  >{o.arrivalTime ? jst(o.arrivalTime) : "—"}
                  {o.initial ?? ""}</td
                >
                <td>{o.maxHeightText ?? o.condition ?? "—"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}
  {/each}
</article>

<style>
  .grade {
    border-radius: 0.35rem;
    padding: 0 0.45rem;
    font-weight: 700;
    white-space: nowrap;
  }
  table {
    margin-top: 0.5rem;
  }
</style>
