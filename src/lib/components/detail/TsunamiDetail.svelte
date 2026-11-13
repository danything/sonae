<script lang="ts">
  import "@anyblades/blades/content/table";

  import { jst } from "#lib/format.ts";
  import { isTsunamiActive, type Tsunami, TSUNAMI_ORDER } from "#lib/model.ts";

  import Grade from "../Grade.svelte";
  import TsunamiSummary from "../TsunamiSummary.svelte";

  /** 津波の詳しい内容。予報区ごとの表と、沿岸・沖合の観測 */
  let { t, now }: { t: Tsunami; now: number } = $props();
  const areas = $derived(
    [...t.areas].sort(
      (a, b) => TSUNAMI_ORDER.indexOf(a.grade) - TSUNAMI_ORDER.indexOf(b.grade),
    ),
  );
  const coast = $derived(t.observations.filter((o) => !o.offshore));
  const offshore = $derived(t.observations.filter((o) => o.offshore));
</script>

<div class="detail stack">
  <h1 id="detail-title">津波 {jst(t.issuedAt)} 発表</h1>
  {#if isTsunamiActive(t, now) || t.cancelled || t.ended}
    <TsunamiSummary tsunami={t} />
  {:else}
    <p class="small muted">この津波予報は終わりました。</p>
  {/if}
  {#if t.headline}
    <p class="small headline">{t.headline}</p>
  {/if}

  {#if areas.length > 0}
    <section>
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
                <Grade
                  grade={a.grade}
                  label={a.grade === "none" ? a.kindName : undefined}
                />
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
      <section>
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
</div>

<style>
  .headline {
    white-space: pre-line;
  }
  table {
    margin-top: var(--so-space-2);
  }
  td,
  th {
    padding-inline: var(--so-space-2);
  }
</style>
