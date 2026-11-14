<script lang="ts">
  import { jstFull, kindText } from "#lib/format.ts";
  import { type OfficeWarnings, WARNING_PHENOMENON } from "#lib/model.ts";

  import WarningLevel from "../WarningLevel.svelte";

  /**
   * 1 つの府県予報区に、いま出ている気象警報・注意報。種類ごとに対象の市町村等を並べ、
   * 現象ごとの見出しは電文の文のまま出す (警報を自分で作らない。docs/design.md の 5 章)
   */
  let { o }: { o: OfficeWarnings } = $props();
</script>

<div class="detail stack">
  <header>
    <h1 id="detail-title">{o.office.name}の警報・注意報</h1>
    <p class="small muted">{jstFull(o.reportedAt)} 更新</p>
  </header>

  <section>
    <h2>出ている警報・注意報</h2>
    <ul class="plain small stack">
      {#each o.kinds as k (`${k.code}-${k.name}`)}
        <li class="kind">
          <WarningLevel level={k.level} label={kindText(k.name)} />
          <span class="muted">{k.areas.map((a) => a.name).join("、")}</span>
        </li>
      {/each}
    </ul>
  </section>

  {#each o.headlines as h (h.code)}
    <section>
      <h2>{WARNING_PHENOMENON[h.code]}</h2>
      <p class="small muted">{jstFull(h.reportedAt)} 発表</p>
      <p class="small text">{h.text}</p>
    </section>
  {/each}
</div>

<style>
  .text {
    white-space: pre-line;
  }
  .plain {
    margin: var(--so-space-2) 0 0;
    padding: 0;
    list-style: none;
  }
  .kind {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--so-space-1);
  }
</style>
